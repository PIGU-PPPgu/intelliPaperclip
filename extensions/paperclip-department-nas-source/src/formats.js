import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

export const supportedExtensions = new Set([".txt", ".md", ".pdf", ".docx", ".xlsx", ".pptx"]);
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 100000;

function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity) => {
    if (entity[0] === "#") {
      const radix = entity[1]?.toLowerCase() === "x" ? 16 : 10;
      const codePoint = Number.parseInt(entity.slice(radix === 16 ? 2 : 1), radix);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity.toLowerCase()] ?? "";
  });
}

function xmlText(xml, tag) {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  return Array.from(xml.matchAll(pattern), (match) => decodeEntities(match[1])).join("");
}

function attributes(tag) {
  return Object.fromEntries(Array.from(tag.matchAll(/([\w:.-]+)="([^"]*)"/g), (match) => [match[1], decodeEntities(match[2])]));
}

async function loadOfficeZip(content) {
  const zip = await JSZip.loadAsync(content, { checkCRC32: false });
  const entries = Object.values(zip.files);
  if (entries.length > 2000) throw new Error("Office archive contains too many entries");
  let total = 0;
  for (const entry of entries) {
    const size = entry._data?.uncompressedSize ?? 0;
    if (!Number.isFinite(size) || size < 0 || size > MAX_ZIP_BYTES) throw new Error("Office archive entry is too large");
    total += size;
  }
  if (total > MAX_ZIP_BYTES) throw new Error("Office archive expands beyond 64 MiB");
  return zip;
}

async function zipXml(zip, name) {
  const file = zip.file(name);
  if (!file) return null;
  if ((file._data?.uncompressedSize ?? 0) > MAX_XML_BYTES) throw new Error("Office XML part exceeds 8 MiB");
  const xml = await file.async("string");
  if (Buffer.byteLength(xml) > MAX_XML_BYTES) throw new Error("Office XML part exceeds 8 MiB");
  return xml;
}

async function docxSections(content) {
  const zip = await loadOfficeZip(content);
  const xml = await zipXml(zip, "word/document.xml");
  if (!xml) throw new Error("DOCX document.xml is missing");
  const lines = [];
  for (const match of xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    const paragraph = match[0];
    const text = xmlText(paragraph, "w:t").trim();
    if (!text) continue;
    const style = paragraph.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/);
    lines.push(style && /^Heading|^Title/i.test(style[1]) ? `# ${text}` : text);
    if (lines.join("\n").length >= MAX_EXTRACTED_CHARS) break;
  }
  return [{ label: "DOCX body, headings and table text", text: lines.join("\n").slice(0, MAX_EXTRACTED_CHARS) }];
}

function sharedStrings(xml) {
  if (!xml) return [];
  return Array.from(xml.matchAll(/<si\b[^>]*>[\s\S]*?<\/si>/g), (match) => xmlText(match[0], "t"));
}

function sheetRows(xml, strings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>[\s\S]*?<\/row>/g)) {
    if (rows.length >= 30) break;
    const row = [];
    for (const cellMatch of rowMatch[0].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = attributes(cellMatch[1]);
      const letters = attrs.r?.match(/^[A-Z]+/i)?.[0]?.toUpperCase();
      let index = letters ? [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1 : row.length;
      if (index < 0 || index >= 20) continue;
      const body = cellMatch[2] ?? "";
      let value = xmlText(body, "v") || xmlText(body, "t");
      if (attrs.t === "s") value = strings[Number(value)] ?? "";
      row[index] = value.replaceAll("\n", " ");
    }
    rows.push(row.slice(0, 20).map((value) => value ?? "").join("\t"));
  }
  return rows.join("\n");
}

async function xlsxSections(content) {
  const zip = await loadOfficeZip(content);
  const workbook = await zipXml(zip, "xl/workbook.xml");
  if (!workbook) throw new Error("XLSX workbook.xml is missing");
  const rels = await zipXml(zip, "xl/_rels/workbook.xml.rels");
  const relationshipTargets = new Map();
  for (const match of (rels ?? "").matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
    const attr = attributes(match[0]);
    if (attr.Id && attr.Target) relationshipTargets.set(attr.Id, attr.Target);
  }
  const strings = sharedStrings(await zipXml(zip, "xl/sharedStrings.xml"));
  const sections = [];
  for (const match of workbook.matchAll(/<sheet\b[^>]*\/?\s*>/g)) {
    if (sections.length >= 8) break;
    const attr = attributes(match[0]);
    const target = relationshipTargets.get(attr["r:id"]) ?? `worksheets/sheet${sections.length + 1}.xml`;
    const zipPath = target.startsWith("/") ? target.slice(1) : path.posix.normalize(`xl/${target}`);
    if (!zipPath.startsWith("xl/worksheets/") || zipPath.includes("..")) continue;
    const xml = await zipXml(zip, zipPath);
    if (!xml) continue;
    sections.push({ label: `Sheet: ${attr.name ?? sections.length + 1} (first 30 rows, 20 columns)`, text: sheetRows(xml, strings) });
  }
  return sections;
}

async function pptxSections(content) {
  const zip = await loadOfficeZip(content);
  const slideNumbers = Object.keys(zip.files)
    .map((name) => name.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b)
    .slice(0, 50);
  const sections = [];
  for (const number of slideNumbers) {
    const slide = await zipXml(zip, `ppt/slides/slide${number}.xml`);
    const notes = await zipXml(zip, `ppt/notesSlides/notesSlide${number}.xml`);
    const slideText = Array.from((slide ?? "").matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g), (match) => decodeEntities(match[1]));
    const notesText = Array.from((notes ?? "").matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g), (match) => decodeEntities(match[1]));
    const text = `${slideText.join("\n")}${notesText.length ? `\n备注：${notesText.join(" ")}` : ""}`.slice(0, MAX_EXTRACTED_CHARS);
    sections.push({ label: `Slide ${number}${slideText[0] ? `: ${slideText[0]}` : ""}`, text });
  }
  return sections;
}

async function pdfSections(content) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfModuleUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const cMapUrl = fileURLToPath(new URL("../../cmaps/", pdfModuleUrl));
  const standardFontDataUrl = fileURLToPath(new URL("../../standard_fonts/", pdfModuleUrl));
  const task = getDocument({
    data: new Uint8Array(content),
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false
  });
  try {
    const pdf = await task.promise;
    const sections = [];
    for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, 50); pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = textContent.items.map((item) => item.str ?? "").join(" ").slice(0, MAX_EXTRACTED_CHARS);
      sections.push({ label: `PDF page ${pageNumber}`, text: text || "[No text layer; OCR was not run]" });
    }
    return sections;
  } finally {
    await task.destroy();
  }
}

export async function extractDocument(extension, content) {
  if (extension === ".txt" || extension === ".md") {
    return [{ label: extension === ".md" ? "Markdown" : "Text", text: new TextDecoder("utf-8").decode(content).slice(0, MAX_EXTRACTED_CHARS) }];
  }
  if (extension === ".pdf") return pdfSections(content);
  if (extension === ".docx") return docxSections(content);
  if (extension === ".xlsx") return xlsxSections(content);
  if (extension === ".pptx") return pptxSections(content);
  throw new Error(`Unsupported file type: ${extension}`);
}

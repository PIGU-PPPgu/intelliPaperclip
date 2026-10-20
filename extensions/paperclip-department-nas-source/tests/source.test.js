import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { extractDocument } from "../src/formats.js";
import { assertTrialScope, getRoot, listContained, parseSmbMounts, readContained, resolveContained, validateRelative, verifySnapshot } from "../src/source.js";

const base = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-nas-source-test-"));
after(async () => fs.rm(base, { recursive: true, force: true }));

test("rejects traversal and symlink escape before any read", async () => {
  const root = path.join(base, "source");
  await fs.mkdir(root, { recursive: true });
  const outside = path.join(base, "outside.txt");
  await fs.writeFile(outside, "private");
  await fs.symlink(outside, path.join(root, "escape.txt"));
  for (const candidate of ["../outside.txt", "/etc/passwd", "x/../outside.txt", "x\\outside.txt", "./outside.txt", ".env", "#recycle/file.txt"]) {
    assert.throws(() => validateRelative(candidate));
  }
  await assert.rejects(resolveContained(root, "escape.txt"), /Symlink escapes/);
  await assert.rejects(readContained(root, "escape.txt"), /Symlink escapes/);
  const original = await fs.readFile(outside, "utf8");
  assert.equal(original, "private");
});

test("refuses writable declarations and oversized trial directories", async () => {
  const root = path.join(base, "scope");
  await fs.mkdir(root, { recursive: true });
  const context = (access, entries, truncated = false) => ({ localFolders: {
    status: async () => ({ healthy: true, access, realPath: root }),
    list: async () => ({ entries, truncated })
  } });
  await assert.rejects(getRoot(context("readWrite", []), "company"), /read-only/);
  const entries = Array.from({ length: 31 }, (_, i) => ({ kind: "file", path: `${i}.txt` }));
  assert.throws(() => assertTrialScope({ entries, truncated: false }), /30-file/);
  assert.throws(() => assertTrialScope({ entries: [], truncated: true }), /30-file/);
  assert.doesNotThrow(() => assertTrialScope({ entries: entries.slice(0, 30), truncated: false }));
  await assert.rejects(getRoot(context("read", []), "company"), /snapshot/);
});

test("recognizes only read-only SMB mounts", () => {
  const mounts = parseSmbMounts([
    "//reader@nas/Teamshare on /Volumes/Teamshare (smbfs, nodev, nosuid, read-only, mounted by user)",
    "//admin@nas/GroupData on /Volumes/GroupData (smbfs, nodev, nosuid, mounted by user)",
    "/dev/disk3 on / (apfs, local, journaled)"
  ].join("\n"));
  assert.deepEqual(mounts, [
    { path: "/Volumes/Teamshare", readOnly: true },
    { path: "/Volumes/GroupData", readOnly: false }
  ]);
});

test("bounded listing omits hidden metadata and rejects symlinks", async () => {
  const root = path.join(base, "listing");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "visible.txt"), "test");
  await fs.writeFile(path.join(root, ".DS_Store"), "metadata");
  const listing = await listContained(await fs.realpath(root), "", { recursive: true, maxEntries: 10 });
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["visible.txt"]);
  await fs.symlink(path.join(base, "outside.txt"), path.join(root, "escape.txt"));
  await assert.rejects(listContained(await fs.realpath(root), "", { recursive: true, maxEntries: 10 }), /Symlinks/);
});

test("accepts only a hash-matching local read-only NAS snapshot", async () => {
  const parent = path.join(base, "snapshots");
  const root = path.join(parent, "pilot");
  await fs.mkdir(root, { recursive: true });
  const contents = Buffer.from("Synthetic source");
  await fs.writeFile(path.join(root, "source.txt"), contents);
  await fs.writeFile(path.join(root, ".paperclip-source.json"), JSON.stringify({
    kind: "paperclip-nas-snapshot-v1",
    sourceShare: "Teamshare",
    fileCount: 1,
    files: [{ path: "source.txt", size: contents.length, sha256: createHash("sha256").update(contents).digest("hex") }]
  }));
  await fs.chmod(root, 0o555);
  try {
    const accepted = await verifySnapshot(await fs.realpath(root), await fs.realpath(parent));
    assert.equal(accepted.sourceKind, "verified_nas_snapshot");
    await fs.chmod(root, 0o755);
    await fs.writeFile(path.join(root, "source.txt"), "Changed");
    await fs.chmod(root, 0o555);
    await assert.rejects(verifySnapshot(await fs.realpath(root), await fs.realpath(parent)), /hash mismatch/);
  } finally {
    await fs.chmod(root, 0o700);
  }
});

test("reads text and bounded Office structures without writing source files", async () => {
  const docx = new JSZip();
  docx.file("word/document.xml", `<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Campus Plan</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table item</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`);
  const docxText = (await extractDocument(".docx", await docx.generateAsync({ type: "nodebuffer" }))).map((section) => section.text).join(" ");
  assert.match(docxText, /# Campus Plan/);
  assert.match(docxText, /Table item/);

  const xlsx = new JSZip();
  xlsx.file("xl/workbook.xml", `<workbook><sheets><sheet name="Status" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  xlsx.file("xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`);
  xlsx.file("xl/sharedStrings.xml", `<sst><si><t>Task</t></si><si><t>Pending</t></si></sst>`);
  xlsx.file("xl/worksheets/sheet1.xml", `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>`);
  const xlsxSections = await extractDocument(".xlsx", await xlsx.generateAsync({ type: "nodebuffer" }));
  assert.match(xlsxSections[0].label, /Status/);
  assert.match(xlsxSections[0].text, /Task\nPending/);

  const pptx = new JSZip();
  pptx.file("ppt/slides/slide1.xml", `<p:sld><a:t>Campus Update</a:t><a:t>Complete pilot</a:t></p:sld>`);
  pptx.file("ppt/notesSlides/notesSlide1.xml", `<p:notes><a:t>Review next month</a:t></p:notes>`);
  const pptxSections = await extractDocument(".pptx", await pptx.generateAsync({ type: "nodebuffer" }));
  assert.match(pptxSections[0].label, /Campus Update/);
  assert.match(pptxSections[0].text, /Review next month/);

  const text = await extractDocument(".md", Buffer.from("# Source note\nDecision recorded"));
  assert.match(text[0].text, /Decision recorded/);
});

test("extracts the PDF text layer with a page marker", async () => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 52 >>\nstream\nBT /F1 18 Tf 72 720 Td (Pilot approved) Tj ET\nendstream"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const sections = await extractDocument(".pdf", Buffer.from(pdf));
  assert.equal(sections[0].label, "PDF page 1");
  assert.match(sections[0].text, /Pilot approved/);
});

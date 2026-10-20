import { constants as fsConstants, promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { folderKey } from "./manifest.js";
import { extractDocument, supportedExtensions } from "./formats.js";

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SEARCH_FILES = 30;
const MAX_SEARCH_ENTRIES = 200;
const MAX_READ_CHARS = 20000;
const execFileAsync = promisify(execFile);

function allowedPath(relative) {
  return relative.split("/").every((part) => {
    const lower = part.toLowerCase();
    return part && !part.startsWith(".") && lower !== "#recycle" && lower !== "@recycle" && lower !== "@eadir";
  });
}

export function validateRelative(input, allowRoot = false) {
  if (allowRoot && (input === "" || input === undefined || input === null)) return "";
  if (typeof input !== "string" || !input || input.length > 1024 || input.includes("\0") || input.includes("\\") || path.isAbsolute(input)) {
    throw new Error("A relative path inside the configured source is required");
  }
  if (input.split("/").some((part) => !part || part === "." || part === "..") || !allowedPath(input)) {
    throw new Error("Path traversal, hidden files and recycle folders are not allowed");
  }
  return input;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function parseSmbMounts(mountOutput) {
  const mounts = [];
  for (const line of mountOutput.split("\n")) {
    const separator = line.lastIndexOf(" on ");
    const optionsAt = line.lastIndexOf(" (smbfs,");
    if (separator < 0 || optionsAt < separator || !line.endsWith(")")) continue;
    mounts.push({
      path: line.slice(separator + 4, optionsAt),
      readOnly: line.slice(optionsAt).split(",").some((option) => option.trim() === "read-only")
    });
  }
  return mounts;
}

export function assertTrialScope(listing) {
  const fileCount = listing.entries.filter((entry) => entry.kind === "file" && allowedPath(entry.path)).length;
  if (listing.truncated || fileCount > MAX_SEARCH_FILES) {
    throw new Error("Source exceeds the 30-file trial allowlist; configure a smaller test directory");
  }
}

async function enclosingSmbMount(root) {
  const { stdout } = await execFileAsync("/sbin/mount", [], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  return parseSmbMounts(stdout)
    .filter((mount) => isInside(mount.path, root))
    .sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

export async function getRoot(ctx, companyId) {
  const status = await ctx.localFolders.status(companyId, folderKey);
  if (!status.healthy || status.access !== "read" || !status.realPath) {
    throw new Error("Department NAS source is not configured as a healthy read-only local folder");
  }
  const root = await fs.realpath(status.realPath);
  const smbMount = await enclosingSmbMount(root);
  if (smbMount) {
    if (root === smbMount.path) throw new Error("Select a narrow test directory, never an entire mounted share");
    if (!smbMount.readOnly) throw new Error("The configured SMB mount is writable; mount it read-only first");
    try {
      await fs.access(root, fsConstants.W_OK);
      throw new Error("The NAS test directory is writable; use a read-only SMB mount");
    } catch (error) {
      if (error?.code !== "EACCES" && error?.code !== "EROFS") throw error;
    }
  } else {
    return verifySnapshot(root);
  }
  const scope = await listContained(root, "", { recursive: true, maxEntries: MAX_SEARCH_ENTRIES });
  assertTrialScope(scope);
  return { root, sourceKind: "live_readonly_smb" };
}

export async function resolveContained(root, input, allowRoot = false) {
  const relative = validateRelative(input, allowRoot);
  if (!relative) return { relative, absolute: root };
  const absolute = await fs.realpath(path.join(root, relative));
  if (!isInside(root, absolute)) throw new Error("Symlink escapes the configured source");
  return { relative, absolute };
}

export async function listContained(root, relativePath = "", options = {}) {
  const maxEntries = Math.max(1, Math.min(200, Number(options.maxEntries ?? 100)));
  const recursive = options.recursive === true;
  const checked = validateRelative(relativePath, true);
  const target = await resolveContained(root, checked, true);
  if (!(await fs.stat(target.absolute)).isDirectory()) throw new Error("List target is not a directory");
  const entries = [];
  const visited = new Set();
  let truncated = false;

  async function visit(directory, prefix, depth) {
    if (visited.has(directory)) throw new Error("Directory cycle in NAS source");
    if (depth > 6) throw new Error("NAS test directory is too deep");
    visited.add(directory);
    const dirents = await fs.readdir(directory, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (truncated) break;
      const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (!allowedPath(relative)) continue;
      if (entries.length >= maxEntries) { truncated = true; break; }
      if (dirent.isSymbolicLink()) throw new Error("Symlinks are not allowed in the NAS test directory");
      const child = await resolveContained(root, relative);
      const stat = await fs.stat(child.absolute);
      const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null;
      if (!kind) continue;
      entries.push({ path: relative, name: dirent.name, kind, size: kind === "file" ? stat.size : null, modifiedAt: stat.mtime.toISOString() });
      if (recursive && kind === "directory") await visit(child.absolute, relative, depth + 1);
    }
    visited.delete(directory);
  }

  await visit(target.absolute, checked, 0);
  return { path: checked, entries, truncated };
}

export async function statEntry(root, relative) {
  const resolved = await resolveContained(root, relative);
  const stat = await fs.stat(resolved.absolute);
  return {
    name: path.basename(resolved.relative),
    path: resolved.relative,
    type: stat.isDirectory() ? "directory" : stat.isFile() ? (path.extname(resolved.absolute).toLowerCase() || "file") : "other",
    size: stat.isFile() ? stat.size : null,
    modifiedAt: stat.mtime.toISOString()
  };
}

export async function readContained(root, relative) {
  const resolved = await resolveContained(root, relative);
  const handle = await fs.open(resolved.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Read target is not a regular file");
    if (stat.size > MAX_FILE_BYTES) throw new Error("File exceeds the 16 MiB per-file limit");
    const content = await handle.readFile();
    if (content.length > MAX_FILE_BYTES) throw new Error("File exceeds the 16 MiB per-file limit");
    return { content, stat };
  } finally {
    await handle.close();
  }
}

export async function verifySnapshot(root, allowedBase = path.join(os.homedir(), "PaperclipOffice", "nas-snapshot")) {
  const realBase = await fs.realpath(allowedBase);
  if (root === realBase || !isInside(realBase, root)) throw new Error("NAS snapshot must stay inside the local snapshot directory");
  try {
    await fs.access(root, fsConstants.W_OK);
    throw new Error("NAS snapshot directory is writable");
  } catch (error) {
    if (error?.code !== "EACCES" && error?.code !== "EROFS") throw error;
  }
  const markerPath = path.join(root, ".paperclip-source.json");
  const markerStat = await fs.lstat(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("NAS snapshot provenance marker is unsafe");
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  if (marker.kind !== "paperclip-nas-snapshot-v1" || marker.sourceShare !== "Teamshare" || !Array.isArray(marker.files) || marker.files.length === 0 || marker.files.length > MAX_SEARCH_FILES || marker.fileCount !== marker.files.length) {
    throw new Error("NAS snapshot provenance marker is invalid");
  }
  const listing = await listContained(root, "", { recursive: true, maxEntries: MAX_SEARCH_ENTRIES });
  assertTrialScope(listing);
  const actualPaths = listing.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path).sort();
  const expectedPaths = marker.files.map((entry) => validateRelative(entry.path)).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error("NAS snapshot file set differs from its provenance marker");
  for (const row of marker.files) {
    const { content, stat } = await readContained(root, row.path);
    if (stat.size !== row.size || createHash("sha256").update(content).digest("hex") !== row.sha256) {
      throw new Error(`NAS snapshot hash mismatch: ${row.path}`);
    }
  }
  return { root, sourceKind: "verified_nas_snapshot" };
}

export async function readDocument(ctx, companyId, relative) {
  const { root, sourceKind } = await getRoot(ctx, companyId);
  validateRelative(relative);
  const ext = path.extname(relative).toLowerCase();
  if (!supportedExtensions.has(ext)) throw new Error(`Unsupported file type: ${ext || "none"}`);
  const { content, stat } = await readContained(root, relative);
  const sections = await extractDocument(ext, content);
  return {
    name: path.basename(relative),
    path: relative,
    type: ext,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sourceKind,
    sections
  };
}

export async function listEntries(ctx, companyId, relative = "") {
  const { root, sourceKind } = await getRoot(ctx, companyId);
  return { ...await listContained(root, relative, { recursive: false, maxEntries: 100 }), sourceKind };
}

export async function searchDocuments(ctx, companyId, query) {
  const { root, sourceKind } = await getRoot(ctx, companyId);
  if (typeof query !== "string" || query.trim().length < 2 || query.length > 100) throw new Error("Query must contain 2 to 100 characters");
  const needle = query.trim().toLocaleLowerCase();
  const listing = await listContained(root, "", { recursive: true, maxEntries: MAX_SEARCH_ENTRIES });
  const files = listing.entries.filter((entry) => entry.kind === "file" && allowedPath(entry.path) && supportedExtensions.has(path.extname(entry.path).toLowerCase()));
  if (listing.truncated || files.length > MAX_SEARCH_FILES) {
    throw new Error("Source exceeds the 30-file trial allowlist; configure a smaller test directory");
  }
  const results = [];
  const skipped = [];
  for (const file of files) {
    const filenameHit = file.path.toLocaleLowerCase().includes(needle);
    let contentHit = null;
    try {
      const doc = await readDocument(ctx, companyId, file.path);
      for (const section of doc.sections) {
        const at = section.text.toLocaleLowerCase().indexOf(needle);
        if (at !== -1) {
          contentHit = { location: section.label, snippet: section.text.slice(Math.max(0, at - 60), Math.min(section.text.length, at + needle.length + 90)) };
          break;
        }
      }
    } catch (error) {
      // Report incomplete coverage explicitly instead of implying a complete search.
      skipped.push({ path: file.path, reason: error instanceof Error ? error.message : "Content extraction failed" });
      if (filenameHit) contentHit = { location: "filename/path", snippet: file.path };
    }
    if (filenameHit || contentHit) results.push({ name: file.name, path: file.path, reason: contentHit ?? { location: "filename/path", snippet: file.path } });
  }
  return { query: query.trim(), searchedFiles: files.length, results, skipped, sourceKind };
}

export function renderDocument(doc) {
  let content = doc.sections.map((section) => `[${section.label}]\n${section.text}`).join("\n\n");
  const truncated = content.length > MAX_READ_CHARS;
  if (truncated) content = `${content.slice(0, MAX_READ_CHARS)}\n[Output truncated]`;
  return { ...doc, content, truncated, sections: undefined };
}

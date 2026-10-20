const pluginId = "paperclip.department-nas-source";
const folderKey = "department-nas-source";

const pathProperty = {
  type: "string",
  description: "Path relative to the administrator configured test directory. Empty means its root."
};

const manifest = {
  id: pluginId,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Department NAS Source",
  description: "Read-only, bounded access to a small administrator selected department document folder.",
  author: "Wisdom Campus Office",
  categories: ["connector", "workspace"],
  capabilities: ["local.folders", "agent.tools.register"],
  entrypoints: { worker: "./src/worker.js" },
  localFolders: [{
    folderKey,
    displayName: "Department NAS",
    description: "Select one small, non-sensitive directory on a read-only SMB mount, or an explicitly captured and hash-verified local NAS snapshot. Never select a share root or the Wiki root.",
    access: "read"
  }],
  tools: [
    {
      name: "nas_list",
      displayName: "List department files",
      description: "List only the configured read-only test directory or a directory beneath it. Returns relative paths and metadata.",
      parametersSchema: { type: "object", properties: { path: pathProperty }, additionalProperties: false }
    },
    {
      name: "nas_search",
      displayName: "Search department files",
      description: "Search names, relative paths and extractable text of up to 30 files in the configured test directory. Returns cited matches.",
      parametersSchema: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 100 } }, required: ["query"], additionalProperties: false }
    },
    {
      name: "nas_read",
      displayName: "Read a department file",
      description: "Read one text, PDF, DOCX, XLSX or PPTX file under the configured read-only test directory. Includes page, sheet or slide markers where available.",
      parametersSchema: { type: "object", properties: { path: pathProperty }, required: ["path"], additionalProperties: false }
    },
    {
      name: "nas_stat",
      displayName: "Inspect a department file",
      description: "Get size, type and modified time for one file or folder under the configured read-only test directory.",
      parametersSchema: { type: "object", properties: { path: pathProperty }, required: ["path"], additionalProperties: false }
    }
  ]
};

export { pluginId, folderKey };
export default manifest;

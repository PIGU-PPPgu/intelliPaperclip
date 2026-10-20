# Department NAS Source for Paperclip

This standalone Paperclip plugin declares one administrator configured `localFolders` root with `access: "read"`. It contributes only `nas_list`, `nas_search`, `nas_read`, and `nas_stat`. It does not contain a NAS address, account, password, write tool, scheduled job, or ingestion routine.

## Source boundary

- Configure a **small non-sensitive test directory**, never the root of a mounted SMB share.
- In live NAS mode the worker requires an active read-only SMB mount and refuses its share root or a test directory writable by the macOS account. If that mount disappears, reads fail closed. Prefer a dedicated Synology reader account as well as a read-only mount.
- When macOS blocks the background worker from opening SMB directories, an administrator may bind a **separate local snapshot** under `~/PaperclipOffice/nas-snapshot/`. The snapshot must be read-only and contain `.paperclip-source.json` with source share, exact file list, sizes and SHA-256 hashes; the plugin rechecks those hashes for every operation and reports `verified_nas_snapshot`. This proves downstream workflows over an exact NAS copy, not live SMB access.
- Paperclip Agent shell access is a separate path from plugin tools. If an administrator account retains a second writable mount, this plugin cannot prevent a shell-capable Agent from bypassing it. Do not run such an Agent against NAS material until the broader mount is isolated or the account is restricted server-side.
- Relative paths are checked for traversal, hidden files and recycle folders; real paths must remain within the configured root. A direct file read uses `O_NOFOLLOW` and a 16 MiB limit.
- Every tool refuses a source with more than 30 files or 200 entries. No full-share index is built.
- PDF text layers, DOCX paragraphs and table text, XLSX first 30 rows of up to eight sheets, and PPTX slide and notes text are extracted in memory. OCR is not performed.

## Installation

Install dependencies with Node 24, then install the local plugin using Paperclip's Plugin Manager or `paperclipai plugin install /absolute/path/to/this/folder`. Bind `department-nas-source` through the Plugin Manager or `paperclipai plugin local-folder:set` for the intended company. Do not bind it until the SMB path is verified read-only and scoped to a safe test directory.

Run `npm test` for traversal, symlink, Office format, and PDF text-layer checks. No test touches the NAS.

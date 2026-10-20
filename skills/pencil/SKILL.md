---
name: pencil
description: Open, edit, capture and export .pen designs in the real Pencil editor through the Pencil plugin, alone or with other agents sharing one design session. Use when the user asks to open or create a .pen file with Pencil, edit a Pencil design, capture or export Pencil screens, or coordinate several agents on one Pencil document.
---

# Pencil design sessions

The `pencil` MCP server exposes `pencil_*` tools. Documents open only through these tools; nothing is associated with `.pen` files automatically.

1. Call `pencil_open` with an absolute `.pen` path and an explicit `scope` (or `pencil_new` with a new absolute path). Keep the returned `sessionId`.
2. Open the returned `viewUrl` in a browser: in the Claude desktop app, open it in the built-in Browser pane and show that pane; otherwise give it to the user. Keep the view visible: a page loaded or left in a hidden pane or background tab may never start the engine. The real Pencil editor loads from `https://app.pen.dev` and connects to the local session channel.
3. Poll `pencil_status` until `connected` is `true`. If it stays `false`, report it; do not edit the `.pen` file directly.
4. For each read/edit/verify sequence: `pencil_begin` (with a short `agent` label) → `pencil_call` → `pencil_end`. On `LEASE_BUSY`, wait, then re-read the document before editing.
5. Before the first edit, call `pencil_call` with `read_skill`, then `get_app_state`; use `pencil_tools` for native schemas. Pass `readOnly: true` to `pencil_call` for `execute` snippets that only read (Get/Print), so the save state is kept.
6. To collaborate, give other agents the `sessionId` only. They use `pencil_begin`/`pencil_call`/`pencil_end` with it; they must not open the same file under another scope, and they must read and preserve existing work.

Rules:
- `.pen` files are opaque: never read or write them with file tools.
- Captures (`pencil_capture`), exports (`pencil_export`) and `pencil_save_as` need a lease and an existing absolute destination; they never overwrite.
- Edits go to a draft in the plugin data directory; the original file is never replaced. Use `pencil_save_as` after `saveState` is `draft-saved`.
- After `OUTCOME_UNKNOWN`, never replay the mutation. Reload the view: the new view reloads the last saved draft and unblocks the session (`recoveries` increases). Re-read the document before any further edit.
- `Generate(...)` (asynchronous generation) is unsupported.

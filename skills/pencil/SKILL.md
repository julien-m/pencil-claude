---
name: pencil
description: Open, edit, capture and export .pen designs in the real Pencil editor through the Pencil plugin, alone or with other agents sharing one design session. Use when the user asks to open or create a .pen file with Pencil, edit a Pencil design, capture or export Pencil screens, or coordinate several agents on one Pencil document.
---

# Pencil design sessions

The `pencil` MCP server exposes `pencil_*` tools. Documents open only through these tools; nothing is associated with `.pen` files automatically.

1. Call `pencil_open` with an absolute `.pen` path and an explicit `scope` (or `pencil_new` with a new absolute path). Keep the returned `sessionId`.
2. Open the returned `viewUrl` in a browser: in the Claude desktop app, open it in the built-in Browser pane and show that pane; otherwise give it to the user. Keep the view visible: a page loaded or left in a hidden pane or background tab may never start the engine. The real Pencil editor loads from `https://app.pen.dev` and connects to the local session channel.
3. Collaborating agents can be launched right away, while the view opens: `pencil_begin` joins immediately, and engine calls wait for the engine (up to the deadline the service advertises, 20 s by default, `PENCIL_EDITOR_WAIT_MS`). `EDITOR_OFFLINE` means the deadline passed and nothing was sent; open or show the view, then call again. Never edit the `.pen` file directly.
4. Join with `pencil_begin` (short `agent` label) to get your own non-exclusive participation token, use `pencil_call`, and leave with `pencil_end` when your work is verified. Other agents of the session may edit the same document at the same time: work on your own frames or components, re-read before each edit, and only change nodes you created. Contradictory edits to one object are not merged. Engine globals are shared between agents: use distinct variable names.
5. Before the first edit, call `pencil_call` with `read_skill`, then `get_app_state`; use `pencil_tools` for native schemas. Documentation and schemas are fetched once per session and shared between agents. Pass `readOnly: true` to `pencil_call` for `execute` snippets that only read (Get/Print), so the save state is kept.
6. To collaborate, give other agents the `sessionId` only and split the work (for example one screen each). They join with `pencil_begin`; they must not open the same file under another scope, and they must preserve existing work.
7. New documents are empty. Each agent creates its own frame in its first `execute`, at a position the coordinator assigns or found with `FindEmptySpace`. The number of agents and screens, their names, sizes, colours and content always come from the task: never expect pre-created frames or IDs from an earlier run.

Rules:
- `.pen` files are opaque: never read or write them with file tools.
- Captures (`pencil_capture`), exports (`pencil_export`) and `pencil_save_as` need a participation token and an existing absolute destination; they never overwrite. `pencil_save` and `pencil_save_as` wait for running calls, briefly hold new ones, flush the engine, and write nothing unless every completed edit is persisted (`SAVE_NOT_READY` otherwise).
- Edits go to a draft in the plugin data directory until saved. After `saveState` is `draft-saved`, use `pencil_save` to write the original file (refused with `SAVE_CONFLICT` if it changed on disk; then use `pencil_save_as`), or `pencil_save_as` for a new file. Save only when the user asked for it or the task implies keeping the result in that file.
- After `OUTCOME_UNKNOWN`, never replay the mutation. Reload the view: the new view reloads the last saved draft and unblocks the session (`recoveries` increases). Re-read the document before any further edit.
- `Generate(...)` (asynchronous generation) is unsupported.

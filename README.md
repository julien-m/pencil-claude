# Pencil

<p align="center">
  <img src="docs/images/login-light.png" alt="Light login screen for a fintech app, designed in Pencil by a Claude Code session" width="49%">
  <img src="docs/images/login-dark.png" alt="Dark split-layout login screen for a music app, designed in Pencil by a second Claude Code session" width="49%">
</p>
<p align="center"><em>Two login screens designed at the same time by two Claude Code sessions, each in its own Pencil document, then saved and exported with this plugin.</em></p>

A Claude Code plugin that opens `.pen` design documents in the real Pencil editor, without adding another chat interface. A local Node.js service keeps one channel per design session, so several agents can work on the same document at the same time.

This repository, **pencil-claude**, contains one independently installable Claude Code plugin. Its display name is **Pencil** and its identifier is `pencil`. The Codex version lives in the separate [pencil-codex](https://github.com/julien-m/pencil-codex) repository.

## How the editor is shown

Claude Code does not render MCP Apps: according to the [MCP Apps documentation](https://claude.com/docs/connectors/building/mcp-apps/quickstart), it calls the tool as text and does not display the UI. An embedded panel inside Claude Code is therefore **not available**.

Instead, the plugin's local service serves the editor page itself. `pencil_open` returns a `viewUrl` on `127.0.0.1`. Opening it loads the real hosted Pencil editor (`https://app.pen.dev`) and connects it to the session channel:

- **Claude Code in the Claude desktop app:** the agent opens `viewUrl` in the desktop app's built-in Browser pane. This is the setup validated below. It is a local browser view, not a native panel.
- **Claude Code in a terminal:** open `viewUrl` in any browser on the same machine.

The plugin also declares an MCP Apps resource (`ui://pencil/editor-v1.html`) for hosts that render MCP Apps. This path has **not** been validated with Claude. Claude Desktop chat and claude.ai ignore local (stdio) MCP servers from plugins, so this plugin's tools are not available there.

## Requirements

- Claude Code with plugin support.
- Node.js 22 or later on `PATH`.
- Network access to the hosted Pencil editor at `https://app.pen.dev`.
- A browser on the same machine (or the Claude desktop app's Browser pane).
- Bun for development and tests only.

The plugin does not redistribute the proprietary Pencil engine and does not work offline.

## Installation

```bash
claude plugin marketplace add julien-m/pencil-claude
claude plugin install pencil@pencil
```

Inside an interactive session you can use `/plugin marketplace add julien-m/pencil-claude`, then `/plugin install pencil@pencil`. Start a new session afterwards so the tools load.

The built bundles are committed, so installation needs neither a compiler nor `node_modules`. Tools appear as `mcp__plugin_pencil_pencil__pencil_*`, and the bundled `pencil` skill describes the workflow to the agent.

To update or remove:

```bash
claude plugin marketplace update pencil
claude plugin update pencil@pencil
claude plugin uninstall pencil@pencil
```

## Usage

Ask Claude to use Pencil, for example: “Open /absolute/path/landing.pen in Pencil and add a pricing section.”

1. The agent calls `pencil_open` with an absolute `.pen` path and an explicit `scope`, or `pencil_new` to create a document. It receives a `sessionId` and a `viewUrl`.
2. The agent (or you) opens `viewUrl`. **Keep the view visible**: a page loaded or left in a hidden pane or background tab may never start the Pencil engine, and calls then time out.
3. Agents can be launched right away, while the view opens: `pencil_begin` joins immediately, and engine calls wait for the engine (see *Startup* below). Each agent loads the native instructions with `pencil_call` → `read_skill`.
4. The agent joins with `pencil_begin`, works with `pencil_call`, and leaves with `pencil_end`. New documents are empty: each agent creates its own frame in its first `execute`; the plugin never creates frames or decides how many screens there are.
5. To collaborate, other agents receive the `sessionId` only and join with `pencil_begin`. They must not open the same file under another `scope` (that is refused with `DOCUMENT_BUSY`).

### Shared sessions

**Between sessions, exclusive.** A `.pen` document belongs to exactly one design session. Opening it from another session (another `scope`) is refused with `DOCUMENT_BUSY`.

**Inside a session, shared.** All agents of a session use the same `sessionId`, the same channel and the same document:

- `pencil_begin` gives each agent its own **non-exclusive participation token** (the `lease` field). There is no lock on the document between agents.
- `pencil_call` forwards each call to the engine **immediately**, without waiting for another agent's answer and without a session-wide queue. Every request carries its own id, so answers that come back out of order still reach the right agent.
- `pencil_end` removes one agent (refused only while that agent's own calls are running); the other agents are not interrupted.
- Split the work: each agent edits its own frames or components, re-reads before editing, and never changes another agent's nodes. **The plugin does not merge contradictory edits to the same object**: the engine applies them in the order it receives them, and the last one wins.
- The engine's JavaScript globals (variables created by `execute` snippets) are shared by every agent of the session. Use distinct variable names per agent, or none.

**Plugin concurrency vs. engine execution.** Concurrency is a property of the plugin: it sends calls from several agents at once and keeps them in flight together. The hosted Pencil engine then runs `execute` snippets one at a time in its browser thread. Two simultaneous calls therefore overlap in the plugin but complete one after the other inside the engine.

**Consistent saves.** `pencil_save` and `pencil_save_as` keep every agent joined and:

1. wait until the calls already running have answered;
2. briefly hold back new calls from all agents (they are sent as soon as the save is written; `saving: true` in `pencil_status` meanwhile);
3. ask the engine to flush its current content (`save` request); if the engine cannot, they wait up to 5 s for an autosave that covers every completed edit;
4. write only if the persisted snapshot contains **every completed edit**, otherwise answer `SAVE_NOT_READY` and write nothing.

A snapshot only counts as containing an edit if it reaches the service **after** that edit's answer. The engine channel preserves message order, so a snapshot produced while another agent's edit was still running never marks that edit as saved (`unsavedMutations` in `pencil_status` shows the count).

Documents open only through `pencil_open` or `pencil_new`. The plugin does not register any `.pen` file association.

### Startup

- **Joining never waits.** `pencil_begin` answers at once, even before any view is open.
- **Engine calls wait for the engine.** A call sent before the view has loaded the hosted engine waits for the engine's handshake (not just an open socket) until a deadline, 20 s by default. The service reads `PENCIL_EDITOR_WAIT_MS` at startup and advertises its deadlines to every MCP client, so a client with a different environment cannot shorten them. At expiry the call returns `EDITOR_OFFLINE` and nothing was sent. While held back, calls are visible as `waitingCalls` in `pencil_status` and as "waiting for the engine" in the view; expired calls appear in `recentCalls`.
- **Engine documentation is fetched once per session.** `read_skill` (per path) and the tool schemas are identical for every agent: concurrent requests share one engine round trip, each agent receives its own copy, errors are not kept, and a reconnected view (new engine generation) starts afresh. `pencil_status` reports `metadataStats` and logs hits as `cache-hit`.
- `pencil_status` also reports `openedAt` and `readyAt`, and every call's `queuedAt`, `sentAt` and `settledAt`, so the time spent waiting for the engine, preparing in the agent, and executing can be told apart.

### Tools

| Tool | Purpose |
|---|---|
| `pencil_open` | Open an existing `.pen` file in a design session; returns `sessionId` and `viewUrl` |
| `pencil_new` | Create a `.pen` file at a new absolute path (never overwrites), then open it |
| `pencil_status` | Connection, `editorReady`, agents with their running and waiting calls, `saving`, save state, `unsavedMutations`, `metadataStats`, draft path, `openedAt`/`readyAt` and `recentCalls` (agent, tool, request id, queued, sent and answered timestamps) |
| `pencil_tools` | Native engine tool schemas |
| `pencil_begin` / `pencil_end` | Join / leave the shared session; each agent gets its own non-exclusive participation token |
| `pencil_call` | Call native tools: `execute`, `get_app_state`, `get_style`, `read_skill`. Pass `readOnly: true` for `execute` snippets that only read |
| `pencil_capture` | PNG captures of node IDs, or `["document"]` for the whole design |
| `pencil_export` | PNG, JPEG, WEBP, PDF, HTML/CSS or HTML/Tailwind export of the selected nodes |
| `pencil_save` | Flush the engine and replace the original `.pen` file; refused if the file changed on disk since it was loaded |
| `pencil_save_as` | Flush the engine and write a new `.pen` file |

Captures, exports, Save and Save As need a participation token. Captures, exports and Save As need an existing absolute destination and never overwrite an existing file; Save is the only tool that replaces a file, and only the session's own original. Exporting HTML/CSS and HTML/Tailwind both write `index.html`, so use separate directories for them. Engine screenshots are small previews; use `pencil_export` for full-resolution images.

### Agent activity

The local view shows every agent of the session with its activity (for example “2 agents: ● Agent A · 1 call running | ● Agent B · idle”) and “saving…” during a save, updated over the session channel. `pencil_status` also returns `recentCalls` with the timestamps of the last calls. The label is chosen by the agent and is not an authenticated identity. The plugin does not create per-agent cursors or presence on the Pencil canvas.

The page contains the unmodified Pencil editor: layers, components, zoom, Sign In, Goodies and settings stay as Pencil provides them. The plugin adds a two-line header above the editor and never hides or alters Pencil's interface with CSS, DOM injection or overlays.

## Architecture

```
Claude Code session ──stdio──▶ MCP server (dist/server.mjs, one per session)
                                   │ authenticated HTTP RPC on 127.0.0.1
                                   ▼
                     Local service (dist/daemon.mjs, one per user)
                       • sessions, participation tokens, drafts
                       • GET /view/<sessionId>/<grant>  → editor page
                       • WebSocket /editor              → session channel
                                   ▲
Browser view (127.0.0.1) ──────────┘   iframe: https://app.pen.dev/new?embed
                                       (MessageChannel bridge to the engine)
```

- The first MCP server to start spawns the detached local service; later sessions reuse it, which is how agents in different Claude Code sessions share a design session. If the service restarts, MCP servers reconnect automatically on the next call (sessions are then reopened with `pencil_open`).
- Native tool calls require a participation token and are forwarded at once; responses are matched by request id.
- The engine reads and writes the document through the channel; the service never decodes `.pen` contents.

Source: [MCP server](src/server.mjs), [client/service bootstrap](src/client.mjs), [local service](src/broker.mjs), [sessions and storage](src/sessions.mjs), [file outputs](src/artifacts.mjs), [editor view](web/editor.mjs).

## Storage

- Private data lives in `${CLAUDE_PLUGIN_DATA}` (by default `~/.claude/plugins/data/pencil-pencil/`), which survives plugin updates and is removed when the plugin is uninstalled from its last scope unless you keep its data. If the variable is absent (development), `PENCIL_DATA` or the plugin's `.runtime/` directory is used.
- `connection.json` holds the service port, its private token and PID (mode 0600).
- The engine's autosaves go to `drafts/<hash>.pen`, keyed by scope and file, even when the original changed on disk (the work is kept and `saveState` becomes `conflict`). The original document changes only when an agent calls `pencil_save`. Reopening the same file with the same `scope` reloads the draft, including after a service restart.
- `drafts/<hash>.pen.baseline` records which version of the original the draft was made from, so a restart cannot hide an external change: if the original changed meanwhile, the reopened session is in `conflict` and only Save As is allowed.
- `pencil_save` follows the consistent-save steps above. It then checks that the original still has the content the engine loaded (otherwise `SAVE_CONFLICT`, and nothing is replaced), copies the previous version to `backups/`, then atomically replaces the file, keeping its permissions. A final check runs just before the replacement; a write by another program in that last instant can still be lost, which is why the backup exists.
- `pencil_save_as` follows the same steps and writes a new file. Any `execute` call not marked `readOnly` sets `saveState` to `check-required` until a later snapshot covers it.
- Assets are limited to `images/` and `fonts/` next to the document. Traversal paths, symbolic links and `.pen` files used as assets are rejected.

## Security

- The service listens on `127.0.0.1` only. RPC requires a random bearer token; each editor view gets a separate random grant restricted to its session, and only one view can be attached to a session at a time.
- `viewUrl` contains that grant. Anyone on the machine who has the URL can open the session view, so do not share or publish it. The view page is served with `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and a nonce-based Content Security Policy that only allows frames from `https://app.pen.dev` and a WebSocket to the local service.
- No API key is bundled; tokens are generated at runtime. Documents stay local, but their contents are processed by the hosted Pencil editor. Review pen.dev's terms before using sensitive documents.
- Access tokens identify agents; they lock nothing, neither between agents nor against manual edits in the editor. Split the work between agents and do not run automated edits while someone edits by hand.

## Verified behavior and limits

Verified on macOS with Claude Code 2.1.296, the plugin installed from a local checkout of this repository with `claude plugin install`, and the view opened in the Claude desktop app's Browser pane:

- A design session survived a restart of the local service: reopening the same file with the same scope reloaded both agents' work from the draft; `pencil_save_as` then wrote a new file (a second Save As to the same path was refused) and the original was unchanged.
- Two Claude Code sessions, each with the installed plugin, created two documents and designed the two login screens shown above at the same time; each view showed its own agent badge, and each draft contained only its own design. `pencil_save` then wrote both designs into their original files and kept backups of the previous versions.
- **Shared session, real engine (0.4.0).** Two sub-agents of one Claude Code session joined one design session and each built a different mobile mock-up (a weather screen and a music player) in the same document. Their calls interleaved (A, A, B, B, A, B) and each agent saw the other's frame appear while working. Opening the document from another scope was refused with `DOCUMENT_BUSY`. These agents called the plugin's MCP server through a small command-line MCP client, because Claude Code reloads an updated plugin's tools only at the next user message.
- **Overlap, from the plugin's own `recentCalls`.** One edit per agent, each in its own mock-up, sent at the same time: both requests left the plugin at 06:50:56.380, before either answer; Agent A's answer arrived at 06:50:57.893 and Agent B's at 06:50:59.400. Inside the engine, the snippets ran one after the other (A 56.392–57.892, B 57.899–59.399). Between the two answers `unsavedMutations` was 2.
- **Save on the real engine.** `pencil_save` used the engine flush (`engine-flush`, answer `1`), wrote both mock-ups and both simultaneous edits into the original file (200 → 12,361 bytes), kept a backup, and left `unsavedMutations` at 0. Both mock-ups were then captured and exported.
- In normal agent work, individual calls last 10–100 ms while agents spend seconds between calls, so calls from two working agents rarely overlap in time even though nothing makes them wait.
- **Startup (0.5.0), three sub-agents, real engine, empty document.**
  - *View opened late on purpose (72 s after creation):* the three agents joined with no view; calls made within the 20 s deadline waited and then went out (one waited 19.2 s); older calls failed cleanly with `EDITOR_OFFLINE` and nothing was sent. The empty document opened in the hosted engine and each agent created its own frame.
  - *View opened right away:* the engine was ready 8.3 s after creation, but the agents' first calls only left at +22 s, +27 s and +34 s: an agent's own start-up takes longer than the engine. No call had to wait and none failed. First successful edits came at +51 s, +53 s and +69 s, almost entirely agent preparation. Documentation requests to the engine: 3 instead of 8 (5 cache hits), which saves engine traffic but well under a second of time. `pencil_save` then flushed the engine (`engine-flush`), including an edit not yet autosaved, and the saved file held all three screens.
- Captures of a component, a screen and the whole document; exports in all six formats; document creation; Save; Save As; layers panel navigation.

Known limits:

- No embedded panel in Claude Code (see above); the MCP Apps resource is untested with Claude.
- The view must stay visible while agents work. An unanswered call times out after 15 s with `OUTCOME_UNKNOWN` and blocks the session. Never replay that mutation: reload the view, which reloads the last saved draft and unblocks the session (`recoveries` increases); then re-read before editing.
- The plugin forwards calls in parallel, but the hosted Pencil engine runs `execute` snippets one after another: two simultaneous calls overlap in the plugin and complete one after the other in the engine.
- No automatic merge: two agents editing the same object get last-write-wins from the engine. Engine globals created by `execute` are shared between agents.
- New calls are held back while a save flushes and writes (normally well under a second).
- The startup changes reduce engine traffic and let agents start before the view; they do not shorten loading of the hosted engine or the agents' own preparation, which dominate the time to a first edit. If the view is opened by hand more than 20 s after agents start, their first calls fail with `EDITOR_OFFLINE`: raise `PENCIL_EDITOR_WAIT_MS` before the service starts, or open the view first.
- Asynchronous generation (`Generate(...)`) is not supported.
- External `.pen` libraries and the editor's document-library requests (such as `documents-list`) are not implemented; open and create documents with the plugin tools.
- Two views of different documents can be open at once. A view that was loaded while visible kept working from a background tab during the test; a view first loaded in a hidden pane did not start the engine.

## Stopping the service

The service survives the end of a Claude Code session. To stop it, read `pid` from `connection.json` in the data directory and send `SIGTERM`. Drafts are kept. After an interrupted start, a stale `starting` directory there can be removed once no service is running.

## Development

```bash
git clone https://github.com/julien-m/pencil-claude.git
cd pencil-claude
bun install --frozen-lockfile
bun run build
bun run test
bun run test:protocol
claude plugin validate . --strict
```

`bun run build` regenerates `dist/server.mjs`, `dist/daemon.mjs`, `dist/editor.html` and `THIRD-PARTY-NOTICES.md`; commit them with source changes. Unit tests use Bun; the loopback transport and MCP stdio tests use Node.js, like the installed runtime. Keep the version in `src/version.mjs`, `package.json` and both manifests in sync (a test checks it); bump it when the service protocol changes so a running older service is replaced.

To install from a local checkout:

```bash
claude plugin marketplace add "$PWD"
claude plugin install pencil@pencil
```

To try a disposable document in a standalone development service:

```bash
bun run preview /absolute/path/to/example.pen
```

Open the printed `viewUrl`. This harness runs its own private service, separate from the installed plugin's; its output contains local credentials, so do not publish it.

## License

MIT — see [LICENSE](LICENSE). Third-party licenses for bundled libraries are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). This is an independent integration, not affiliated with or endorsed by Pencil or Anthropic. The hosted Pencil engine remains subject to its publisher's terms. See also the [upstream embed proposal](https://github.com/highagency/pen-embed-demo).

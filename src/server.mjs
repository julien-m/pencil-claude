import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { connectBroker, root } from './client.mjs';
import { VERSION } from './version.mjs';

const server = new McpServer({ name: 'pencil', version: VERSION });
const resource = 'ui://pencil/editor-v1.html';
// Each Claude Code conversation starts its own stdio server, so this scope is per conversation and process.
const defaultScope = `client-${randomUUID()}`;
let broker;
const backend = async () => broker ??= await connectBroker();
// A refused connection never reached the service, so retrying once after a restart cannot replay a mutation.
async function rpc(method, args) {
  try { return await (await backend()).rpc(method, args); }
  catch (e) { if (e.code !== 'BROKER_UNREACHABLE') throw e; broker = undefined; return (await backend()).rpc(method, args); }
}
const object = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const wrap = fn => async (args, extra) => {
  try { return await fn(args, extra); }
  catch (e) { return { isError: true, content: [{ type: 'text', text: `${e.code ?? 'ERROR'}: ${e.message}` }] }; }
};
async function open(filename, scope, method = 'open') {
  const { editorToken, ...session } = await rpc(method, { path: filename, scope: scope ?? defaultScope });
  const hint = session.connected
    ? 'An editor view is already connected to this session.'
    : `Open viewUrl in a browser (in the Claude desktop app: the built-in Browser pane), keep that view visible, and wait until pencil_status reports connected: true. Share sessionId, not viewUrl, with other agents.`;
  return { content: [{ type: 'text', text: `${JSON.stringify(session)}\n${hint}` }], structuredContent: session, _meta: { editor: { sessionId: session.sessionId, port: broker.port, editorToken } } };
}
// Optional MCP Apps panel for hosts that render ui:// resources. Claude Code does not render them.
server.registerResource('pencil-editor', resource, {}, async () => {
  const b = await backend();
  return { contents: [{ uri: resource, mimeType: 'text/html;profile=mcp-app', text: await readFile(path.join(root, 'dist/editor.html'), 'utf8'), _meta: { ui: { csp: { connectDomains: [`http://127.0.0.1:${b.port}`, `ws://127.0.0.1:${b.port}`], frameDomains: ['https://app.pen.dev'] } } } }] };
});
const scope = z.string().min(1).max(200).optional().describe('Design-session scope. Reusing it with the same file returns the same session.');
server.registerTool('pencil_open', {
  title: 'Open in Pencil',
  description: 'Open an existing .pen file (absolute path) in a Pencil design session and return its sessionId and local viewUrl. Open viewUrl in a browser so the real Pencil editor connects, then share sessionId with collaborating agents. Wait for connected: true in pencil_status before other operations.',
  inputSchema: { path: z.string().min(1), scope },
  _meta: { ui: { resourceUri: resource } },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, wrap(args => open(args.path, args.scope)));
const id = z.string().uuid();
server.registerTool('pencil_new', { title: 'New Pencil document', description: 'Create a new .pen file at the chosen absolute path without overwriting any existing file, then open it like pencil_open.', inputSchema: { path: z.string().min(1), scope }, _meta: { ui: { resourceUri: resource } }, annotations: { destructiveHint: false, openWorldHint: true } }, wrap(args => open(args.path, args.scope, 'new')));
const selection = { sessionId: id, lease: id, nodeIds: z.array(z.string().min(1)).min(1).max(20).describe('Native node IDs, or ["document"] for the whole design'), directory: z.string().min(1).describe('Existing absolute directory') };
server.registerTool('pencil_capture', { title: 'Capture', description: 'Capture components or screens by native ID, or ["document"] for the whole design, as PNG files in the chosen existing absolute directory. Requires a participation token; never overwrites.', inputSchema: selection, annotations: { destructiveHint: false } }, wrap(async args => rpc('capture', args)));
server.registerTool('pencil_export', { title: 'Export', description: 'Export the selected nodes as PNG, JPEG, WEBP, PDF, HTML/CSS or HTML/Tailwind into the chosen existing absolute directory. The result lists the files actually written. Requires a participation token; never overwrites.', inputSchema: { ...selection, format: z.enum(['png', 'jpeg', 'webp', 'pdf', 'html-css', 'html-tailwind']) }, annotations: { destructiveHint: false } }, wrap(async args => rpc('export', args)));
server.registerTool('pencil_save', { title: 'Save', description: 'Save over the ORIGINAL .pen file. Waits for the calls in flight, briefly holds new calls, asks the engine to flush, and writes only if the persisted snapshot contains every completed change. Refused with SAVE_CONFLICT if the original changed on disk since it was loaded (then use pencil_save_as). The previous version is kept as a backup in the plugin data directory.', inputSchema: { sessionId: id, lease: id }, annotations: { destructiveHint: true, idempotentHint: true } }, wrap(async args => object(await rpc('save', args))));
server.registerTool('pencil_save_as', { title: 'Save As', description: 'Save into a NEW .pen file at the chosen absolute path, with the same consistency steps as pencil_save. Never overwrites and does not switch the session to the new file.', inputSchema: { sessionId: id, lease: id, path: z.string().min(1) }, annotations: { destructiveHint: false } }, wrap(async args => object(await rpc('save-as', args))));
server.registerTool('pencil_tools', { title: 'Native Pencil tools', description: 'List the native tool schemas published by this session\'s Pencil engine. Follow these schemas when using pencil_call.', inputSchema: { sessionId: id }, annotations: { readOnlyHint: true } }, wrap(async args => object(await rpc('schema', args))));
server.registerTool('pencil_status', { title: 'Session status', description: 'Report the document, editor connection, save state, unsaved changes, the agents in the session with their running calls, and the timestamps of recent calls.', inputSchema: { sessionId: id }, annotations: { readOnlyHint: true } }, wrap(async args => object(await rpc('status', args))));
server.registerTool('pencil_begin', { title: 'Join session', description: 'Join the shared design session and get your own non-exclusive participation token (lease). Other agents of the same session work on the same document at the same time: work on your own frames or components, re-read before editing, and never change nodes another agent owns. The plugin does not merge contradictory edits to the same object. The agent label is shown in the editor badge.', inputSchema: { sessionId: id, agent: z.string().min(1).max(200) } }, wrap(async args => object(await rpc('acquire', args))));
server.registerTool('pencil_call', {
  title: 'Call Pencil engine',
  description: 'Call a native Pencil tool through the session channel with your participation token. Calls from all agents are sent immediately, without a session-wide queue, and matched to their caller by request id; only a save in progress holds them briefly. The Pencil engine itself still runs execute snippets one at a time. Start with read_skill, then get_app_state. Asynchronous generation is not supported; after OUTCOME_UNKNOWN never replay the mutation.',
  inputSchema: { sessionId: id, lease: id, tool: z.enum(['execute', 'get_app_state', 'get_style', 'read_skill']), arguments: z.record(z.string(), z.unknown()).default({}), readOnly: z.boolean().optional().describe('Set true only for execute snippets that do not modify the document (Get/Print reads). Other execute calls set saveState to check-required until the engine saves.') }
}, wrap(async args => rpc('call', args)));
server.registerTool('pencil_end', { title: 'Leave session', description: 'Give back your participation token when your work is verified (refused while your own calls are running). Other agents are not interrupted. Leaving does not save: use pencil_save or pencil_save_as.', inputSchema: { sessionId: id, lease: id } }, wrap(async args => object(await rpc('release', args))));
await server.connect(new StdioServerTransport());

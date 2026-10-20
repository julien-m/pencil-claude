import { App } from '@modelcontextprotocol/ext-apps';
import { VERSION } from '../src/version.mjs';
const status = document.querySelector('#status');
const frame = document.querySelector('iframe');
let socket, port, connected = false, frameLoaded = false, config, timer, started = false;
let app;
const show = message => { status.textContent = message; };
function connectEditor() {
  if (!config || !frameLoaded || !socket || socket.readyState !== 1 || connected) return;
  port?.close();
  const channel = new MessageChannel(); port = channel.port1;
  port.onmessage = event => {
    const m = event.data;
    if (m.kind === 'ready') { connected = true; clearInterval(timer); show('Channel connected · loading the engine'); window.pencilPanelState = 'bridge-ready'; return; }
    if (m.kind === 'error') { show(`Pencil: ${m.message}`); return; }
    if (m.kind === 'request') {
      const payload = m.payload;
      if (payload?.data instanceof Uint8Array) payload.data = [...payload.data];
      socket.send(JSON.stringify({ ...m, kind: 'storage' }));
    } else if (m.kind === 'response') socket.send(JSON.stringify(m));
  };
  port.start();
  frame.contentWindow.postMessage({ type: 'pen:connect', theme: 'dark', fileURI: config.fileURI }, 'https://app.pen.dev', [channel.port2]);
}
function start(editor) {
  if (started) return; started = true;
  show('Connecting to the design session…');
  socket = new WebSocket(`ws://127.0.0.1:${editor.port}/editor?session=${encodeURIComponent(editor.sessionId)}&token=${encodeURIComponent(editor.editorToken)}`);
  socket.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.kind === 'activity') {
      const agents = m.status.agents ?? [];
      document.querySelector('#activity').textContent = agents.length
        ? `● ${agents.map(a => a.inFlight ? `${a.agent} (working)` : a.agent).join(' · ')} — ${agents.length} agent${agents.length > 1 ? 's' : ''} on this document`
        : 'No agent on this document';
      return;
    }
    if (m.kind === 'fatal') { show(m.message); return; }
    if (m.kind === 'config') {
      config = m; document.title = `${decodeURIComponent(m.fileURI.split('/').pop())} · Pencil`;
      connectEditor(); timer = setInterval(connectEditor, 500);
      setTimeout(() => { if (!connected) { clearInterval(timer); show('The Pencil bridge is not responding. Check its availability and sign-in.'); window.pencilPanelState = 'bridge-timeout'; } }, 15000);
    } else if (m.kind === 'request') {
      if (!port || !connected) { socket.send(JSON.stringify({ kind: 'response', id: m.id, error: { message: 'Pencil engine not connected' } })); return; }
      port.postMessage(m);
    } else if (m.kind === 'storage-response') {
      if (typeof m.id === 'string' && m.id.startsWith('draft-')) { if (m.error) show(`Local draft: ${m.error.message}`); return; }
      if (Array.isArray(m.payload)) m.payload = new Uint8Array(m.payload);
      if (m.error) show(`Storage: ${m.error.message}`);
      else if (m.payload === 2) show('External change: save refused, keep this view open');
      else show('Pencil · session connected');
      port?.postMessage({ ...m, kind: 'response' });
    }
  };
  socket.onclose = () => { clearInterval(timer); port?.close(); show('Channel disconnected · do not replay edits'); };
  socket.onerror = () => show('Local channel unreachable from this host');
}
frame.addEventListener('load', () => { frameLoaded = true; connectEditor(); });
frame.src = 'https://app.pen.dev/new?embed';
window.pencilPanelState = 'loading';
// Local view served by the loopback service (Claude Code), or an MCP Apps host.
if (window.pencilLocalView) start(window.pencilLocalView);
else {
  app = new App({ name: 'Pencil', version: VERSION }, { availableDisplayModes: ['fullscreen'] });
  app.ontoolresult = result => { if (result._meta?.editor) start(result._meta.editor); };
  app.connect().catch(e => show(`MCP Apps host: ${e.message}`));
}

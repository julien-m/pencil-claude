const config = new URLSearchParams(location.hash.slice(1));
const frame = document.querySelector('iframe');
const editorURL = new URL('https://app.pen.dev/new?embed');
const socket = new WebSocket(`ws://127.0.0.1:${config.get('brokerPort')}/editor?session=${encodeURIComponent(config.get('session'))}&token=${encodeURIComponent(config.get('token'))}`);
let port, fileURI, announced = false;
window.engineState = 'connecting';

function connect() {
  if (!announced || !fileURI || port) return;
  const channel = new MessageChannel(); port = channel.port1;
  port.onmessage = ({ data: message }) => {
    if (message.kind === 'ready') { socket.send(JSON.stringify({ kind: 'ready' })); window.engineState = 'ready'; return; }
    if (message.kind === 'error') { window.engineState = 'error'; return; }
    if (message.kind === 'request') {
      if (message.payload?.data instanceof Uint8Array) message.payload.data = [...message.payload.data];
      socket.send(JSON.stringify({ ...message, kind: 'storage' }));
    } else if (message.kind === 'notification') socket.send(JSON.stringify(message));
    else if (message.kind === 'response') socket.send(JSON.stringify(message));
  };
  port.start();
  frame.contentWindow.postMessage({ type: 'pen:connect', fileURI, theme: 'dark', clientName: 'Pencil background engine' }, editorURL.origin, [channel.port2]);
}
window.addEventListener('message', event => {
  let trusted = false;
  try {
    trusted = 'Origin' in globalThis ? Origin.from(event).isSameOrigin(Origin.from(editorURL)) : event.origin !== 'null' && new URL(event.origin).origin === editorURL.origin;
  } catch { return; }
  if (trusted && event.source === frame.contentWindow && event.data?.type === 'pen:ready') { announced = true; connect(); }
});
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.kind === 'config') { fileURI = message.fileURI; connect(); }
  else if (message.kind === 'request') port?.postMessage(message);
  else if (message.kind === 'storage-response') {
    if (Array.isArray(message.payload)) message.payload = new Uint8Array(message.payload);
    port?.postMessage({ ...message, kind: 'response' });
  } else if (message.kind === 'fatal') window.engineState = 'error';
};
socket.onclose = () => { window.engineState = 'disconnected'; port?.close(); };
frame.src = editorURL.href;

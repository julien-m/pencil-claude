// Development harness: a private broker and its local editor view for one disposable document.
import { startBroker } from './broker.mjs';
import { root } from './client.mjs';
import path from 'node:path';
const broker = await startBroker({ editorHtml: path.join(root, 'dist/editor.html') });
const response = await fetch(`http://127.0.0.1:${broker.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${broker.token}` }, body: JSON.stringify({ method: 'open', args: { path: process.argv[2], scope: 'preview' } }) });
const { result, error } = await response.json();
if (error) { console.error(error.message); await broker.close(); process.exit(1); }
console.log(JSON.stringify({ viewUrl: result.viewUrl, sessionId: result.sessionId, brokerPort: broker.port, brokerToken: broker.token }));
async function shutdown() { await broker.close(); process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

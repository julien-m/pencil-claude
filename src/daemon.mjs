import { startBroker } from './broker.mjs';
import { root } from './client.mjs';
import { editorWaitFromEnv } from './config.mjs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
const directory = process.argv[2];
const broker = await startBroker({ draftRoot: path.join(directory, 'drafts'), editorWait: editorWaitFromEnv(), editorHtml: path.join(root, 'dist/editor.html') });
await fs.writeFile(path.join(directory, 'connection.json'), JSON.stringify({ port: broker.port, token: broker.token, pid: process.pid }), { mode: 0o600 });
async function shutdown() { await fs.unlink(path.join(directory, 'connection.json')).catch(() => {}); await broker.close(); process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

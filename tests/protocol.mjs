import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-mcp-'));
const client = new Client({ name: 'pencil-protocol-test', version: '1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [process.env.PENCIL_TEST_SERVER ?? 'dist/server.mjs'], env: { ...process.env, CLAUDE_PLUGIN_DATA: dir } });
const timer = setTimeout(() => { console.error('Protocol test timeout'); process.exit(1); }, 10000);
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const opener = tools.find(x => x.name === 'pencil_open');
  assert.equal(opener._meta.ui.resourceUri, 'ui://pencil/editor-v1.html');
    assert(opener.inputSchema.required.includes('path'));
  assert(!tools.some(x => x.name === 'pencil_attach_file'));
  const ui = await client.readResource({ uri: 'ui://pencil/editor-v1.html' });
  assert(ui.contents[0].text.includes('Pencil editor'));
  assert.deepEqual(ui.contents[0]._meta.ui.csp.frameDomains, ['https://app.pen.dev']);
  const file = path.join(dir, 'scratch.pen'); await fs.writeFile(file, 'opaque');
  const opened = await client.callTool({ name: 'pencil_open', arguments: { path: file, scope: 'protocol' } });
  assert(opened.structuredContent.sessionId); assert(opened._meta.editor.editorToken); assert(!('editorToken' in opened.structuredContent));
  const view = await fetch(opened.structuredContent.viewUrl);
  assert.equal(view.status, 200); assert.equal(view.headers.get('referrer-policy'), 'no-referrer');
  assert((await view.text()).includes('window.pencilLocalView'));
  assert(JSON.parse(await fs.readFile(path.join(dir, 'connection.json'))).pid);
  const status = await client.callTool({ name: 'pencil_status', arguments: { sessionId: opened.structuredContent.sessionId } });
  assert.equal(status.structuredContent.connected, false);
  // After a service restart the MCP server reconnects instead of failing with a refused connection.
  const first = JSON.parse(await fs.readFile(path.join(dir, 'connection.json'))); process.kill(first.pid, 'SIGTERM');
  for (let i = 0; i < 100; i++) { try { process.kill(first.pid, 0); await new Promise(r => setTimeout(r, 20)); } catch { break; } }
  const after = await client.callTool({ name: 'pencil_status', arguments: { sessionId: opened.structuredContent.sessionId } });
  assert(after.isError && after.content[0].text.startsWith('SESSION_NOT_FOUND'), after.content[0].text);
  assert.notEqual(JSON.parse(await fs.readFile(path.join(dir, 'connection.json'))).pid, first.pid);
  console.log('MCP stdio: tool-driven opening, local view, UI resource/CSP, CLAUDE_PLUGIN_DATA, service restart, session open/status passed');
} finally {
  clearTimeout(timer); await client.close();
  try { const c = JSON.parse(await fs.readFile(path.join(dir, 'connection.json'))); process.kill(c.pid, 'SIGTERM'); } catch {}
  await fs.rm(dir, { recursive: true, force: true });
}

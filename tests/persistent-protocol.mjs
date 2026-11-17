import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
const directory = await mkdtemp(path.join(os.tmpdir(), 'pencil-persistent-protocol-'));
const client = new Client({ name: 'pencil-persistent-protocol', version: '1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/pencil.mjs'], env: { ...process.env, PENCIL_CONNECTION: path.join(directory, 'absent.json') }, stderr: 'pipe' });
transport.stderr.on('data', () => {});
try {
  await client.connect(transport, { timeout: 1000 });
  const { tools } = await client.listTools({}, { timeout: 1000 });
  for (const name of ['pencil_open', 'pencil_new', 'pencil_close', 'pencil_selection', 'pencil_documents']) assert(tools.some(tool => tool.name === name), name);
  assert(!tools.find(tool => tool.name === 'pencil_new').inputSchema.required?.includes('path'));
  assert(tools.find(tool => tool.name === 'pencil_call').inputSchema.properties.readOnly);
  const open = tools.find(tool => tool.name === 'pencil_open');
  const resource = await client.readResource({ uri: open._meta.ui.resourceUri }, { timeout: 1000 });
  assert.deepEqual(resource.contents[0]._meta.ui.csp.frameDomains, []);
  const scripts = [...resource.contents[0].text.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi)];
  assert(scripts.length); for (const script of scripts) new Script(script[1]);
  const offline = await client.callTool({ name: 'pencil_status', arguments: { sessionId: randomUUID() } }, undefined, { timeout: 1000 });
  assert(offline.isError); assert.match(offline.content[0].text, /supervised/);
  console.log('Persistent Pencil stdio: canonical entrypoint, offline discovery, close/selection/catalog/readOnly, bundled view passed');
} finally { await client.close(); await rm(directory, { recursive: true, force: true }); }

import { test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { VERSION } from '../src/version.mjs';
const json = async file => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
test('plugin, marketplace, package and runtime versions agree', async () => {
  const plugin = await json('.claude-plugin/plugin.json'), marketplace = await json('.claude-plugin/marketplace.json'), pkg = await json('package.json');
  expect(plugin.name).toBe('pencil'); expect(plugin.displayName).toBe('Pencil');
  expect(marketplace.plugins.find(p => p.name === 'pencil').source).toBe('./');
  for (const version of [plugin.version, marketplace.plugins[0].version, pkg.version]) expect(version).toBe(VERSION);
});
test('the MCP server runs from the installed plugin root only', async () => {
  const { mcpServers } = await json('.mcp.json');
  expect(mcpServers.pencil.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/server.mjs']);
});

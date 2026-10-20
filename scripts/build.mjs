import { build } from 'esbuild';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const result = await build({ entryPoints: ['web/editor.mjs'], bundle: true, format: 'iife', platform: 'browser', write: false, minify: true, metafile: true });
const builds = [result];
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await mkdir('dist', { recursive: true });
for (const name of ['server', 'daemon']) builds.push(await build({ entryPoints: [`src/${name}.mjs`], outfile: `dist/${name}.mjs`, bundle: true, format: 'esm', platform: 'node', target: 'node22', metafile: true, banner: { js: 'import { createRequire as createPluginRequire } from "node:module"; const require = createPluginRequire(import.meta.url);' } }));
await writeFile('dist/editor.html', `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pencil</title><style>html,body{margin:0;height:100%;background:#161616;color:#ddd;font:13px system-ui}body{display:flex;flex-direction:column}header{padding:8px 12px;min-height:18px;border-bottom:1px solid #333}#activity{color:#8edab1}iframe{flex:1;border:0;width:100%;background:#161616}</style><header id="status" role="status">Opening Pencil…</header><header id="activity" aria-live="polite">Agents idle · document available</header><iframe title="Pencil editor" allow="clipboard-read; clipboard-write"></iframe><script>${js}</script></html>`);
// Preserve the licenses of the packages actually included in the bundles.
const packages = new Map();
for (const bundle of builds) for (const input of Object.keys(bundle.metafile.inputs)) {
  if (!input.startsWith('node_modules/')) continue;
  let directory = path.dirname(input);
  while (directory !== 'node_modules' && directory !== '.') {
    try {
      const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version) { packages.set(`${pkg.name}@${pkg.version}`, { directory, pkg }); break; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    directory = path.dirname(directory);
  }
}
let notices = '# Third-party notices\n\nGenerated from the dependencies included in the distributed bundles. The hosted Pencil engine is not included.\n';
for (const [name, { directory, pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  notices += `\n## ${name}\n\nLicense: ${pkg.license ?? 'See package license below'}.\n`;
  for (const filename of (await readdir(directory)).sort()) {
    if (/^(license|licence|notice)([.-]|$)/i.test(filename)) notices += `\n### ${filename}\n\n${await readFile(path.join(directory, filename), 'utf8')}\n`;
  }
}
await writeFile('THIRD-PARTY-NOTICES.md', notices.split('\n').map(line => line.trimEnd()).join('\n').trimEnd() + '\n');
console.log('Pencil bundles and third-party notices built');

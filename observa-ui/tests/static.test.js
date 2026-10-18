// Source checks: no sample data, no Grafana redirects, module wiring and imports are consistent.
// Reads files only; no database or network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const walk = (dir, ext = /\.js$/) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name), ext) : ext.test(d.name) ? [path.join(dir, d.name)] : []));
const srcFiles = walk('src');
const uiFiles = walk('web/src', /\.(ts|tsx)$/); // the React web UI

test('no demo / sample data generator in the product', () => {
  assert.equal(fs.existsSync(path.join(root, 'src/demo.js')), false, 'src/demo.js must be deleted');
  for (const f of [...srcFiles, ...uiFiles]) {
    const s = read(f);
    assert.doesNotMatch(s, /from ['"]\.\/demo\.js['"]|demoServices|demoLogs|demoTrace|buildTrace\(|demoBadge|DEMO DATA/, `${f} still has demo code`);
    assert.doesNotMatch(s, /Math\.random\(\)\s*\*/, `${f} generates random numbers (only random ids are allowed)`);
  }
});

test('data sources only allow live mode; deployment templates have no demo defaults', () => {
  assert.doesNotMatch(read('src/datasources.js'), /modes:\s*\[[^\]]*'demo'/);
  assert.doesNotMatch(read('src/config.js'), /_MODE'/);
  for (const f of ['../docker-compose.yml', '../.env.example']) {
    if (fs.existsSync(path.join(root, f))) assert.doesNotMatch(read(f), /(LOKI|TEMPO|SERVICES)_MODE/, `${f} still sets a demo mode`);
  }
});

test('no user-facing Grafana links or redirects in the UI', () => {
  for (const f of uiFiles) {
    const s = read(f);
    assert.doesNotMatch(s, /grafanaUrl|Open in Grafana|Open Grafana|href:[^,]*\/grafana/, `${f} links to Grafana`);
  }
  assert.doesNotMatch(read('src/api.js'), /grafanaUrl/);
});

test('the old plain-JS UI is gone; the server serves the React build', () => {
  assert.equal(fs.existsSync(path.join(root, 'public/js')), false, 'public/js (old UI) must be removed');
  assert.match(read('src/server.js'), /web\/dist/, 'server.js must serve web/dist');
});

test('theme colours: page code uses theme tokens, not hard-coded hex colours', () => {
  for (const f of uiFiles.filter((x) => x.includes('pages') && !x.endsWith('DataSources.tsx'))) { // data source brand tints are allowed
    assert.doesNotMatch(read(f), /['"]#[0-9a-fA-F]{6}['"]/, `${f} has a hard-coded colour`);
  }
});

test('module wiring: every page module and API guard names a real module', async () => {
  const { MODULE_IDS } = await import('../src/modules.js');
  const reg = read('web/src/app/routes.ts');
  const used = [...reg.matchAll(/module: '(\w+)'/g)].map((m) => m[1]);
  assert.ok(used.length >= 8, 'registry should tag module pages');
  for (const id of used) assert.ok(MODULE_IDS.includes(id), `registry uses unknown module "${id}"`);
  const guards = [...read('src/api.js').matchAll(/requireModule\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]));
  assert.ok(guards.length >= 8, 'API should guard module routes');
  for (const id of guards) assert.ok(MODULE_IDS.includes(id), `API guard uses unknown module "${id}"`);
  for (const p of ["'/logs'", "'/traces'", "'/services'", "'/dashboards'", "'/prom'"]) {
    assert.match(read('src/api.js'), new RegExp(`api\\.use\\(${p.replace(/\//g, '\\/')}, requireModule`), `${p} has no module guard`);
  }
});

test('shared pages (Overview, Data Sources, Settings) have no module, so they are always reachable', () => {
  const reg = read('web/src/app/routes.ts');
  for (const p of ['/overview', '/datasources', '/settings']) {
    const line = reg.split('\n').find((l) => l.includes(`path: '${p}'`));
    assert.ok(line, `${p} must be in routes.ts`);
    const item = line.slice(line.indexOf(`path: '${p}'`)).split('}')[0];
    assert.doesNotMatch(item, /module:/, `${p} must not belong to a module`);
  }
});

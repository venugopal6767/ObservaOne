// nginx reads "{" in an unquoted regex location as the start of a block and refuses to start
// ("unknown directive \"20}/metrics$\""). Regression for 2026-10-19: such regexes must be quoted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

for (const f of ['../nginx/nginx.conf', '../gateway/nginx.conf']) {
  test(`${f}: regex locations with { } are quoted`, () => {
    const path = new URL(f, new URL('../', import.meta.url));
    if (!fs.existsSync(path)) return;
    const bad = fs.readFileSync(path, 'utf8').split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /^\s*location\s+~\*?\s+[^"'\s][^\s]*\{\d/.test(l));
    assert.deepEqual(bad.map(([n, l]) => `${n}: ${l.trim()}`), []);
  });
}

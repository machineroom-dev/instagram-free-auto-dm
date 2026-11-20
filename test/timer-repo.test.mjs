import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plistXml, cronLine, withOurLine, withoutOurLine, timer, CRON_TAG, LABEL } from '../src/timer.mjs';

const args = { nodePath: '/opt/node/bin/node', cliPath: "/home/demo/it's here/cli.mjs", workDir: "/home/demo/it's here", logPath: "/home/demo/it's here/.state/timer.log" };

test('launchd plist: poll every 300 s, at load, from the repo folder, logging to .state', () => {
  const x = plistXml(args);
  assert.match(x, new RegExp(`<string>${LABEL}</string>`));
  assert.match(x, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(x, /<string>poll<\/string>/);
  assert.match(x, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(x, /it's here\/\.state\/timer\.log/);
});

test('cron: one tagged line, quoted paths, replaced on reinstall, removed cleanly', () => {
  const line = cronLine(args);
  assert.match(line, /^\*\/5 \* \* \* \* cd '/);
  assert.ok(line.includes(`'/home/demo/it'\\''s here'`), line);
  assert.ok(line.endsWith(CRON_TAG));
  const mine = '0 3 * * * backup.sh\n';
  const once = withOurLine(mine, line);
  const twice = withOurLine(once, line);
  assert.equal(twice, once);
  assert.equal(twice.split('\n').filter((l) => l.includes(CRON_TAG)).length, 1);
  assert.equal(withoutOurLine(twice), '0 3 * * * backup.sh');
});

test('timer() on Linux talks to crontab only through the injected spawn', () => {
  let written = null;
  const spawn = (cmd, a, opts) => (a[0] === '-l' ? { status: 0, stdout: '0 3 * * * backup.sh\n' } : (written = opts.input, { status: 0 }));
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'comment-dm-timer-')), '.state', 'timer.log');
  assert.match(timer('install', { ...args, logPath, platform: 'linux', spawn }), /installed/);
  assert.match(written, /backup\.sh\n\*\/5 .*poll/);
  assert.throws(() => timer('install', { ...args, platform: 'win32', spawn }), /Cloudflare Worker/);
});

test('one wrangler version everywhere', () => {
  const pkg = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const cli = fs.readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8');
  const versions = new Set([...pkg.matchAll(/wrangler@(\d+\.\d+\.\d+)/g), ...cli.matchAll(/wrangler@(\d+\.\d+\.\d+)/g)].map((x) => x[1]));
  assert.equal(versions.size, 1, [...versions].join(', '));
});

test('the Worker is cron-only, starts in dry-run, and has a KV binding named STATE', () => {
  const w = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const j = JSON.parse(w.replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(j.triggers.crons, ['*/5 * * * *']);
  assert.equal(j.workers_dev, false);
  assert.equal(j.vars.MODE, 'dry-run');
  assert.equal(j.kv_namespaces[0].binding, 'STATE');
  const idx = fs.readFileSync(new URL('../worker/index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(idx, /async fetch\(/, 'no fetch handler: no public surface');
});

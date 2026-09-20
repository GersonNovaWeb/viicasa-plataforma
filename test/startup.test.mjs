import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';

// Copy the real entry unchanged and substitute only its application module.
// This exercises Hostinger's require() without contacting Firebase or Stripe.
async function runEntry(t, source, useRequire) {
  const directory = await mkdtemp(join(tmpdir(), 'viicasa-startup-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await mkdir(join(directory, 'viicasa-frontend-prototype'));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'server.js'), await readFile(new URL('../server.js', import.meta.url)));
  await writeFile(join(directory, 'viicasa-frontend-prototype/server.mjs'), source);
  const args = useRequire ? ['--input-type=commonjs', '-e', "require('./server.js')"] : ['server.js'];
  const result = spawnSync(process.execPath, args, {
    cwd: directory, encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: {...process.env, NODE_OPTIONS: ''},
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

for (const useRequire of [true, false]) {
  const loader = useRequire ? 'Hostinger require()' : 'node server.js';
  test(`${loader} starts an asynchronous ESM application`, async t => {
    const result = await runEntry(t, "await new Promise(resolve => setTimeout(resolve, 20)); console.log('APPLICATION_READY');", useRequire);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /APPLICATION_READY/);
    assert.doesNotMatch(result.stderr, /ERR_REQUIRE_ASYNC_MODULE/);
  });
  test(`${loader} reports initialization failures with a nonzero exit`, async t => {
    const result = await runEntry(t, "await Promise.resolve(); throw new Error('STARTUP_TEST_FAILURE');", useRequire);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /No se pudo iniciar VIICASA:/);
    assert.match(result.stderr, /STARTUP_TEST_FAILURE/);
    assert.doesNotMatch(result.stderr, /ERR_REQUIRE_ASYNC_MODULE/);
  });
}

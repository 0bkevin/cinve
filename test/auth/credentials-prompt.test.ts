import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isObj } from '../../src/core.js';

test('real PTY: multiline paste, separate entry and cancellation never echo credentials and restore terminal', t => {
  const r = spawnSync('python3', ['test/helpers/terminal-probe.py', process.execPath], { encoding: 'utf8', timeout: 30000 });
  if (isObj(r.error) && r.error.code === 'ENOENT') { t.skip('Python 3 required for the POSIX PTY probe'); return; }
  assert.equal(r.status, 0, r.stderr);
  for (const result of JSON.parse(r.stdout)) {
    assert.equal(result.secret_visible, false, result.mode); assert.equal(result.email_visible, false, result.mode);
    assert.equal(result.echo_restored, true, result.mode);
    assert.equal(result.exit_code, ['paste', 'separate'].includes(result.mode) ? 0 : 1);
  }
});

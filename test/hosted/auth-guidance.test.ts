import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedAuthInstructions } from '../../src/hosted/auth-guidance.js';
import { installGuide } from '../../src/web/install.js';

test('served instructions never ask agents to download or run code to recover a stale connection', () => {
  for (const s of [hostedAuthInstructions, installGuide('https://example.test')]) {
    assert.doesNotMatch(s, /codex-client|\.mjs|node RUTA|node \/path/);
    assert.match(s, /config\/mcpServer\/reload/);
  }
  assert.match(hostedAuthInstructions, /abrir una conversación nueva o reconectar Cinve/);
  assert.match(installGuide('https://example.test'), /open a new conversation or reconnect Cinve/);
});
test('served instructions require telling the user and getting approval before running anything locally', () => {
  const es = hostedAuthInstructions, en = installGuide('https://example.test');
  assert.match(es, /nunca ejecutes comandos en el equipo del usuario sin antes explicarle/);
  assert.match(es, /codex mcp login cinve[^.]*ejecutarlo solo con su aprobación/);
  assert.match(en, /never run a command, or download or run code, on the user's\s+computer without first telling the user/);
  assert.match(en, /run it\s+only after they approve/);
  // No wording that tells the agent to proceed without the user.
  for (const s of [es, en]) assert.doesNotMatch(s, /continue automatically|NO te detengas|descarga e inspecciona/);
});
test('connection guidance stays short because every client receives it with auth_required', () => {
  assert.ok(hostedAuthInstructions.length <= 1700, String(hostedAuthInstructions.length));
});

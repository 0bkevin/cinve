import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedAuthInstructions } from '../src/hosted-auth-guidance.js';
import { installGuide } from '../src/install.js';

test('served instructions require telling the user and getting approval before running anything locally', () => {
  const served = hostedAuthInstructions('https://example.test'), en = installGuide('https://example.test');
  assert.match(served, /never run commands on the user's computer without first explaining/);
  assert.match(served, /codex mcp login cinve[^.]*run it only with their approval/);
  assert.match(en, /never run a command on the user's computer without first\s+telling the user/);
  assert.match(en, /run it only\s+after they approve/);
  // No wording that tells the agent to proceed without the user.
  for (const s of [served, en]) assert.doesNotMatch(s, /continue automatically|do not stop|download and inspect|NO te detengas|descarga e inspecciona/);
});

test('served instructions never ask agents to download or run code', () => {
  const served = hostedAuthInstructions('https://example.test'), en = installGuide('https://example.test');
  for (const s of [served, en]) {
    assert.doesNotMatch(s, /\.mjs|\bnode \S+|codex-client|companion|auxiliar/i);
  }
  assert.match(served, /never download or run code/);
  assert.match(en, /never requires downloading or running\s+code/);
});

test('served instructions fall back to a native refresh or a new conversation when still anonymous', () => {
  for (const s of [hostedAuthInstructions('https://example.test'), installGuide('https://example.test')]) {
    assert.match(s, /config\/mcpServer\/reload/);
    assert.match(s, /client_authorized/);
  }
});

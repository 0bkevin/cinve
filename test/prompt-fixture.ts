import { readCredentials } from '../src/credentials-prompt.js';
try {
  const result = await readCredentials();
  if (result.username !== 'person@example.test' || result.password !== 'SYNTHETIC_PASTE_SECRET') throw new Error('Unexpected fixture input');
  console.log('ACCEPTED');
} catch { console.log('CANCELLED'); process.exitCode = 1; }

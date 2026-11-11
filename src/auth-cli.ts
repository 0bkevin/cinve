#!/usr/bin/env node
import { AuthProvider, login, SessionStore } from './auth.js';
import { readCredentials } from './credentials-prompt.js';

async function main() {
  const [command, rawProvider, ...extra] = process.argv.slice(2);
  if (!['login', 'logout', 'status'].includes(command ?? '') || extra.length || (rawProvider && !AuthProvider.safeParse(rawProvider).success) || (command !== 'status' && !rawProvider)) {
    throw new Error('Usage: node dist/auth-cli.js login|logout|status [cinex|cinesunidos|supercines]');
  }
  const store = new SessionStore();
  if (command === 'status') {
    for (const p of rawProvider ? [AuthProvider.parse(rawProvider)] : AuthProvider.options) console.log(JSON.stringify(await store.status(p)));
    return;
  }
  const provider = AuthProvider.parse(rawProvider);
  if (command === 'logout') { await store.remove(provider); console.log(`Local ${provider} session removed. The remote token may remain valid until it expires.`); return; }
  let { username, password } = await readCredentials();
  try {
    const result = await login(provider, username, password, store);
    console.log(`The ${provider} session was saved locally. MCP can use it without restarting.`);
    if (result.profile_update_requested) console.log('Cinex requests a profile update on its website. Some operations may be limited.');
  } finally { password = ''; }
}
main().catch(e => { console.error(e instanceof Error ? e.message : 'Could not complete authentication.'); process.exitCode = 1; });

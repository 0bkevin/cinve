#!/usr/bin/env node
import { AuthProvider, login, SessionStore } from './auth.js';
import { readCredentials } from './credentials-prompt.js';

async function main() {
  const [command, rawProvider, ...extra] = process.argv.slice(2);
  if (!['login', 'logout', 'status'].includes(command ?? '') || extra.length || (rawProvider && !AuthProvider.safeParse(rawProvider).success) || (command !== 'status' && !rawProvider)) {
    throw new Error('Uso: node dist/auth-cli.js login|logout|status [cinex|cinesunidos]');
  }
  const store = new SessionStore();
  if (command === 'status') {
    for (const p of rawProvider ? [AuthProvider.parse(rawProvider)] : AuthProvider.options) console.log(JSON.stringify(await store.status(p)));
    return;
  }
  const provider = AuthProvider.parse(rawProvider);
  if (command === 'logout') { await store.remove(provider); console.log(`Sesión local de ${provider} eliminada. El token remoto puede seguir válido hasta que expire.`); return; }
  let { username, password } = await readCredentials();
  try {
    const result = await login(provider, username, password, store);
    console.log(`Sesión de ${provider} guardada localmente. El MCP puede usarla sin reiniciar.`);
    if (result.profile_update_requested) console.log('Cinex solicita actualizar el perfil en su sitio. Algunas operaciones pueden estar limitadas.');
  } finally { password = ''; }
}
main().catch(e => { console.error(e instanceof Error ? e.message : 'No se pudo completar la autenticación.'); process.exitCode = 1; });

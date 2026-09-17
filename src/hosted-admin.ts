#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { HostedUsers, databasePool, transaction } from './hosted-store.js';
import { ConnectionLinks } from './hosted-links.js';
async function main() {
  const [command, id, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Argumentos no válidos.');
  const pool = databasePool(), users = new HostedUsers(pool);
  try {
    if (command === 'migrate' && !id) {
      const sql = await readFile(new URL('../migrations/001_hosted.sql', import.meta.url), 'utf8');
      await transaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(167493821)');
        await client.query(sql);
      });
      console.log('Base de datos preparada.');
    } else if (command === 'issue' && !id) {
      console.log(JSON.stringify(await users.issue())); // Operator-only, displayed once.
    } else if (command === 'revoke' && id) { await users.revoke(id); console.log('Acceso revocado.'); }
    else if (command === 'cleanup' && !id) { await new ConnectionLinks(pool).cleanup(); console.log('Registros vencidos eliminados.'); }
    else throw new Error('Uso: hosted-admin migrate | issue | revoke <user-id> | cleanup');
  } finally { await pool.end(); }
}
main().catch(() => { console.error('No se pudo administrar el acceso. Revisa el comando y DATABASE_URL.'); process.exitCode = 1; });

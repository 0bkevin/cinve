#!/usr/bin/env node
import { migrationSql } from './migrations.js';
import { HostedUsers, databasePool, transaction } from './hosted-store.js';
import { ConnectionLinks } from './hosted-links.js';
async function main() {
  const [command, id, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Invalid arguments.');
  const pool = databasePool(command === 'migrate' ? process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL : process.env.DATABASE_URL), users = new HostedUsers(pool);
  try {
    if (command === 'migrate' && !id) {
      const sql = await migrationSql();
      await transaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(167493821)');
        await client.query(sql);
      });
      console.log('Database is ready.');
    } else if (command === 'issue' && !id) {
      console.log(JSON.stringify(await users.issue())); // Operator-only, displayed once.
    } else if (command === 'revoke' && id) { await users.revoke(id); console.log('Access revoked.'); }
    else if (command === 'cleanup' && !id) { await new ConnectionLinks(pool).cleanup(); console.log('Expired records deleted.'); }
    else throw new Error('Usage: hosted-admin migrate | issue | revoke <user-id> | cleanup');
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Could not administer access. Check the command and DATABASE_URL.'); process.exitCode = 1; });

// HTTPS fallback for operator networks that block Postgres TCP connections.
import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
try {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).hostname.endsWith('.neon.tech')) throw new Error('Neon URL required');
  const sql = neon(url);
  const migration = await readFile(new URL('../migrations/001_hosted.sql', import.meta.url), 'utf8');
  // This migration contains plain DDL only, without functions or quoted semicolons.
  const statements = migration.split(';').map(s => s.trim()).filter(Boolean);
  await sql.transaction([sql.query('SELECT pg_advisory_xact_lock(167493821)'), ...statements.map(s => sql.query(s))]);
  console.log('Database migration completed over HTTPS.');
} catch { console.error('Database migration failed. Check DATABASE_URL and connectivity.'); process.exitCode = 1; }

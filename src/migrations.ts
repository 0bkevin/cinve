import { readFile } from 'node:fs/promises';

// Explicit order; each migration is idempotent and runs under the existing lock.
export async function migrationSql() {
  return (await Promise.all(['001_hosted.sql', '002_oauth.sql', '003_oauth_app_retention.sql'].map(name =>
    readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')))).join('\n');
}

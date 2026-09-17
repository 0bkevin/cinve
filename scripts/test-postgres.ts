import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const exec = promisify(execFile);
let directory: string | undefined;
try {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    directory = await mkdtemp(join(tmpdir(), 'cinev-pg-'));
    await exec('initdb', ['-D', join(directory, 'data'), '--auth=trust', '--no-locale', '--encoding=UTF8']);
    await exec('pg_ctl', ['-D', join(directory, 'data'), '-l', join(directory, 'postgres.log'), '-o', `-k ${directory} -h ''`, '-w', 'start']);
    url = `postgresql://${encodeURIComponent(userInfo().username)}@localhost/postgres?host=${encodeURIComponent(directory)}`;
  }
  const files = (await readdir('test')).filter(f => f.endsWith('.test.ts')).map(f => `test/${f}`);
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: url } });
  process.exitCode = await new Promise<number>(resolve => child.on('exit', code => resolve(code ?? 1)));
} catch {
  console.error('Las pruebas requieren PostgreSQL local (initdb/pg_ctl) o TEST_DATABASE_URL. No uses una base de datos de producción.');
  process.exitCode = 1;
} finally {
  if (directory) {
    await exec('pg_ctl', ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop']).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

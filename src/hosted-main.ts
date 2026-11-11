import { createHostedApp } from './hosted.js';
import { databasePool } from './hosted-store.js';

async function main() {
  const { CINEV_PUBLIC_URL, CINEV_ENCRYPTION_KEY } = process.env;
  if (!CINEV_PUBLIC_URL || !/^[a-f0-9]{64}$/.test(CINEV_ENCRYPTION_KEY ?? '')) throw new Error('Set CINEV_PUBLIC_URL and CINEV_ENCRYPTION_KEY (64 hexadecimal characters).');
  const pool = databasePool();
  const app = await createHostedApp({ publicUrl: CINEV_PUBLIC_URL, pool, key: Buffer.from(CINEV_ENCRYPTION_KEY!, 'hex'), trustedVercelProxy: process.env.VERCEL === '1', cleanupSecret: process.env.CRON_SECRET });
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  app.server.listen(port, '0.0.0.0', () => console.log('Cinve hosted server ready.'));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    app.server.close(() => { void pool.end(); }); app.server.closeIdleConnections();
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
main().catch(() => { console.error('Could not start the Cinve hosted server. Check the environment variables and database.'); process.exitCode = 1; });

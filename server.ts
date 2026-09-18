import { serveInstall } from './src/install.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHostedApp } from './src/hosted.js';
import { databasePool } from './src/hosted-store.js';
let app: ReturnType<typeof createHostedApp> | undefined;
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    if (serveInstall(req, res, process.env.CINEV_PUBLIC_URL ?? 'https://cinev-indol.vercel.app')) return;
    if (!app) {
      const { CINEV_PUBLIC_URL, CINEV_ENCRYPTION_KEY } = process.env;
      if (!CINEV_PUBLIC_URL || !/^[a-f0-9]{64}$/.test(CINEV_ENCRYPTION_KEY ?? '')) throw new Error('Missing configuration');
      app = createHostedApp({ publicUrl: CINEV_PUBLIC_URL, pool: databasePool(), key: Buffer.from(CINEV_ENCRYPTION_KEY!, 'hex'),
        trustedVercelProxy: true, cleanupSecret: process.env.CRON_SECRET });
    }
    await (await app).handler(req, res);
  } catch {
    app = undefined;
    if (!res.headersSent) { res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"error":"Servicio temporalmente no disponible."}'); }
  }
}

import { serveInstall } from './src/install.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHostedApp } from './src/hosted.js';
import { databasePool } from './src/hosted-store.js';
const apps = new Map<string, ReturnType<typeof createHostedApp>>();
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const configuredOrigin = process.env.CINEV_PUBLIC_URL || 'https://cinve.kevinbravo.com';
  // Existing MCP clients retain their issuer and account sessions on the old address.
  const publicOrigin = req.headers.host === 'cinve.vercel.app' ? 'https://cinve.vercel.app' : configuredOrigin;
  try {
    if (serveInstall(req, res, publicOrigin)) return;
    let app = apps.get(publicOrigin);
    if (!app) {
      const { CINEV_PUBLIC_URL, CINEV_ENCRYPTION_KEY } = process.env;
      if (!CINEV_PUBLIC_URL || !/^[a-f0-9]{64}$/.test(CINEV_ENCRYPTION_KEY ?? '')) throw new Error('Missing configuration');
      app = createHostedApp({ publicUrl: publicOrigin, pool: databasePool(), key: Buffer.from(CINEV_ENCRYPTION_KEY!, 'hex'),
        trustedVercelProxy: true, cleanupSecret: process.env.CRON_SECRET });
      apps.set(publicOrigin, app);
    }
    await (await app).handler(req, res);
  } catch {
    apps.delete(publicOrigin);
    if (!res.headersSent) { res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"error":"Servicio temporalmente no disponible."}'); }
  }
}

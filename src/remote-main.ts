#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createRemoteServer, remoteConfig } from './remote.js';
async function main() {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error('Uso: node dist/remote-main.js /ruta/privada/cinev.json');
  const config = await remoteConfig(path);
  const handle = serveStdio(() => createRemoteServer(config), { onerror: () => console.error('Cinev: no se pudo conectar al servidor alojado.') });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void handle.close().finally(() => process.exit(0)); });
}
main().catch(() => { console.error('Cinev: revisa el archivo privado de conexión y la disponibilidad del servidor.'); process.exitCode = 1; });

#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createRemoteServer, remoteConfig } from './remote.js';
async function main() {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error('Usage: node dist/remote-main.js /private/path/cinev.json');
  const config = await remoteConfig(path);
  const handle = serveStdio(() => createRemoteServer(config), { onerror: () => console.error('Cinve: could not connect to the hosted server.') });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void handle.close().finally(() => process.exit(0)); });
}
main().catch(() => { console.error('Cinve: check the private connection file and server availability.'); process.exitCode = 1; });

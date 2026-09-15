#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

const handle = serveStdio(() => createServer(), { onerror: () => console.error('cinev: error de transporte MCP.') });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void handle.close().finally(() => process.exit(0));
});

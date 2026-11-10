import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../src/mcp/server.js';
import { CinemaService } from '../src/service.js';
import { HttpClient } from '../src/http/client.js';
import { mockFetch, EmptySessionStore } from './fixtures.js';
serveStdio(() => createServer(new CinemaService(new HttpClient(mockFetch, 15000, new EmptySessionStore()))));

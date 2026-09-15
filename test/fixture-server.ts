import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../src/server.js';
import { CinemaService } from '../src/service.js';
import { HttpClient } from '../src/http.js';
import { mockFetch, EmptySessionStore } from './fixtures.js';
serveStdio(() => createServer(new CinemaService(new HttpClient(mockFetch, 15000, new EmptySessionStore()))));

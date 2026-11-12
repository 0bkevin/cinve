import { SeatResult } from '../seats/schema.js';
import { seatInstructions } from '../seats/guidance.js';
import { MapTooLarge, renderSeatMapPng, renderSeatMapSvg } from '../seats/image.js';
import { cinepicVenueName } from '../providers/cinepic/sites.js';
import { hostedAuthInstructions } from '../hosted/auth-guidance.js';
import { serverInstructions } from '../agent-instructions.js';
import { McpServer } from '@modelcontextprotocol/server';
import type { ServerContext } from '@modelcontextprotocol/server';
import type { CallOptions } from '../http/read-context.js';
import * as z from 'zod';
import { DateInput, Id, Provider, idString, outputSchema } from '../core.js';
import type { Operation, Query } from '../core.js';
import { AuthProvider } from '../auth/sessions.js';
import type { AuthProviderId } from '../auth/sessions.js';
import { capabilities, CinemaService } from '../service.js';

const paging = {
  refresh: z.boolean().optional().describe('true: queries the provider without the local cache and requests HTTP revalidation. Does not guarantee that the provider has updated its content.'),
  query: z.string().trim().min(1).max(120).optional().describe('Filters by name, ignoring accents and case.'),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
};
/** get_auth_status output. */
export const AuthStatusResult = z.object({ connection: z.object({ mode: z.enum(['local', 'hosted']), client_authorized: z.boolean() }), providers: z.array(z.object({ provider: AuthProvider, status: z.string(), expires_at: z.string().nullable(), login_command: z.string(), remote_validity_checked: z.literal(false) })) });
const provider = Provider.describe('Cinema provider; get its capabilities and limitations with list_providers.');
const cinemaIdText = 'Venue ID returned by list_cinemas for the same provider. Do not mix IDs across providers. If the venue includes code_status, use cinema_id only when it is verified; directory-* IDs cannot be queried.';
const sessionIdText = 'Showtime ID returned by get_showtimes for the same provider.';
const cinemaId = Id.describe(cinemaIdText);
const movieId = Id.describe('Movie ID returned by list_movies for the same provider; optional for Cinex when querying a whole venue.');
const sessionId = Id.describe(sessionIdText);
// A missing required ID gets the same guidance as the provider-specific checks.
const missing = (field: string, source: string) => (issue: { input?: unknown }) => issue.input === undefined ? `${field} is required; get it with ${source}.` : undefined;
const requiredCinemaId = idString({ error: missing('cinema_id', 'list_cinemas') }).describe(cinemaIdText);
const requiredSessionId = idString({ error: missing('session_id', 'get_showtimes') }).describe(sessionIdText);
const schema = z.object({
  provider,
  city: z.string().trim().min(1).max(80).optional().describe('City name as returned by list_cities for the same provider (e.g. Caracas); accents and case are ignored for Cines Unidos.'),
  cinema_id: cinemaId.optional(), movie_id: movieId.optional(), session_id: sessionId.optional(),
  date: DateInput.optional().describe('YYYY-MM-DD; defaults to today in America/Caracas for Cinepic/Cines Unidos movies and showtimes and for Cinex, Supercines and Gran Cine showtimes.'),
  near: z.string().trim().min(1).max(120).optional().describe('Where the user is: a neighbourhood or town (Chacao, Las Mercedes, Naguanagua, Lechería) or "lat,lng". Sorts venues nearest first and adds distance_km; with it Cines Unidos needs no city.'),
  ...paging,
}).strict();

/**
 * Strict function-calling adapters (OpenAI strict mode, some Gemini bridges)
 * make every optional property required-but-nullable, so models send
 * `"query": null` for "not given". Treat a null argument as an absent one.
 * Only declared properties are dropped: an unknown key, null or not, must
 * still reach .strict() and fail. The published JSON Schema is unchanged.
 */
function absentNulls(shape: object) {
  const known = new Set(Object.keys(shape));
  return (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key, v]) => !(v === null && known.has(key))))
    : value;
}

export function inputSchema(op: Operation): z.ZodType<Query> {
  // Keep each tool's arguments small and expose conditional requirements in validation.
  const base = op === 'cities' ? schema.pick({ provider: true, offset: true, limit: true, query: true, refresh: true })
    : op === 'cinemas' ? schema.pick({ provider: true, city: true, near: true, offset: true, limit: true, query: true, refresh: true })
    // Every provider needs these, so the published schema marks them required;
    // provider-specific requirements stay in the descriptions and validation.
    : op === 'prices' ? schema.pick({ provider: true, movie_id: true, offset: true, limit: true, refresh: true }).extend({ cinema_id: requiredCinemaId, session_id: requiredSessionId,
      date: DateInput.optional().describe('Supercines only: showtime date (YYYY-MM-DD), the same one used in get_showtimes; defaults to today in America/Caracas. Its prices vary by day.') })
    : op === 'concessions' ? schema.pick({ provider: true, query: true, offset: true, limit: true, refresh: true }).extend({ cinema_id: requiredCinemaId })
    : schema.omit({ session_id: true, near: true });
  return z.preprocess(absentNulls(base.shape), base.superRefine((q: Query, ctx) => {
    const need = (field: 'city' | 'cinema_id' | 'movie_id' | 'session_id') => {
      // Cinepic has two fixed venues: naming them saves the model a discovery call.
      const hint = q.provider === 'cinepic' && field === 'cinema_id' ? ' Use 123300 (Candelaria) or 123301 (VVIP Lido).' : '';
      if (!q[field]) ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required for ${q.provider}/${op}.${hint}` });
    };
    if (q.provider === 'cinepic') {
      if (q.city && op !== 'cinemas') ctx.addIssue({ code: 'custom', path: ['city'], message: 'For Cinepic, use cinema_id as the query context.' });
      if (!['cities', 'cinemas'].includes(op)) need('cinema_id');
      if (q.cinema_id && !['123300', '123301'].includes(q.cinema_id)) ctx.addIssue({ code: 'custom', path: ['cinema_id'], message: 'Cinepic: use 123300 or 123301.' });
      if (op === 'prices') { need('movie_id'); need('session_id'); }
    }
    if (q.provider === 'cinesunidos') {
      if (['movies', 'showtimes'].includes(op) || (op === 'cinemas' && !q.near)) need('city');
      if (['prices', 'concessions'].includes(op)) need('cinema_id');
      if (op === 'prices') need('session_id');
    }
    if (q.provider !== 'supercines' && op === 'prices' && q.date) ctx.addIssue({ code: 'custom', path: ['date'], message: 'date for prices applies only to Supercines; the session_id already identifies the showtime.' });
    if (q.provider === 'grancine') {
      if (['movies', 'showtimes'].includes(op) && q.city && q.cinema_id) ctx.addIssue({ code: 'custom', path: ['city'], message: 'Gran Cine: use city for all its theaters in the city or cinema_id for one theater.' });
    }
    if (q.provider === 'supercines') {
      if (op === 'showtimes' && !q.movie_id && !q.city && !q.cinema_id) ctx.addIssue({ code: 'custom', path: ['cinema_id'], message: 'Supercines requires cinema_id, city or movie_id for supercines/showtimes.' });
      if (op === 'movies' && (q.city || q.movie_id || q.date)) ctx.addIssue({ code: 'custom', message: 'Supercines movies returns the current listings, overall or for one venue (cinema_id): use query to search and get_showtimes for dates.' });
      if (['prices', 'concessions'].includes(op)) need('cinema_id');
      if (op === 'prices') { need('session_id'); need('movie_id'); }
    }
    if (q.provider === 'cinex') {
      if (op === 'prices' && q.movie_id) ctx.addIssue({ code: 'custom', path: ['movie_id'], message: 'Cinex looks up prices by cinema_id and session_id; it does not support filtering these prices by movie_id.' });
      if (op === 'showtimes' && !q.movie_id && !q.city && !q.cinema_id) ctx.addIssue({ code: 'custom', path: ['cinema_id'], message: 'Cinex requires city (every venue in the city), cinema_id or movie_id for cinex/showtimes.' });
      if (['prices', 'concessions'].includes(op)) need('cinema_id');
      if (op === 'prices') need('session_id');
      if (op === 'movies' && (q.date || q.cinema_id || q.city || q.movie_id)) ctx.addIssue({ code: 'custom', message: 'Cinex movies offers the general catalog: use query to search and get_showtimes to filter by date/venue.' });
      if (op === 'showtimes' && q.city && (q.cinema_id || q.movie_id)) ctx.addIssue({ code: 'custom', path: ['city'], message: 'Cinex: use city alone for every venue in the city, or cinema_id/movie_id without city.' });
    }
  }));
}

/**
 * Cancellation and, when the client sent a progressToken, progress
 * notifications for one tool call. Progress counts completed provider reads
 * in fan-outs; the value only increases, as the protocol requires.
 */
function callOptions(ctx: ServerContext, startedAt?: number): CallOptions {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return { signal: ctx.mcpReq.signal, startedAt };
  let progress = 0;
  return {
    signal: ctx.mcpReq.signal,
    startedAt,
    progress: message => {
      void ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: ++progress, message } }).catch(() => {});
    },
  };
}

export type AccountTools = {
  connect(provider: AuthProviderId): Promise<{ connected: true } | { connected: false; url: string; expires_at: string }>;
  disconnect(provider: AuthProviderId): Promise<void>;
};
export function createServer(service = new CinemaService(), accounts?: AccountTools, publicHosted = false, receivedAt?: number) {
  const server = new McpServer({ name: 'cinve', version: '0.1.0' }, {
    // Clients truncate long instructions (Claude Code keeps the first 4,096
    // characters; OpenAI asks for the essentials in the first 512), so the
    // core rules come first and mode-specific notes stay short. Detailed seat
    // rules live in get_seats, and the full connection steps arrive with each
    // auth_required result and in get_auth_status.login_command.
    instructions: serverInstructions({ publicHosted, accounts: Boolean(accounts) }),
  });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  // Directories (Claude's among them) read the display name from
  // annotations.title, so mirror each tool's title there too.
  const registerTool = ((...[name, config, cb]: Parameters<typeof server.registerTool>) => server.registerTool(name,
    { ...config, annotations: { ...config.annotations, title: config.title } }, cb)) as typeof server.registerTool;
  registerTool('get_auth_status', {
    title: 'Authentication status',
    description: 'Status of the Cinex, Cines Unidos and Supercines sessions and the next connection step. The Supercines account is optional for prices (without it they are the public ones) and needed for its seat maps. Returns no personal data or secrets. configured does not guarantee that the provider has not revoked the session.',
    inputSchema: z.object({}).strict(),
    outputSchema: AuthStatusResult,
    annotations: { ...annotations, openWorldHint: false },
  }, async () => {
    try {
      const mode: 'hosted' | 'local' = publicHosted || accounts ? 'hosted' : 'local';
      const data = { connection: { mode, client_authorized: !publicHosted }, providers: await service.authStatus() };
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    } catch {
      throw new Error('Could not read authentication status. Try again later.');
    }
  });
  registerTool('list_providers', {
    title: 'List providers',
    description: 'Lists providers and implemented coverage. This capability catalog does not perform a live availability check.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ version: z.string(), capability_audit_date: z.string(), live_health_check: z.literal(false), providers: z.array(z.object({ id: Provider, capabilities: z.record(z.string(), z.string()) })) }),
    annotations: { ...annotations, openWorldHint: false },
  }, async () => {
    const data = { version: '0.1.0', capability_audit_date: '2026-11-11', live_health_check: false as const, providers: Object.entries(capabilities).map(([id, capabilities]) => ({ id, capabilities })) };
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  });
  if (accounts || publicHosted) {
    registerTool('connect_account', {
      title: 'Connect account',
      description: 'In hosted mode, starts Cinve authorization automatically when needed. If the account is already connected, returns connected=true: repeat the original query without asking the user for anything. Otherwise, returns connected=false and a private, single-use link for the user to connect their Cinex, Cines Unidos or Supercines account (Supercines shows public prices without an account, but its seat maps need one: connect it when get_seats returns auth_required for Supercines or the user asks). Present it only to the user in this conversation and do not share it with third parties: whoever uses it connects their account to this access. Do not open or fill in the form as an agent. Never ask for credentials in the chat. Expires in 10 minutes.',
      inputSchema: z.object({ provider: AuthProvider }).strict(),
      outputSchema: z.object({ connected: z.boolean(), url: z.string().url().optional(), expires_at: z.string().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ provider }) => {
      try {
        if (!accounts) throw new Error('Authorize Cinve using your assistant\'s authentication option.');
        const data = await accounts.connect(provider);
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      } catch {
        // Account adapters may include database or provider details in their exception.
        // Keep those details out of the MCP result; the browser flow has its own safe errors.
        throw new Error('Could not create the connection link. Try again later.');
      }
    });
    registerTool('disconnect_account', {
      title: 'Disconnect account',
      description: 'Disconnects the user\'s cinema account in Cinve and cancels pending links. Does not revoke the session directly on the cinema\'s website. Use when the user asks to disconnect.',
      inputSchema: z.object({ provider: AuthProvider }).strict(),
      outputSchema: z.object({ disconnected: z.literal(true) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async ({ provider }) => {
      try {
        if (!accounts) throw new Error('Authorize Cinve using your assistant\'s authentication option.');
        await accounts.disconnect(provider);
        const data = { disconnected: true as const };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      } catch {
        throw new Error('Could not disconnect the account. Try again later.');
      }
    });
  }
  registerTool('get_seats', {
    title: 'Get seats and ASCII map',
    description: 'Actual seat map without booking: Cinex and Cines Unidos require cinema_id, session_id and a connected account; Cinepic also requires movie_id, without login; Supercines requires cinema_id, session_id, movie_id, date if the showtime is not today, and a connected account (its website shows the map only inside a purchase, so Cinve opens one with a single ticket, picks no seat and cancels it in the same call). Use IDs from get_showtimes. Returns counters, a PNG image of the map oriented like the cinema\'s website (image=svg returns it as SVG) and the full ASCII map, where each seat appears with its label and state (O = status available); include_seats=true adds the per-seat detail, which is much longer. No local cache. ' + seatInstructions,
    inputSchema: z.preprocess(absentNulls({ provider, cinema_id: cinemaId, session_id: sessionId, movie_id: movieId, include_seats: true, image: true, date: true }), z.object({ provider, cinema_id: cinemaId, session_id: sessionId, movie_id: movieId.optional(),
      date: DateInput.optional().describe('Supercines only: showtime date (YYYY-MM-DD), the same one used in get_showtimes; defaults to today in America/Caracas.'),
      include_seats: z.boolean().optional().describe('true: adds seats with each seat\'s id, row, coordinates and provider state. Omit it to answer about availability: the ascii map is enough and is a fraction of the size.'),
      image: z.enum(['png', 'svg', 'none']).optional().describe('png (default): an image of the map to show and share. svg: the same map as an embedded SVG file, longer. none: data only.') }).strict().superRefine((q, ctx) => {
      if ((q.provider === 'cinepic' || q.provider === 'supercines') && !q.movie_id) ctx.addIssue({ code: 'custom', path: ['movie_id'], message: `${q.provider === 'cinepic' ? 'Cinepic' : 'Supercines'} requires movie_id from get_showtimes.` });
      if (q.provider !== 'supercines' && q.date) ctx.addIssue({ code: 'custom', path: ['date'], message: 'date for seats applies only to Supercines; the session_id already identifies the showtime.' });
    })),
    // Kept read-only like every lookup: an order opened to read a map (Supercines, some Cinex rooms) is
    // cancelled within the same call and picks no seat; the description and each result's warnings say so.
    outputSchema: SeatResult, annotations,
  }, async ({ include_seats, image = 'png', ...args }, ctx) => {
    const data = await service.seats(args, callOptions(ctx, receivedAt));
    // The picture is built from the verified map before the per-seat list is
    // dropped; a rendering failure leaves the data answer intact.
    let picture: { type: 'image'; data: string; mimeType: 'image/png' } | { type: 'resource'; resource: { uri: string; mimeType: 'image/svg+xml'; text: string } } | undefined;
    if (data.status === 'available' && data.seats?.length && image !== 'none') {
      try {
        const svg = renderSeatMapSvg(data.seats, data.layout, { provider: data.provider, cinema: data.showing?.cinema_name ?? cinepicVenueName(data.cinema_id) ?? `Sede ${data.cinema_id}`,
          session: data.session_id, queriedAt: data.queried_at, movie: data.showing?.movie, screen: data.showing?.screen, date: data.showing?.date, time: data.showing?.time });
        picture = image === 'svg'
          ? { type: 'resource', resource: { uri: `cinve://seats/${data.provider}/${data.cinema_id}/${data.session_id}.svg`, mimeType: 'image/svg+xml', text: svg } }
          : { type: 'image', data: Buffer.from(await renderSeatMapPng(svg)).toString('base64'), mimeType: 'image/png' };
      } catch (e) {
        data.warnings.push(e instanceof MapTooLarge ? 'The map is too large to draw as an image; use the ascii map.' : 'Could not generate the map image; use the ascii map.');
      }
    }
    // The ASCII map carries every label and state; the per-seat list is ~10x larger.
    if (!include_seats) delete data.seats;
    if ((publicHosted || accounts) && data.status === 'auth_required') data.warnings = ['Connect your account with connect_account and repeat get_seats. ' + hostedAuthInstructions];
    return { content: [{ type: 'text', text: JSON.stringify(data) }, ...(picture ? [picture] : [])], structuredContent: data, isError: data.status !== 'available' };
  });
  const tools: Array<[string, Operation, string]> = [
    ['list_cities', 'cities', 'Lists the provider\'s cities. Use their names when querying Cines Unidos.'],
    ['list_cinemas', 'cinemas', 'Lists venues and IDs, with each venue\'s area. For a user who names where they are, pass near: venues come nearest first with distance_km. Cines Unidos requires city or near; Supercines accepts an optional city; Cinepic verifies its configured venues Candelaria and VVIP Lido. Providers keep known venues without a verified code (code_status=unverified). Cinex accepts an optional city and includes known venues missing from the current directory (directory_status=not_listed); neither condition indicates a closure.'],
    ['list_movies', 'movies', 'Searches movies by name. Cinepic requires cinema_id (123300 Candelaria or 123301 VVIP Lido) and filters the day\'s showtimes; Cines Unidos requires city and allows cinema_id/date. Cinex returns the general catalog without date/venue: only provider, query and paging. Supercines returns its current listings (with presales), overall or for one venue with cinema_id, without a date. Gran Cine returns the titles with showtimes on the date, with optional cinema_id or city. IDs belong to the provider and, for Cinepic, to the venue.'],
    ['get_showtimes', 'showtimes', 'Gets showtimes for a date (today in Caracas by default). Cinepic requires cinema_id (123300 Candelaria or 123301 VVIP Lido); Cines Unidos requires city; Cinex accepts city for all its verified venues in the city in one call, cinema_id for one venue (with optional movie_id to filter), or only movie_id to read the movie\'s page across all venues; Supercines accepts cinema_id, city or movie_id; Gran Cine (arthouse cinema, includes the Paseo Las Mercedes theaters) accepts cinema_id, city or neither for all its theaters, without provider showtime IDs; use query to filter by title. The venue call resolves titles against the catalog and marks partial when it cannot confirm a movie_id. Returns the IDs needed for prices, screen/format when available and the website URL.'],
    ['get_ticket_prices', 'prices', 'Gets ticket prices (Gran Cine does not publish them). Cinepic requires cinema_id, movie_id and session_id from get_showtimes. Cines Unidos requires cinema_id, session_id and a connected account. Cinex requires cinema_id, session_id and a connected account. Supercines requires cinema_id, movie_id and session_id, and date if the showtime is not today; it does not require an account (if the user connected theirs, prices are read with it). Returns USD/VES when verifiable, Cinex breakdown in VES. Does not return final purchase totals.'],
    ['get_concessions', 'concessions', 'Gets concessions by venue. Cinepic and Cines Unidos require only cinema_id, via a public API; Cinepic may return an empty catalog. Cinex requires cinema_id and a connected account. Supercines requires only cinema_id. Stock only when verified; does not use zero for missing prices.'],
  ];
  for (const [name, op, description] of tools) registerTool(name, {
    title: ({
      cities: 'List cities', cinemas: 'List venues', movies: 'List movies',
      showtimes: 'Get showtimes', prices: 'Get ticket prices', concessions: 'Get concessions',
    } satisfies Record<Operation, string>)[op],
    description, inputSchema: inputSchema(op), outputSchema: outputSchema(op), annotations,
  }, async (args, ctx) => {
    const data = await service.query(op, args, callOptions(ctx, receivedAt));
    if (publicHosted && data.status === 'auth_required') data.warnings = ['This query requires a provider account. Call connect_account with this provider to start Cinve authorization. If it returns connected=true, repeat this query; otherwise, present the private cinema link to the user and, after they connect, check get_auth_status and repeat this query. Do not search the web for sign-in pages or ask for passwords or tokens in chat. Public data remains available. ' + hostedAuthInstructions];
    // A provider-level failure is still a valid Result payload, but MCP clients
    // need isError to distinguish it from an empty/available business result.
    const isError = !['available', 'empty'].includes(data.status);
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError };
  });
  return server;
}

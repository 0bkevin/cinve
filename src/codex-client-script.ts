// Dependency-free companion served to local Codex clients. No model turns,
// password input, token extraction, or changes to the user's configuration.
export const codexClientScript = String.raw`import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
let server = 'cinve';
if (args[0] === '--server') { args.shift(); server = args.shift(); }
const [mode, target, json = '{}'] = args;
const readable = new Set(['get_auth_status', 'list_providers', 'list_cities', 'list_cinemas', 'list_movies', 'get_showtimes', 'get_ticket_prices', 'get_concessions', 'get_seats']);
if (!/^[a-zA-Z0-9_-]{1,100}$/.test(server ?? '') || args.length > 3 ||
    !((mode === 'connect' && ['cinex', 'cinesunidos'].includes(target) && args.length === 2) || (mode === 'call' && readable.has(target)))) {
  console.error('Usage: node cinve-codex.mjs [--server cinve] connect cinex|cinesunidos OR call TOOL JSON');
  process.exit(2);
}
let toolArgs;
try { toolArgs = JSON.parse(json); if (!toolArgs || Array.isArray(toolArgs) || typeof toolArgs !== 'object' || json.length > 16000) throw Error(); }
catch { console.error('Invalid tool arguments.'); process.exit(2); }
const child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map(); let buffer = '', nextId = 0, stopped = false;
let oauthEvent, oauthResolve;
const oauthCompleted = new Promise(resolve => { oauthResolve = resolve; });
function failPending() { for (const p of pending.values()) p.reject(new Error('Codex App Server stopped.')); pending.clear(); }
child.on('error', failPending); child.on('exit', () => { stopped = true; failPending(); oauthResolve({ success: false }); });
child.stderr.on('data', () => {}); // Never forward unrelated account/configuration diagnostics.
child.stdout.on('data', chunk => {
  buffer += chunk; if (buffer.length > 8 * 1024 * 1024) { child.kill(); return; }
  let cut;
  while ((cut = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (pending.has(e.id)) {
      const p = pending.get(e.id); pending.delete(e.id);
      e.error ? p.reject(new Error('Codex could not complete ' + p.method + '.')) : p.resolve(e.result);
    } else if (e.method === 'mcpServer/oauthLogin/completed' && e.params?.name === server) {
      oauthEvent = e.params; oauthResolve(oauthEvent);
    } else if (e.id !== undefined && e.method) {
      // No approvals or browser consent are answered automatically.
      child.stdin.write(JSON.stringify({ id: e.id, error: { code: -32601, message: 'Interactive request unsupported by this companion.' } }) + '\n');
    }
  }
});
function request(method, params) {
  if (stopped) return Promise.reject(new Error('Codex App Server is unavailable.'));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timed out: ' + method)); }, 60000);
    pending.set(id, { method, resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
const emit = data => console.log(JSON.stringify(data));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
process.on('SIGINT', () => { child.kill(); process.exit(130); });
process.on('SIGTERM', () => { child.kill(); process.exit(143); });
try {
  await request('initialize', { clientInfo: { name: 'cinve_local_continuation', version: '1' } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const started = await request('thread/start', { cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
  const threadId = started.thread.id;
  const call = (tool, arguments_ = {}) => request('mcpServer/tool/call', { threadId, server, tool, arguments: arguments_ });
  if (mode === 'call') {
    const result = await call(target, toolArgs); emit(result);
    if (result.isError) process.exitCode = 1;
  } else {
    let auth = (await call('get_auth_status')).structuredContent;
    if (!auth?.connection) throw new Error('Cinve did not return its authorization status.');
    if (!auth.connection.client_authorized) {
      const native = await request('mcpServer/oauth/login', { threadId, name: server, timeoutSecs: 600 });
      if (!native.authorizationUrl) throw new Error('Codex did not provide an authorization link.');
      emit({ event: 'authorize_cinve', url: native.authorizationUrl });
      let timer;
      const completed = await Promise.race([oauthCompleted, new Promise(resolve => { timer = setTimeout(() => resolve({ success: false }), 600000); })]);
      clearTimeout(timer);
      if (!completed.success) throw new Error('Authorization cancelled, expired, or failed. No new attempt was started.');
      await request('config/mcpServer/reload', {});
      auth = (await call('get_auth_status')).structuredContent;
      if (!auth?.connection?.client_authorized) throw new Error('Codex could not load authorization after refreshing.');
    }
    const configured = a => a?.providers?.some(p => p.provider === target && p.status === 'configured');
    if (!configured(auth)) {
      const result = await call('connect_account', { provider: target });
      const link = result.structuredContent;
      if (result.isError || !link?.url || !link.expires_at) throw new Error('Cinve could not create the cinema connection link.');
      emit({ event: 'connect_cinema', provider: target, url: link.url, expires_at: link.expires_at });
      const deadline = Math.min(Date.parse(link.expires_at), Date.now() + 600000);
      if (!Number.isFinite(deadline)) throw new Error('Invalid connection expiry.');
      let lastProgress = Date.now();
      while (!configured(auth) && Date.now() < deadline) {
        await pause(2000); auth = (await call('get_auth_status')).structuredContent;
        if (!auth?.connection?.client_authorized) throw new Error('Cinve authorization was revoked.');
        if (Date.now() - lastProgress > 30000) { emit({ event: 'waiting_for_cinema', provider: target }); lastProgress = Date.now(); }
      }
      if (!configured(auth)) throw new Error('Cinema connection expired. No new attempt was started.');
    }
    emit({ event: 'ready', provider: target, client_authorized: true });
  }
} catch (e) { emit({ event: 'error', message: e.message }); process.exitCode = 1; }
finally { child.kill(); }
`;

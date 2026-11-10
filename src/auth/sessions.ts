import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import * as z from 'zod';
import { DataError, isObj } from '../core.js';
import { assertPrivateRead } from '../http/allow-list.js';

export const AuthProvider = z.enum(['cinex', 'cinesunidos']);
export type AuthProviderId = z.infer<typeof AuthProvider>;
export const Session = z.object({
  version: z.literal(1), provider: AuthProvider, expires_at: z.number().int().positive().max(8.64e15),
  /** When this login was saved; a refusal seen after a newer login must not expire it. */
  saved_at: z.number().int().positive().max(8.64e15).optional(),
  cookie_jar: z.string().max(100000).optional(), access_token: z.string().min(1).max(16000).regex(/^[A-Za-z0-9._~+\/-]+=*$/).optional(),
}).strict().refine(s => s.provider === 'cinex' ? !!s.cookie_jar && !s.access_token : !!s.access_token && !s.cookie_jar);
export type AuthSession = z.infer<typeof Session>;
/** The Cinex cookie jar a session carries; the schema's refinement requires one for Cinex. */
function cinexJar(s: AuthSession): CookieJar {
  if (s.cookie_jar === undefined) throw new Error('A Cinex session carries a cookie jar.');
  return CookieJar.deserializeSync(s.cookie_jar);
}
const loginHint = (p: AuthProviderId) => `Ejecuta npm run login -- ${p} en una terminal local. No envíes contraseñas al agente.`;

/** One OS user per MCP process. No passwords, profile data, or shared session cache. */
export class SessionStore {
  constructor(readonly directory = join(process.env.XDG_CONFIG_HOME && isAbsolute(process.env.XDG_CONFIG_HOME) ? process.env.XDG_CONFIG_HOME : join(homedir(), '.config'), 'cinev')) {}
  private path(p: AuthProviderId) { return join(this.directory, `${AuthProvider.parse(p)}.json`); }
  /** Names the provider account whose server-side session these credentials share. */
  accountKey(p: AuthProviderId) { return `local:${this.directory}:${p}`; }
  /** saved_at of the login whose credentials this store last handed to a read, per provider. */
  private sent = new Map<AuthProviderId, number>();
  /**
   * Whether a refusal seen by a read that started at notAfter applies to the
   * stored session `s`: it is not newer than the read, it is the login that
   * read actually sent (a connection committed mid-read is not), and it has
   * not already expired.
   */
  protected refused(p: AuthProviderId, s: AuthSession | undefined, notAfter: number): s is AuthSession {
    const savedAt = s?.saved_at ?? 0, sent = this.sent.get(p);
    return !!s && savedAt <= notAfter && (sent === undefined || sent === savedAt) && s.expires_at > Date.now();
  }
  async read(p: AuthProviderId): Promise<AuthSession | undefined> {
    try {
      const dir = await lstat(this.directory);
      if (!dir.isDirectory() || (dir.mode & 0o077) || (process.getuid && dir.uid !== process.getuid())) throw new Error();
      const handle = await open(this.path(p), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 128 * 1024 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error();
        const session = Session.parse(JSON.parse(await handle.readFile('utf8')));
        if (session.provider !== p) throw new Error();
        if (p === 'cinex') cinexJar(session);
        return session;
      } finally { await handle.close(); }
    } catch (e) {
      if (isObj(e) && e.code === 'ENOENT') return undefined;
      throw new DataError('auth_required', `La sesión local de ${p} no es válida o tiene permisos inseguros. ${loginHint(p)}`);
    }
  }
  async save(value: AuthSession) {
    const s = Session.parse(value);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Directorio de sesiones no válido.');
    await chmod(this.directory, 0o700);
    const path = this.path(s.provider), temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(s)); } finally { await handle.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async remove(p: AuthProviderId) {
    try {
      const dir = await lstat(this.directory);
      if (!dir.isDirectory() || (process.getuid && dir.uid !== process.getuid())) throw new Error('Directorio de sesiones no válido.');
      await unlink(this.path(p));
    } catch (e) { if (!isObj(e) || e.code !== 'ENOENT') throw e; }
  }
  /**
   * Records that the provider refused a session read before notAfter (epoch ms),
   * so status reports expired instead of the optimistic local expiry. A login
   * saved after notAfter is newer than the refusal and is left alone.
   */
  async expire(p: AuthProviderId, notAfter: number) {
    const s = await this.read(p);
    if (this.refused(p, s, notAfter)) await this.save({ ...s, expires_at: Date.now() });
  }
  async status(p: AuthProviderId) {
    try {
      const s = await this.read(p);
      return { provider: p, status: !s ? 'missing' : s.expires_at <= Date.now() ? 'expired' : 'configured',
        expires_at: s ? new Date(s.expires_at).toISOString() : null, login_command: `npm run login -- ${p}`, remote_validity_checked: false as const };
    } catch { return { provider: p, status: 'invalid', expires_at: null, login_command: `npm run login -- ${p}`, remote_validity_checked: false as const }; }
  }
  async headers(p: AuthProviderId, url: string): Promise<Record<string, string>> {
    assertPrivateRead(p, url);
    const s = await this.read(p);
    if (!s || s.expires_at <= Date.now()) throw new DataError('auth_required', loginHint(p));
    this.sent.set(p, s.saved_at ?? 0);
    if (p === 'cinesunidos') return { Authorization: `Bearer ${s.access_token}`, xChannel: 'www' };
    try {
      const cookie = await cinexJar(s).getCookieString(url);
      if (!cookie) throw new Error();
      return { Cookie: cookie, Referer: 'https://www.cinex.com.ve/', 'X-Requested-With': 'XMLHttpRequest' };
    } catch { throw new DataError('auth_required', loginHint(p)); }
  }
}

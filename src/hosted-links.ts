import { createHmac, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { digest, EncryptedSessionStore, lockUser, transaction } from './hosted-store.js';
import { CinemaUnavailable, CredentialsRejected, LoginError } from './auth.js';
import type { AuthProviderId, AuthSession } from './auth.js';

type Connection = { user: string; tokenHash: string; provider: AuthProviderId; expires: number; attempts: number; busy: boolean };

/** Cinema sign-in limits; see ConnectionLinks.admitSignIn. */
export const signInLimits = {
  networkPerMinute: 20, blockPerMinute: 60,
  networkFailuresPerDay: 100, blockFailuresPerDay: 300,
  accountAttempts: 5, accountWindowSeconds: 900,
  globalFailures: 300, recentWindowSeconds: 900,
};
/** network: a rate-limit network (rateLimitNetwork); username as typed, compared case-insensitively. */
export type SignInSubject = { network: string; provider: AuthProviderId; username: string };
export type SignInRefusal = 'account' | 'network' | 'strained';
export const signInRefusalMessage: Record<SignInRefusal, string> = {
  account: 'Demasiados intentos para esta cuenta. Espera 15 minutos o comprueba tus datos en la web del cine.',
  network: 'Demasiados intentos desde tu red. Espera unos minutos y vuelve a intentarlo.',
  strained: 'Demasiados intentos fallidos en Cinve en este momento. Espera 15 minutos y vuelve a intentarlo.',
};
/** For a sign-in whose credentials never reached the cinema. */
export const cinemaUnavailableMessage = 'El cine no está respondiendo en este momento. Inténtalo de nuevo en unos minutos.';
const globalFailures = 'signin-fail:global';
const accountKey = (s: SignInSubject) => `signin:account:${s.provider}:${s.username.trim().toLowerCase()}`;
/** The /48 an IPv6 /64 rate-limit network belongs to; undefined for IPv4. Catches rotation across a larger IPv6 allocation. */
export function ipv6Block(network: string) {
  return network.endsWith('::/64') ? network.split(':').slice(0, 3).join(':') + '::/48' : undefined;
}
function failureKeys(network: string) {
  const block = ipv6Block(network);
  return { day: `signin-fail:day:${network}`, recent: `signin-fail:recent:${network}`, block, blockDay: block && `signin-fail:day:${block}` };
}
export class ConnectionLinks {
  /**
   * budgetKey: a 32-byte key for rate-limit keys. Those name addresses and
   * cinema account emails, which a plain digest would not hide (any IPv4
   * address or a known email can be hashed and compared), so they are stored
   * as HMACs. Only rate limits need it; links and cleanup work without it.
   */
  constructor(readonly pool: Pool, private readonly budgetKey?: Buffer) {
    if (budgetKey && budgetKey.length !== 32) throw new Error('Clave de límites no válida.');
  }
  /** The stored form of a rate-limit key. */
  keyHash(key: string) {
    if (!this.budgetKey) throw new Error('Falta la clave de los límites.');
    return createHmac('sha256', this.budgetKey).update(key).digest('hex');
  }
  async issue(user: string, tokenHash: string, provider: AuthProviderId) {
    return transaction(this.pool, async client => {
      if (await lockUser(client, user) !== tokenHash) throw new Error('Acceso revocado.');
      const token = randomBytes(32).toString('hex');
      const { rows } = await client.query(`INSERT INTO cinev_links(token_hash,user_id,provider,stage,expires_at)
        VALUES($1,$2,$3,'invitation',now()+interval '10 minutes')
        ON CONFLICT(user_id,provider) DO UPDATE SET token_hash=EXCLUDED.token_hash,stage='invitation',
        expires_at=EXCLUDED.expires_at,attempts=0,busy=false RETURNING expires_at`, [digest(token), user, provider]);
      return { token, expires_at: rows[0].expires_at.toISOString() as string };
    });
  }
  private async lookup(client: Pool | PoolClient, token: string, stage: string): Promise<Connection | undefined> {
    const { rows } = await client.query(`SELECT l.*,c.token_hash AS owner_hash FROM cinev_links l
      JOIN cinev_clients c ON c.id=l.user_id WHERE l.token_hash=$1 AND stage=$2
      AND expires_at>clock_timestamp() AND c.revoked_at IS NULL`, [digest(token), stage]);
    const row = rows[0];
    return row ? { user: row.user_id, tokenHash: row.owner_hash, provider: row.provider, expires: row.expires_at.getTime(), attempts: row.attempts, busy: row.busy } : undefined;
  }
  private async locked<T>(token: string, stage: string, fn: (client: PoolClient, connection: Connection) => Promise<T>): Promise<T | undefined> {
    return transaction(this.pool, async client => {
      const candidate = await this.lookup(client, token, stage);
      if (!candidate || !await lockUser(client, candidate.user)) return undefined;
      const current = await this.lookup(client, token, stage);
      return current ? fn(client, current) : undefined;
    });
  }
  async exchange(token: string) {
    return this.locked(token, 'invitation', async (client, connection) => {
      const browserToken = randomBytes(32).toString('hex');
      await client.query("UPDATE cinev_links SET token_hash=$2,stage='browser' WHERE token_hash=$1", [digest(token), digest(browserToken)]);
      return { browserToken, connection };
    });
  }
  get(token: string) { return this.lookup(this.pool, token, 'browser'); }
  async consume(token: string) {
    await this.locked(token, 'browser', async client => { await client.query('DELETE FROM cinev_links WHERE token_hash=$1', [digest(token)]); });
  }
  async claim(token: string) {
    return this.locked(token, 'browser', async (client, connection) => {
      if (connection.busy || connection.attempts >= 5) return undefined;
      await client.query('UPDATE cinev_links SET busy=true, attempts=attempts+1 WHERE token_hash=$1', [digest(token)]);
      return connection;
    });
  }
  async release(token: string) {
    await this.locked(token, 'browser', async client => { await client.query('UPDATE cinev_links SET busy=false WHERE token_hash=$1', [digest(token)]); });
  }
  async complete(token: string, value: AuthSession, key: Buffer) {
    return this.locked(token, 'browser', async (client, connection) => {
      if (!connection.busy || connection.provider !== value.provider) return false;
      await new EncryptedSessionStore(this.pool, connection.user, key).saveInTransaction(client, value);
      await client.query('DELETE FROM cinev_links WHERE token_hash=$1', [digest(token)]);
      return true;
    });
  }
  async cancel(user: string, provider: AuthProviderId) {
    await transaction(this.pool, async client => {
      await lockUser(client, user);
      await client.query('DELETE FROM cinev_links WHERE user_id=$1 AND provider=$2', [user, provider]);
    });
  }
  /** Charges one use of a fixed window (one minute by default); false once the limit is spent. */
  async budget(key: string, limit: number, windowSeconds = 60) {
    const { rows } = await this.pool.query(`INSERT INTO cinev_budgets(key_hash,expires_at,count)
      VALUES($1,now()+make_interval(secs => $3),1) ON CONFLICT(key_hash) DO UPDATE SET
      count=CASE WHEN cinev_budgets.expires_at<=now() THEN 1 ELSE LEAST(cinev_budgets.count+1,$2+1) END,
      expires_at=CASE WHEN cinev_budgets.expires_at<=now() THEN EXCLUDED.expires_at ELSE cinev_budgets.expires_at END
      RETURNING count`, [this.keyHash(key), limit, windowSeconds]);
    return rows[0].count <= limit;
  }
  /** Current counts of live windows, without charging them (0 when absent or expired). */
  private async counts(keys: string[]): Promise<number[]> {
    const { rows } = await this.pool.query('SELECT key_hash,count FROM cinev_budgets WHERE key_hash=ANY($1) AND expires_at>now()', [keys.map(key => this.keyHash(key))]);
    const found = new Map(rows.map(r => [r.key_hash as string, r.count as number]));
    return keys.map(key => found.get(this.keyHash(key)) ?? 0);
  }
  /** Adds one event to each window, in one statement. Keys must be distinct. */
  private async record(entries: Array<[key: string, windowSeconds: number]>) {
    await this.pool.query(`INSERT INTO cinev_budgets(key_hash,expires_at,count)
      SELECT k, now()+make_interval(secs => s), 1 FROM unnest($1::text[], $2::int[]) AS t(k, s)
      ON CONFLICT(key_hash) DO UPDATE SET
      count=CASE WHEN cinev_budgets.expires_at<=now() THEN 1 ELSE LEAST(cinev_budgets.count+1,1000000) END,
      expires_at=CASE WHEN cinev_budgets.expires_at<=now() THEN EXCLUDED.expires_at ELSE cinev_budgets.expires_at END`,
    [entries.map(([key]) => this.keyHash(key)), entries.map(([, seconds]) => seconds)]);
  }
  /**
   * Admission for one cinema sign-in, from the consent page or a connection
   * link (connections are self-service, so per-connection limits alone would
   * let one network test unbounded credentials through Cinve). Returns why it
   * is refused, or undefined. Every outcome must be reported afterwards with
   * signInFailed or signInSucceeded.
   *
   * - Per network (an IPv4 address or IPv6 /64) and per IPv6 /48: attempts
   *   per minute, and failures per day.
   * - Per cinema account: attempts in 15 minutes, reserved atomically so
   *   parallel guesses cannot overshoot, and cleared by a success. This bounds
   *   guessing one password from any number of networks, and keeps attackers
   *   from getting the owner's account locked at the cinema.
   * - Service-wide failures: past the threshold only networks with no recent
   *   failure may sign in. There is no cap on successful sign-ins, so failing
   *   attackers cannot lock out users whose sign-ins succeed.
   */
  async admitSignIn(subject: SignInSubject): Promise<SignInRefusal | undefined> {
    const keys = failureKeys(subject.network);
    const [day, recent, global, blockDay = 0] = await this.counts([keys.day, keys.recent, globalFailures, ...(keys.blockDay ? [keys.blockDay] : [])]);
    if (day >= signInLimits.networkFailuresPerDay || blockDay >= signInLimits.blockFailuresPerDay) return 'network';
    if (global >= signInLimits.globalFailures && recent > 0) return 'strained';
    if (!await this.budget(`oauth:login-ip:${subject.network}`, signInLimits.networkPerMinute)) return 'network';
    if (keys.block && !await this.budget(`signin:block:${keys.block}`, signInLimits.blockPerMinute)) return 'network';
    if (!await this.budget(accountKey(subject), signInLimits.accountAttempts, signInLimits.accountWindowSeconds)) return 'account';
    return undefined;
  }
  /** A sign-in that did not produce a session: rejected credentials, or a cinema that did not deliver one. */
  async signInFailed(subject: SignInSubject) {
    const keys = failureKeys(subject.network), day = 86400, recent = signInLimits.recentWindowSeconds;
    await this.record([[keys.day, day], [keys.recent, recent], [globalFailures, recent], ...(keys.blockDay ? [[keys.blockDay, day] as [string, number]] : [])]);
  }
  /** The credentials never reached the cinema: give that account its attempt back (nothing was tested). */
  async signInUnavailable(subject: SignInSubject) {
    await this.pool.query('UPDATE cinev_budgets SET count=GREATEST(count-1,0) WHERE key_hash=$1 AND expires_at>now()', [this.keyHash(accountKey(subject))]);
  }
  /**
   * How a failed sign-in counts. Only a refusal counts as a failure (and a
   * thrown value of unknown kind, failing closed); outages do not. A cinema
   * error after the credentials were sent is answered like a refusal, so a
   * response never reveals whether they were right.
   */
  async signInError(subject: SignInSubject, error: unknown): Promise<'unavailable' | 'refused'> {
    if (error instanceof CinemaUnavailable) { await this.signInUnavailable(subject); return 'unavailable'; }
    if (!(error instanceof LoginError) || error instanceof CredentialsRejected) await this.signInFailed(subject);
    return 'refused';
  }
  /** Correct credentials: clear that account's attempts (network and service-wide counts are never cleared). */
  async signInSucceeded(subject: SignInSubject) {
    await this.pool.query('DELETE FROM cinev_budgets WHERE key_hash=$1', [this.keyHash(accountKey(subject))]);
  }
  async cleanup() {
    // A cinema connected on the consent page whose code was never exchanged
    // belongs to nobody: drop its connection (and session) with the request.
    // Request rows are locked first: an exchange holding one is skipped, and
    // one that committed is re-checked and kept (consumed_at is now set).
    await this.pool.query(`DELETE FROM cinev_clients WHERE id IN (SELECT user_id FROM cinev_oauth_requests
      WHERE user_id IS NOT NULL AND consumed_at IS NULL AND expires_at<=now() FOR UPDATE SKIP LOCKED)`);
    // A request still holding a connection was skipped above (locked); keep it
    // so the next cleanup removes both, instead of orphaning the connection.
    await this.pool.query('DELETE FROM cinev_oauth_requests WHERE expires_at<=now() AND (user_id IS NULL OR consumed_at IS NOT NULL)');
    // Keep consumed refresh tokens until the grant expires to detect replay.
    await this.pool.query("DELETE FROM cinev_oauth_tokens WHERE kind='access' AND expires_at<=now()");
    await this.pool.query(`DELETE FROM cinev_clients c USING cinev_oauth_grants g
      WHERE c.id=g.user_id AND (g.expires_at<=now() OR c.revoked_at IS NOT NULL)`);
    await this.pool.query('DELETE FROM cinev_links WHERE expires_at<=now()');
    await this.pool.query('DELETE FROM cinev_budgets WHERE expires_at<=now()');
    await this.pool.query('DELETE FROM cinev_sessions WHERE expires_at<=now()');
    // Anonymous registrations: drop apps without a live grant that have not
    // issued tokens for 90 days (or never did). A returning client simply
    // registers again; its grants would have expired after 30 days anyway.
    // Runs last and tolerates a deployment that precedes migration 003.
    await this.pool.query(`DELETE FROM cinev_oauth_apps a WHERE COALESCE(a.last_used_at, a.created_at) <= now()-interval '90 days'
      AND NOT EXISTS (SELECT 1 FROM cinev_oauth_grants g WHERE g.app_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM cinev_oauth_requests r WHERE r.app_id=a.id)`).catch((error: { code?: string }) => {
      if (error?.code !== '42703') throw error; // undefined_column: migration 003 pending.
    });
  }
}

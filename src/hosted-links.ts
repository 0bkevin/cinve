import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
  strainedPerNetwork: 1, strainedPerBlock: 2,
  knownSeconds: 30 * 86400,
};
/** network: a rate-limit network (rateLimitNetwork); username as typed (see accountName). */
export type SignInSubject = { network: string; provider: AuthProviderId; username: string };
export type SignInRefusal = 'account' | 'network' | 'strained';
export const signInRefusalMessage: Record<SignInRefusal, string> = {
  account: 'Demasiados intentos para esta cuenta. Espera 15 minutos o comprueba tus datos en la web del cine.',
  network: 'Demasiados intentos desde tu red. Espera unos minutos y vuelve a intentarlo.',
  strained: 'Demasiados intentos fallidos en Cinve en este momento. Espera 15 minutos y vuelve a intentarlo.',
};
/**
 * Refused and unclear sign-ins are answered no sooner than this after the
 * attempt began. Some unclear failures only follow a correct password and
 * take an extra round trip; the floor hides that difference in timing.
 */
export const signInFloorMs = 2000;
export async function signInFloor(started: number, floorMs = signInFloorMs) {
  const wait = started + floorMs - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}
/** For a sign-in whose credentials never reached the cinema. */
export const cinemaUnavailableMessage = 'El cine no está respondiendo en este momento. Inténtalo de nuevo en unos minutos.';
const globalFailures = 'signin-fail:global';
/**
 * The account a username names, for limits only. Cinemas may compare
 * usernames with accent-, case- and width-insensitive collations, so every
 * variant must share one counter: NFKC, then drop default-ignorable
 * characters and whitespace, strip combining marks and fold case. Merging
 * more names than the cinema does only makes the limit stricter.
 */
export function accountName(username: string) {
  return username.normalize('NFKC').replace(/[\p{Default_Ignorable_Code_Point}\s]/gu, '')
    .normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().toLowerCase();
}
const account = (s: SignInSubject) => `${s.provider}:${accountName(s.username)}`;
const accountKey = (s: SignInSubject) => `signin:account:${account(s)}`;
// An account that signed in from this network before: its owner's usual network.
const knownKey = (s: SignInSubject) => `signin:known:${account(s)}:${s.network}`;
const pairKey = (s: SignInSubject) => `signin:pair:${account(s)}:${s.network}`;
/** The /48 an IPv6 /64 rate-limit network belongs to; undefined for IPv4. Catches rotation across a larger IPv6 allocation. */
export function ipv6Block(network: string) {
  return network.endsWith('::/64') ? network.split(':').slice(0, 3).join(':') + '::/48' : undefined;
}
function failureKeys(network: string) {
  const block = ipv6Block(network);
  return { day: `signin-fail:day:${network}`, recent: `signin-fail:recent:${network}`, block,
    blockDay: block && `signin-fail:day:${block}`, blockRecent: block && `signin-fail:recent:${block}` };
}
/**
 * budgetKey keys rate-limit keys. Those name addresses and cinema account
 * emails, which a plain digest would not hide (any IPv4 address or a known
 * email can be hashed and compared), so they are stored as HMACs. linkKey
 * signs connection-link tokens, so forged ones are refused in memory.
 */
export type LinkKeys = { budgetKey: Buffer; linkKey: Buffer };
export type LinkStage = 'invitation' | 'browser';
export class ConnectionLinks {
  /** Without keys only cleanup and reading existing links work (the operator CLI). */
  constructor(readonly pool: Pool, private readonly keys?: LinkKeys) {
    if (keys && (keys.budgetKey.length !== 32 || keys.linkKey.length !== 32)) throw new Error('Claves no válidas.');
  }
  /** The stored form of a rate-limit key. */
  keyHash(key: string) {
    if (!this.keys) throw new Error('Falta la clave de los límites.');
    return createHmac('sha256', this.keys.budgetKey).update(key).digest('hex');
  }
  private linkMac(stage: LinkStage, id: string) {
    if (!this.keys) throw new Error('Falta la clave de los enlaces.');
    return createHmac('sha256', this.keys.linkKey).update(`cvl:${stage}:${id}`).digest('base64url');
  }
  /** A new link token for a stage: 64 random hex characters and their HMAC, with the stage inside the signed text. */
  private signedLink(stage: LinkStage) {
    const id = randomBytes(32).toString('hex');
    return `${id}.${this.linkMac(stage, id)}`;
  }
  /**
   * 'signed' when the token carries a valid HMAC for this stage, 'legacy' for
   * the unsigned format issued before signing (links last ten minutes), and
   * undefined otherwise, judged without the database.
   */
  linkFormat(token: string, stage: LinkStage): 'signed' | 'legacy' | undefined {
    const signed = token.match(/^([a-f0-9]{64})\.([A-Za-z0-9_-]{43})$/);
    if (signed) return timingSafeEqual(Buffer.from(signed[2]), Buffer.from(this.linkMac(stage, signed[1]))) ? 'signed' : undefined;
    return /^[a-f0-9]{64}$/.test(token) ? 'legacy' : undefined;
  }
  async issue(user: string, tokenHash: string, provider: AuthProviderId) {
    return transaction(this.pool, async client => {
      if (await lockUser(client, user) !== tokenHash) throw new Error('Acceso revocado.');
      const token = this.signedLink('invitation');
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
      const browserToken = this.signedLink('browser');
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
  /** refund gives back the attempt claim counted, for a sign-in that never ran. */
  async release(token: string, refund = false) {
    await this.locked(token, 'browser', async client => {
      await client.query(`UPDATE cinev_links SET busy=false${refund ? ',attempts=GREATEST(attempts-1,0)' : ''} WHERE token_hash=$1`, [digest(token)]);
    });
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
  private uses = 0;
  /**
   * Every new network creates rate-limit rows, so a flood of fresh addresses
   * (rotating IPv6 /64s) would grow the table until the daily cleanup.
   * Remove expired windows as they accumulate, in bounded batches.
   */
  private async prune() {
    if (++this.uses % 100) return;
    await this.pool.query('DELETE FROM cinev_budgets WHERE key_hash IN (SELECT key_hash FROM cinev_budgets WHERE expires_at<=now() LIMIT 1000)')
      .catch(() => {}); // Housekeeping never fails a request.
  }
  /** Charges one use of a fixed window (one minute by default); false once the limit is spent. */
  async budget(key: string, limit: number, windowSeconds = 60) {
    await this.prune();
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
  // The per-account budget each admitted attempt was charged to, for a refund.
  private charged = new WeakMap<SignInSubject, string>();
  /**
   * Admission for one cinema sign-in, from the consent page or a connection
   * link (connections are self-service, so per-connection limits alone would
   * let one network test unbounded credentials through Cinve). Returns why it
   * is refused, or undefined. Every admitted attempt must be reported with
   * signInError or signInSucceeded, passing the same subject object.
   *
   * - A known pair (this account signed in from this network within 30
   *   days) is its owner's usual network: it has only its own budget of 5
   *   attempts per 15 minutes, so nothing others do (network caps, strained
   *   mode, guesses at the account from elsewhere) locks the owner out, and
   *   an attacker sharing that network is still bounded per account.
   * - Otherwise, per network (an IPv4 address or IPv6 /64) and per IPv6
   *   /48: attempts per minute and failures per day; and per cinema account
   *   5 attempts per 15 minutes from all networks together, reserved
   *   atomically so parallel guesses cannot overshoot.
   * - Service-wide failures: past the threshold ("strained"), networks or
   *   /48s with a recent failure are refused, and each may hold only one
   *   attempt (two per /48) per 15 minutes, reserved atomically. Successful
   *   sign-ins have no global cap.
   */
  async admitSignIn(subject: SignInSubject): Promise<SignInRefusal | undefined> {
    const keys = failureKeys(subject.network), L = signInLimits;
    const [known, day, recent, global, blockDay = 0, blockRecent = 0] = await this.counts([knownKey(subject), keys.day, keys.recent, globalFailures,
      ...(keys.block ? [keys.blockDay!, keys.blockRecent!] : [])]);
    if (known > 0) {
      if (!await this.budget(pairKey(subject), L.accountAttempts, L.accountWindowSeconds)) return 'account';
      this.charged.set(subject, pairKey(subject));
      return undefined;
    }
    if (day >= L.networkFailuresPerDay || blockDay >= L.blockFailuresPerDay) return 'network';
    if (global >= L.globalFailures) {
      if (recent > 0 || blockRecent > 0) return 'strained';
      if (!await this.budget(`signin:strained:${subject.network}`, L.strainedPerNetwork, L.recentWindowSeconds) ||
          (keys.block && !await this.budget(`signin:strained:${keys.block}`, L.strainedPerBlock, L.recentWindowSeconds))) return 'strained';
    }
    if (!await this.budget(`oauth:login-ip:${subject.network}`, L.networkPerMinute)) return 'network';
    if (keys.block && !await this.budget(`signin:block:${keys.block}`, L.blockPerMinute)) return 'network';
    if (!await this.budget(accountKey(subject), L.accountAttempts, L.accountWindowSeconds)) return 'account';
    this.charged.set(subject, accountKey(subject));
    return undefined;
  }
  /** Refused credentials (or a failure of unknown kind): every failure counter. */
  async signInFailed(subject: SignInSubject) {
    const keys = failureKeys(subject.network), day = 86400, recent = signInLimits.recentWindowSeconds;
    await this.record([[keys.day, day], [keys.recent, recent], [globalFailures, recent],
      ...(keys.block ? [[keys.blockDay!, day], [keys.blockRecent!, recent]] as Array<[string, number]> : [])]);
  }
  /**
   * The credentials never reached the cinema: give back the attempt this
   * subject was charged (nothing was tested).
   */
  async signInUnavailable(subject: SignInSubject) {
    const key = this.charged.get(subject);
    if (key) await this.pool.query('UPDATE cinev_budgets SET count=GREATEST(count-1,0) WHERE key_hash=$1 AND expires_at>now()', [this.keyHash(key)]);
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
    else {
      // Unclear (the cinema failed after receiving the credentials): bounded by
      // the daily network caps, but never strained mode, which outages must not trip.
      const keys = failureKeys(subject.network);
      await this.record([[keys.day, 86400], ...(keys.blockDay ? [[keys.blockDay, 86400] as [string, number]] : [])]);
    }
    return 'refused';
  }
  /**
   * Correct credentials: remember this account and network as a known pair.
   * Nothing is cleared, so a success cannot be observed through the limits.
   */
  async signInSucceeded(subject: SignInSubject) {
    await this.record([[knownKey(subject), signInLimits.knownSeconds]]);
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

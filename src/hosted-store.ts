import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { Session, SessionStore } from './auth.js';
import type { AuthProviderId, AuthSession } from './auth.js';
import { DataError } from './core.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function databasePool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('Configura DATABASE_URL.');
  const pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000,
    statement_timeout: 10000, idle_in_transaction_session_timeout: 10000, allowExitOnIdle: true });
  pool.on('error', () => { console.error('La conexión de base de datos se cerró.'); });
  return pool;
}
export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
// Every account mutation takes the same row lock. Upstream cinema requests NEVER
// run inside this transaction; only the final, still-authorized session is saved.
export async function lockUser(client: PoolClient, id: string) {
  const { rows } = await client.query('SELECT token_hash FROM cinev_clients WHERE id=$1 AND revoked_at IS NULL FOR UPDATE', [id]);
  return rows[0]?.token_hash as string | undefined;
}
export class HostedUsers {
  constructor(readonly pool: Pool) {}
  async issue() {
    const id = randomUUID(), token = `cv_${id}.${randomBytes(32).toString('hex')}`;
    await this.pool.query('INSERT INTO cinev_clients(id,token_hash) VALUES($1,$2)', [id, digest(token)]);
    return { id, token };
  }
  async authenticate(token: string) {
    const match = token.match(/^cv_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.[a-f0-9]{64}$/);
    if (!match) return undefined;
    const id = match[1], expected = await this.hash(id);
    if (!expected || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(digest(token), 'hex'))) return undefined;
    return { id, tokenHash: expected };
  }
  async hash(id: string): Promise<string | undefined> {
    const { rows } = await this.pool.query('SELECT token_hash FROM cinev_clients WHERE id=$1 AND revoked_at IS NULL', [id]);
    return rows[0]?.token_hash;
  }
  async revoke(id: string) {
    await transaction(this.pool, async client => {
      await client.query('UPDATE cinev_clients SET revoked_at=now() WHERE id=$1', [id]);
      await client.query('DELETE FROM cinev_links WHERE user_id=$1', [id]);
      await client.query('DELETE FROM cinev_sessions WHERE user_id=$1', [id]);
    });
  }
}
export class EncryptedSessionStore extends SessionStore {
  constructor(readonly pool: Pool, readonly user: string, private key: Buffer) {
    super();
    if (key.length !== 32) throw new Error('La clave de cifrado debe tener 32 bytes.');
  }
  private aad(provider: AuthProviderId) { return Buffer.from(`cinev:v1:${this.user}:${provider}`); }
  encrypt(value: AuthSession) {
    const session = Session.parse(value), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(session.provider));
    const data = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
  override async read(provider: AuthProviderId): Promise<AuthSession | undefined> {
    const { rows } = await this.pool.query(`SELECT ciphertext FROM cinev_sessions s JOIN cinev_clients c ON c.id=s.user_id
      WHERE s.user_id=$1 AND provider=$2 AND c.revoked_at IS NULL`, [this.user, provider]);
    if (!rows.length) return undefined;
    try {
      const { v, iv, tag, data } = JSON.parse(rows[0].ciphertext);
      if (v !== 1 || ![iv, tag, data].every(s => typeof s === 'string')) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
      decipher.setAAD(this.aad(provider)); decipher.setAuthTag(Buffer.from(tag, 'base64'));
      const session = Session.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')));
      if (session.provider !== provider) throw new Error();
      return session;
    } catch { throw new DataError('auth_required', 'Vuelve a conectar tu cuenta con connect_account.'); }
  }
  async saveInTransaction(client: PoolClient, value: AuthSession) {
    await client.query(`INSERT INTO cinev_sessions(user_id,provider,ciphertext,expires_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(user_id,provider) DO UPDATE SET ciphertext=EXCLUDED.ciphertext, expires_at=EXCLUDED.expires_at`,
    [this.user, value.provider, this.encrypt(value), new Date(value.expires_at)]);
  }
  override async save(value: AuthSession) {
    await transaction(this.pool, async client => {
      if (!await lockUser(client, this.user)) throw new Error('Acceso revocado.');
      await this.saveInTransaction(client, value);
    });
  }
  override async remove(provider: AuthProviderId) {
    await transaction(this.pool, async client => {
      await lockUser(client, this.user);
      await client.query('DELETE FROM cinev_links WHERE user_id=$1 AND provider=$2', [this.user, provider]);
      await client.query('DELETE FROM cinev_sessions WHERE user_id=$1 AND provider=$2', [this.user, provider]);
    });
  }
  override async status(provider: AuthProviderId) { return { ...await super.status(provider), login_command: 'connect_account' }; }
}

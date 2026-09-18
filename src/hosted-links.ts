import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { digest, EncryptedSessionStore, lockUser, transaction } from './hosted-store.js';
import type { AuthProviderId, AuthSession } from './auth.js';

type Connection = { user: string; tokenHash: string; provider: AuthProviderId; expires: number; attempts: number; busy: boolean };
export class ConnectionLinks {
  constructor(readonly pool: Pool) {}
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
  async budget(key: string, limit: number) {
    const { rows } = await this.pool.query(`INSERT INTO cinev_budgets(key_hash,expires_at,count)
      VALUES($1,now()+interval '1 minute',1) ON CONFLICT(key_hash) DO UPDATE SET
      count=CASE WHEN cinev_budgets.expires_at<=now() THEN 1 ELSE LEAST(cinev_budgets.count+1,$2+1) END,
      expires_at=CASE WHEN cinev_budgets.expires_at<=now() THEN EXCLUDED.expires_at ELSE cinev_budgets.expires_at END
      RETURNING count`, [digest(key), limit]);
    return rows[0].count <= limit;
  }
  async cleanup() {
    await this.pool.query('DELETE FROM cinev_oauth_requests WHERE expires_at<=now()');
    // Keep consumed refresh tokens until the grant expires to detect replay.
    await this.pool.query("DELETE FROM cinev_oauth_tokens WHERE kind='access' AND expires_at<=now()");
    await this.pool.query(`DELETE FROM cinev_clients c USING cinev_oauth_grants g
      WHERE c.id=g.user_id AND (g.expires_at<=now() OR c.revoked_at IS NOT NULL)`);
    await this.pool.query('DELETE FROM cinev_links WHERE expires_at<=now()');
    await this.pool.query('DELETE FROM cinev_budgets WHERE expires_at<=now()');
    await this.pool.query('DELETE FROM cinev_sessions WHERE expires_at<=now()');
  }
}

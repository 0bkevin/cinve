CREATE TABLE IF NOT EXISTS cinev_clients (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS cinev_sessions (
  user_id uuid NOT NULL REFERENCES cinev_clients(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('cinex','cinesunidos')),
  ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(user_id, provider)
);
CREATE TABLE IF NOT EXISTS cinev_links (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES cinev_clients(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('cinex','cinesunidos')),
  stage text NOT NULL CHECK (stage IN ('invitation','browser')),
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  busy boolean NOT NULL DEFAULT false,
  UNIQUE(user_id, provider)
);
CREATE INDEX IF NOT EXISTS cinev_links_expiry ON cinev_links(expires_at);
CREATE TABLE IF NOT EXISTS cinev_budgets (
  key_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  count integer NOT NULL
);

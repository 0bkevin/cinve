CREATE TABLE IF NOT EXISTS cinev_oauth_apps (
  id text PRIMARY KEY,
  name text NOT NULL,
  redirect_uris jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cinev_oauth_requests (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES cinev_oauth_apps(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  state text,
  challenge text NOT NULL,
  csrf_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  code_hash text UNIQUE,
  user_id uuid REFERENCES cinev_clients(id) ON DELETE CASCADE,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS cinev_oauth_requests_expiry ON cinev_oauth_requests(expires_at);
CREATE TABLE IF NOT EXISTS cinev_oauth_grants (
  user_id uuid PRIMARY KEY REFERENCES cinev_clients(id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES cinev_oauth_apps(id),
  resource text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS cinev_oauth_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES cinev_oauth_grants(user_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('access','refresh')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS cinev_oauth_tokens_user ON cinev_oauth_tokens(user_id);

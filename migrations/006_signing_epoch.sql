-- Service facts recorded by the application. token_signing_since is set by
-- the first instance that signs tokens and links; unsigned ones issued before
-- it are accepted for a bounded time afterwards (see legacyCutoffs).
CREATE TABLE IF NOT EXISTS cinev_meta (key text PRIMARY KEY, value timestamptz NOT NULL);

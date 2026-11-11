-- One cinema sign-in at a time per authorization request (busy_until), and a
-- hard cap on sign-in attempts over the request's whole lifetime.
ALTER TABLE cinev_oauth_requests ADD COLUMN IF NOT EXISTS busy_until timestamptz;
ALTER TABLE cinev_oauth_requests ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

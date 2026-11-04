-- Dynamic client registration is anonymous, so registrations need a retention
-- bound. last_used_at records the last successful token issuance.
ALTER TABLE cinev_oauth_apps ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
CREATE INDEX IF NOT EXISTS cinev_oauth_grants_app ON cinev_oauth_grants(app_id);

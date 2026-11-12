-- Expired rate-limit windows are pruned as they accumulate (not only by the
-- daily cleanup), which needs to find them without scanning live windows.
CREATE INDEX IF NOT EXISTS cinev_budgets_expiry ON cinev_budgets(expires_at);

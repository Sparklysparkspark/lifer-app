-- In-app tips (apps/web lib/tips.ts): which ones each account has seen, and whether tips show at
-- all. Per account, so a tip seen on one device isn't shown again on another.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tips_seen text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS tips_enabled boolean NOT NULL DEFAULT true;

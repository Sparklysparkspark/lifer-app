-- Account creation models Immich's first-run setup instead of invite codes: the one account
-- this single-user instance ever has is created at first run (see auth/routes.ts's
-- /auth/setup-status and the first-account-only /auth/register), with no invite-code flow.
ALTER TABLE users DROP COLUMN invite_code_used;
DROP TABLE invite_codes;

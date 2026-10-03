-- Password recovery is `lifer-admin reset-password` in the container's shell, with no email,
-- so the reset-link table and the address those links went to are unused.
DROP TABLE IF EXISTS password_reset_tokens;
ALTER TABLE users DROP COLUMN IF EXISTS recovery_email;

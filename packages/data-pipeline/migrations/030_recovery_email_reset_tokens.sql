-- Account settings: recovery_email is a separate delivery address for password-reset mail —
-- useful since a self-hosted single-user instance may use a login email that isn't a real
-- inbox. NULL means "use the login email" (see auth/routes.ts's forgot-password handler).
ALTER TABLE users ADD COLUMN recovery_email text NULL;

CREATE TABLE password_reset_tokens (
  token       text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_password_reset_tokens_user_id ON password_reset_tokens (user_id);

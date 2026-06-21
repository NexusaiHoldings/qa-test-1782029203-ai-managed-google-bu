/**
 * Google Business Profile OAuth connections schema (F1-002).
 *
 * Stores per-user GBP OAuth tokens (encrypted at rest) and connection metadata.
 * Picked up by packages/db/migrate.ts via the *_DDL constant convention.
 */
export const GBP_DDL = `
CREATE TABLE IF NOT EXISTS gbp_connections (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL,
  google_account_id text        NOT NULL,
  location_name     text,
  access_token_enc  text        NOT NULL,
  refresh_token_enc text        NOT NULL,
  token_expires_at  timestamptz NOT NULL,
  scopes            text        NOT NULL DEFAULT '',
  connected_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, google_account_id)
);
CREATE INDEX IF NOT EXISTS idx_gbp_connections_user_id
  ON gbp_connections (user_id);
CREATE INDEX IF NOT EXISTS idx_gbp_connections_expires
  ON gbp_connections (token_expires_at);
`;

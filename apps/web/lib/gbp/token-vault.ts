/**
 * GBP token vault — encrypts, stores, retrieves, and rotates
 * Google Business Profile OAuth tokens (F1-002).
 *
 * Encryption: AES-256-GCM. Key from GBP_TOKEN_ENCRYPTION_KEY (32-byte hex env var).
 * Storage: gbp_connections table via the substrate pg pool.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { buildDb } from "@/lib/db";

export interface GbpConnection {
  id: string;
  userId: string;
  googleAccountId: string;
  locationName: string | null;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: Date;
  scopes: string;
  connectedAt: Date;
  updatedAt: Date;
}

interface DbRow {
  id: string;
  user_id: string;
  google_account_id: string;
  location_name: string | null;
  access_token_enc: string;
  refresh_token_enc: string;
  token_expires_at: string;
  scopes: string;
  connected_at: string;
  updated_at: string;
}

export interface StoreConnectionParams {
  userId: string;
  googleAccountId: string;
  locationName?: string | null;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: Date;
  scopes: string;
}

function getEncryptionKey(): Buffer {
  const hex = process.env.GBP_TOKEN_ENCRYPTION_KEY;
  if (!hex) throw new Error("GBP_TOKEN_ENCRYPTION_KEY env var is not set");
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error("GBP_TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
  }
  return buf;
}

function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptToken(ciphertext: string): string {
  const key = getEncryptionKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted token format");
  const [ivHex, authTagHex, encHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(encHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function rowToConnection(row: DbRow): GbpConnection {
  return {
    id: row.id,
    userId: row.user_id,
    googleAccountId: row.google_account_id,
    locationName: row.location_name,
    accessToken: decryptToken(row.access_token_enc),
    refreshToken: decryptToken(row.refresh_token_enc),
    tokenExpiresAt: new Date(row.token_expires_at),
    scopes: row.scopes,
    connectedAt: new Date(row.connected_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** Upsert a GBP OAuth connection. Returns the connection's UUID. */
export async function storeConnection(params: StoreConnectionParams): Promise<string> {
  const db = buildDb();
  const accessEnc = encryptToken(params.accessToken);
  const refreshEnc = encryptToken(params.refreshToken);
  const rows = await db.query<{ id: string }>(
    `INSERT INTO gbp_connections
       (user_id, google_account_id, location_name, access_token_enc,
        refresh_token_enc, token_expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, google_account_id) DO UPDATE SET
       access_token_enc  = EXCLUDED.access_token_enc,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       token_expires_at  = EXCLUDED.token_expires_at,
       scopes            = EXCLUDED.scopes,
       location_name     = COALESCE(EXCLUDED.location_name, gbp_connections.location_name),
       updated_at        = now()
     RETURNING id`,
    params.userId,
    params.googleAccountId,
    params.locationName ?? null,
    accessEnc,
    refreshEnc,
    params.tokenExpiresAt.toISOString(),
    params.scopes,
  );
  return rows[0].id;
}

/** Fetch all GBP connections for a given user (tokens decrypted). */
export async function getConnectionsByUserId(userId: string): Promise<GbpConnection[]> {
  const db = buildDb();
  const rows = await db.query<DbRow>(
    `SELECT id, user_id, google_account_id, location_name,
            access_token_enc, refresh_token_enc, token_expires_at,
            scopes, connected_at, updated_at
     FROM gbp_connections
     WHERE user_id = $1
     ORDER BY connected_at DESC`,
    userId,
  );
  return rows.map(rowToConnection);
}

/** Fetch all connections whose access_token expires at or before `cutoff`. */
export async function getConnectionsExpiringBefore(cutoff: Date): Promise<GbpConnection[]> {
  const db = buildDb();
  const rows = await db.query<DbRow>(
    `SELECT id, user_id, google_account_id, location_name,
            access_token_enc, refresh_token_enc, token_expires_at,
            scopes, connected_at, updated_at
     FROM gbp_connections
     WHERE token_expires_at <= $1
     ORDER BY token_expires_at ASC`,
    cutoff.toISOString(),
  );
  return rows.map(rowToConnection);
}

/** Replace stored tokens after a successful refresh. */
export async function updateTokens(
  connectionId: string,
  accessToken: string,
  refreshToken: string,
  tokenExpiresAt: Date,
): Promise<void> {
  const db = buildDb();
  const accessEnc = encryptToken(accessToken);
  const refreshEnc = encryptToken(refreshToken);
  await db.execute(
    `UPDATE gbp_connections
     SET access_token_enc  = $1,
         refresh_token_enc = $2,
         token_expires_at  = $3,
         updated_at        = now()
     WHERE id = $4`,
    accessEnc,
    refreshEnc,
    tokenExpiresAt.toISOString(),
    connectionId,
  );
}

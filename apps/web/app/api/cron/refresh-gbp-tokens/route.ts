/**
 * GET /api/cron/refresh-gbp-tokens — proactively refresh expiring GBP tokens (F1-002).
 *
 * Finds all gbp_connections whose access_token expires within the next hour
 * and refreshes them via the Google token endpoint to prevent automation gaps.
 * Auth: CRON_SECRET bearer token (same pattern as /api/cron/approved-actions).
 * Schedule: add to vercel.json crons (e.g. every 30 minutes).
 */
import { NextResponse } from "next/server";
import {
  getConnectionsExpiringBefore,
  updateTokens,
} from "@/lib/gbp/token-vault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

interface RefreshResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

function isCronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function refreshAccessToken(refreshToken: string): Promise<RefreshResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<RefreshResponse>;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const cutoff = new Date(Date.now() + 60 * 60 * 1000);
  let connections;
  try {
    connections = await getConnectionsExpiringBefore(cutoff);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "gbp_cron_fetch_failed",
        error: (err as Error).message,
      }),
    );
    return NextResponse.json(
      { error: "fetch_connections_failed", detail: (err as Error).message },
      { status: 500 },
    );
  }

  const results: Array<{ id: string; outcome: string; error?: string }> = [];

  for (const conn of connections) {
    if (!conn.refreshToken) {
      results.push({ id: conn.id, outcome: "skipped_no_refresh_token" });
      continue;
    }
    try {
      const refreshed = await refreshAccessToken(conn.refreshToken);
      const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000);
      await updateTokens(
        conn.id,
        refreshed.access_token,
        refreshed.refresh_token ?? conn.refreshToken,
        newExpiry,
      );
      results.push({ id: conn.id, outcome: "refreshed" });
    } catch (err) {
      const msg = (err as Error).message;
      console.error(
        JSON.stringify({ event: "gbp_token_refresh_failed", connectionId: conn.id, error: msg }),
      );
      results.push({ id: conn.id, outcome: "error", error: msg });
    }
  }

  return NextResponse.json({ checked: connections.length, results });
}

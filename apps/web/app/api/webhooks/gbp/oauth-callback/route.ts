/**
 * GET /api/webhooks/gbp/oauth-callback — Google OAuth callback (F1-002).
 *
 * Fixed URL (Google redirects here after authorization). Verifies the signed
 * state param, exchanges the authorization code for tokens, fetches the
 * Google account ID, then stores encrypted tokens in gbp_connections.
 */
import { NextResponse } from "next/server";
import { createHmac } from "crypto";
import { storeConnection } from "@/lib/gbp/token-vault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token?: string;
}

interface UserInfoResponse {
  id: string;
  email: string;
  name?: string;
}

interface OAuthStatePayload {
  userId: string;
  nonce: string;
  ts: number;
}

function verifyOAuthState(state: string): { userId: string } | null {
  const secret = process.env.NEXTAUTH_SECRET ?? "dev-secret";
  const lastDot = state.lastIndexOf(".");
  if (lastDot === -1) return null;
  const payload = state.slice(0, lastDot);
  const sig = state.slice(lastDot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  if (sig !== expected) return null;
  let decoded: OAuthStatePayload;
  try {
    decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as OAuthStatePayload;
  } catch {
    return null;
  }
  if (Date.now() - decoded.ts > 15 * 60 * 1000) return null;
  return { userId: decoded.userId };
}

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<TokenResponse>;
}

async function getGoogleUserInfo(accessToken: string): Promise<UserInfoResponse> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Userinfo fetch failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<UserInfoResponse>;
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const desc = url.searchParams.get("error_description") ?? oauthError;
    return NextResponse.redirect(
      new URL(`/connect?error=${encodeURIComponent(desc)}`, url.origin),
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/connect?error=missing_params", url.origin),
    );
  }

  const stateData = verifyOAuthState(state);
  if (!stateData) {
    return NextResponse.redirect(
      new URL("/connect?error=invalid_state", url.origin),
    );
  }

  const appUrl =
    process.env.NEXTAUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    url.origin;
  const redirectUri = `${appUrl}/api/webhooks/gbp/oauth-callback`;

  let tokens: TokenResponse;
  try {
    tokens = await exchangeCodeForTokens(code, redirectUri);
  } catch (err) {
    console.error(
      JSON.stringify({ event: "gbp_token_exchange_failed", error: (err as Error).message }),
    );
    return NextResponse.redirect(
      new URL("/connect?error=token_exchange_failed", url.origin),
    );
  }

  let userInfo: UserInfoResponse;
  try {
    userInfo = await getGoogleUserInfo(tokens.access_token);
  } catch (err) {
    console.error(
      JSON.stringify({ event: "gbp_userinfo_failed", error: (err as Error).message }),
    );
    return NextResponse.redirect(
      new URL("/connect?error=userinfo_failed", url.origin),
    );
  }

  const tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  try {
    await storeConnection({
      userId: stateData.userId,
      googleAccountId: userInfo.id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? "",
      tokenExpiresAt,
      scopes: tokens.scope,
    });
  } catch (err) {
    console.error(
      JSON.stringify({ event: "gbp_store_connection_failed", error: (err as Error).message }),
    );
    return NextResponse.redirect(
      new URL("/connect?error=store_failed", url.origin),
    );
  }

  return NextResponse.redirect(new URL("/connect?success=1", url.origin));
}

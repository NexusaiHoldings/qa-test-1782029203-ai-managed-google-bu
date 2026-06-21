/**
 * /connect — GBP OAuth connection page (F1-002).
 *
 * Business owner lands here to initiate the Google Business Profile OAuth flow.
 * Generates a signed state token (HMAC-SHA256) for CSRF protection — no cookie
 * needed since the signature is verified at callback time.
 */
import type { JSX } from "react";
import { redirect } from "next/navigation";
import { createHmac, randomBytes } from "crypto";
import { getSessionUser } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GBP_SCOPES = [
  "https://www.googleapis.com/auth/business.manage",
  "email",
  "openid",
].join(" ");

function buildOAuthState(userId: string): string {
  const secret = process.env.NEXTAUTH_SECRET ?? "dev-secret";
  const nonce = randomBytes(16).toString("hex");
  const payload = Buffer.from(
    JSON.stringify({ userId, nonce, ts: Date.now() }),
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function buildGoogleOAuthUrl(state: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const appUrl =
    process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
  const redirectUri = `${appUrl}/api/webhooks/gbp/oauth-callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GBP_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export default async function GbpConnectPage({
  searchParams,
}: {
  searchParams: { error?: string; success?: string };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) {
    redirect("/login?next=/connect");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return (
      <main>
        <h1>Connect Google Business Profile</h1>
        <p>Google OAuth is not configured for this environment.</p>
        <p className="muted">
          Set <code>GOOGLE_CLIENT_ID</code> and{" "}
          <code>GOOGLE_CLIENT_SECRET</code> to enable this feature.
        </p>
      </main>
    );
  }

  if (searchParams.success === "1") {
    return (
      <main>
        <h1>Google Business Profile Connected</h1>
        <p>
          Your Google Business Profile has been linked successfully. Automation
          will begin shortly.
        </p>
        <a href="/connect" className="btn secondary">
          Connect another account
        </a>
      </main>
    );
  }

  const state = buildOAuthState(user.id);
  const oauthUrl = buildGoogleOAuthUrl(state);

  return (
    <main>
      <h1>Connect Google Business Profile</h1>
      <p>
        Link your Google Business Profile to enable automated post scheduling,
        review responses, and listing management.
      </p>

      {searchParams.error && (
        <div className="card" role="alert">
          <p>
            Connection failed:{" "}
            <span className="muted">{searchParams.error}</span>
          </p>
        </div>
      )}

      <a href={oauthUrl} className="btn">
        Connect with Google
      </a>

      <div className="card" style={{ marginTop: "2rem" }}>
        <h2>What we'll access</h2>
        <ul>
          <li>Read and update your Business Profile information</li>
          <li>Publish posts on your behalf</li>
          <li>Read and respond to customer reviews</li>
        </ul>
        <p className="muted">
          Tokens are encrypted at rest with AES-256-GCM. You can disconnect at
          any time from your account settings.
        </p>
      </div>
    </main>
  );
}

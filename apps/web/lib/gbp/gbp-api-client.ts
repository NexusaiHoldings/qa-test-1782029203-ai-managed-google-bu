export interface GbpConnection {
  id: string;
  locationId: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: Date | null;
}

export interface GbpCallToAction {
  actionType: "LEARN_MORE" | "BOOK" | "ORDER" | "SHOP" | "SIGN_UP" | "CALL";
  url?: string;
}

export interface GbpPostPayload {
  summary: string;
  callToAction?: GbpCallToAction;
}

export interface PublishResult {
  postName: string;
  createTime: string;
}

const GBP_API_BASE = "https://mybusiness.googleapis.com/v4";
const GBP_TOKEN_URL = "https://oauth2.googleapis.com/token";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTokenExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  return Date.now() >= expiresAt.getTime() - 60_000;
}

export async function refreshGbpAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: Date }> {
  const clientId = process.env.GBP_CLIENT_ID;
  const clientSecret = process.env.GBP_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("GBP_CLIENT_ID and GBP_CLIENT_SECRET must be set");
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(GBP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Token refresh failed ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  return { accessToken: data.access_token, expiresAt };
}

export async function publishGbpPost(
  connection: GbpConnection,
  post: GbpPostPayload,
  maxRetries: number = 4
): Promise<PublishResult> {
  let token = connection.accessToken;

  if (isTokenExpired(connection.tokenExpiresAt)) {
    const refreshed = await refreshGbpAccessToken(connection.refreshToken);
    token = refreshed.accessToken;
  }

  const body: Record<string, unknown> = {
    summary: post.summary,
    topicType: "STANDARD",
  };

  if (post.callToAction) {
    body.callToAction = {
      actionType: post.callToAction.actionType,
      ...(post.callToAction.url ? { url: post.callToAction.url } : {}),
    };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(
      `${GBP_API_BASE}/${connection.locationId}/localPosts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      }
    );

    if (response.ok) {
      const data = (await response.json()) as { name: string; createTime: string };
      return { postName: data.name, createTime: data.createTime };
    }

    if (response.status === 401 && attempt === 0) {
      const refreshed = await refreshGbpAccessToken(connection.refreshToken);
      token = refreshed.accessToken;
      continue;
    }

    if (response.status === 429 && attempt < maxRetries) {
      const backoffMs = Math.min(1000 * 2 ** attempt, 32_000);
      await sleep(backoffMs);
      continue;
    }

    const errText = await response.text();
    throw new Error(`GBP API ${response.status} on attempt ${attempt + 1}: ${errText.slice(0, 300)}`);
  }

  throw new Error(`GBP publish failed after ${maxRetries + 1} attempts`);
}

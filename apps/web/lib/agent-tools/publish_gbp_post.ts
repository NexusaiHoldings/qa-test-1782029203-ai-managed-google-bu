/**
 * Agent tool handler: publish_gbp_post
 *
 * Publishes an approved draft from gbp_post_queue to the Google Business
 * Profile API, records the result in gbp_published_posts, and marks the
 * queue entry as published.
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

interface QueueRow {
  readonly id: string;
  readonly business_id: string;
  readonly location_id: string;
  readonly post_content: string;
  readonly status: string;
  readonly call_to_action_type: string | null;
  readonly call_to_action_url: string | null;
  readonly media_url: string | null;
}

interface GbpConnectionRow {
  readonly id: string;
  readonly business_id: string;
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: string;
  readonly account_name: string;
}

interface TokenRefreshResult {
  readonly ok: boolean;
  readonly access_token: string;
  readonly expires_at: Date;
}

async function refreshGbpToken(refreshToken: string): Promise<TokenRefreshResult> {
  const clientId = process.env.GBP_CLIENT_ID ?? "";
  const clientSecret = process.env.GBP_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) {
    return { ok: false, access_token: "", expires_at: new Date() };
  }
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) {
      return { ok: false, access_token: "", expires_at: new Date() };
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    const expires_at = new Date(Date.now() + data.expires_in * 1000);
    return { ok: true, access_token: data.access_token, expires_at };
  } catch {
    return { ok: false, access_token: "", expires_at: new Date() };
  }
}

function buildGbpPostBody(entry: QueueRow): Record<string, unknown> {
  const body: Record<string, unknown> = {
    languageCode: "en-US",
    summary: entry.post_content,
    topicType: "STANDARD",
  };
  if (entry.call_to_action_type && entry.call_to_action_url) {
    body.callToAction = {
      actionType: entry.call_to_action_type,
      url: entry.call_to_action_url,
    };
  }
  if (entry.media_url) {
    body.media = [{ mediaFormat: "PHOTO", sourceUrl: entry.media_url }];
  }
  return body;
}

export async function handlePublishGbpPost(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const queueId = typeof args.queue_id === "string" ? args.queue_id : null;
  if (!queueId) {
    return { status: 400, body: "queue_id is required" };
  }

  let queueRows: QueueRow[];
  try {
    queueRows = await ctx.db.query<QueueRow>(
      `SELECT id, business_id, location_id, post_content, status,
              call_to_action_type, call_to_action_url, media_url
         FROM gbp_post_queue WHERE id = $1::uuid`,
      queueId,
    );
  } catch {
    return { status: 500, body: "database error fetching queue entry" };
  }

  if (queueRows.length === 0) {
    return { status: 404, body: "queue entry not found" };
  }

  const entry = queueRows[0];

  if (entry.status === "published") {
    return { status: 409, body: "post already published" };
  }
  if (entry.status !== "approved" && entry.status !== "pending") {
    return { status: 400, body: `post status '${entry.status}' is not publishable` };
  }

  let connRows: GbpConnectionRow[];
  try {
    connRows = await ctx.db.query<GbpConnectionRow>(
      `SELECT id, business_id, access_token, refresh_token, expires_at, account_name
         FROM gbp_connections WHERE business_id = $1::uuid
         ORDER BY created_at DESC LIMIT 1`,
      entry.business_id,
    );
  } catch {
    return { status: 500, body: "database error fetching GBP connection" };
  }

  if (connRows.length === 0) {
    return { status: 422, body: "no GBP connection found for this business" };
  }

  const conn = connRows[0];
  let accessToken = conn.access_token;

  if (new Date(conn.expires_at) <= new Date()) {
    const refreshed = await refreshGbpToken(conn.refresh_token);
    if (!refreshed.ok) {
      return { status: 502, body: "GBP OAuth token refresh failed" };
    }
    accessToken = refreshed.access_token;
    try {
      await ctx.db.execute(
        "UPDATE gbp_connections SET access_token = $1, expires_at = $2 WHERE id = $3::uuid",
        refreshed.access_token,
        refreshed.expires_at.toISOString(),
        conn.id,
      );
    } catch {
      // Non-fatal: proceed with the refreshed token
    }
  }

  const gbpUrl = `https://mybusiness.googleapis.com/v4/${conn.account_name}/locations/${entry.location_id}/localPosts`;
  let gbpRes: Response;
  try {
    gbpRes = await fetch(gbpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildGbpPostBody(entry)),
    });
  } catch {
    return { status: 502, body: "GBP API request failed" };
  }

  if (!gbpRes.ok) {
    const text = await gbpRes.text().catch(() => "unknown");
    return { status: 502, body: `GBP API error ${gbpRes.status}: ${text}` };
  }

  let gbpData: Record<string, unknown>;
  try {
    gbpData = (await gbpRes.json()) as Record<string, unknown>;
  } catch {
    return { status: 502, body: "GBP API returned non-JSON response" };
  }

  const gbpPostName = typeof gbpData.name === "string" ? gbpData.name : "";
  const publishedId = crypto.randomUUID();

  try {
    await ctx.db.execute(
      `INSERT INTO gbp_published_posts
         (id, business_id, location_id, queue_id, gbp_post_name, post_content, published_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, NOW())`,
      publishedId,
      entry.business_id,
      entry.location_id,
      queueId,
      gbpPostName,
      entry.post_content,
    );
  } catch {
    return { status: 500, body: "failed to record published post" };
  }

  try {
    await ctx.db.execute(
      "UPDATE gbp_post_queue SET status = 'published', updated_at = NOW() WHERE id = $1::uuid",
      queueId,
    );
  } catch {
    // Non-fatal: post published successfully; queue status update can be retried
  }

  await ctx.events.publish("gbp.post_published", {
    queue_id: queueId,
    published_post_id: publishedId,
    location_id: entry.location_id,
    gbp_post_name: gbpPostName,
  });

  return {
    status: 200,
    body: {
      published_post_id: publishedId,
      gbp_post_name: gbpPostName,
      queue_id: queueId,
      location_id: entry.location_id,
    },
  };
}

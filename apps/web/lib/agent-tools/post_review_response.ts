/**
 * Agent tool handler: post_review_response
 *
 * Posts an approved review response to the Google Business Profile API via
 * accounts.locations.reviews.updateReply, then writes the result to
 * gbp_review_responses. Called after draft_review_response for 3-5 star
 * reviews or after human approval for 1-2 star reviews.
 *
 * Autonomy = confirm — this mutation routes through the cross-boundary bridge.
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

interface ReviewResponseDraftRow {
  readonly id: string;
  readonly business_id: string;
  readonly location_id: string;
  readonly review_id: string;
  readonly review_name: string;
  readonly response_text: string;
  readonly status: string;
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
    const expiresAt = new Date(Date.now() + data.expires_in * 1000);
    return { ok: true, access_token: data.access_token, expires_at: expiresAt };
  } catch {
    return { ok: false, access_token: "", expires_at: new Date() };
  }
}

export async function handlePostReviewResponse(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const draftId = typeof args.draft_id === "string" ? args.draft_id : null;
  if (!draftId) {
    return { status: 400, body: "draft_id is required" };
  }

  let draftRows: ReviewResponseDraftRow[];
  try {
    draftRows = await ctx.db.query<ReviewResponseDraftRow>(
      `SELECT id, business_id, location_id, review_id, review_name, response_text, status
         FROM gbp_review_response_drafts WHERE id = $1::uuid`,
      draftId,
    );
  } catch {
    return { status: 500, body: "database error fetching review response draft" };
  }

  if (draftRows.length === 0) {
    return { status: 404, body: "review response draft not found" };
  }

  const draft = draftRows[0];

  if (draft.status === "posted") {
    return { status: 409, body: "review response already posted" };
  }
  if (draft.status !== "approved" && draft.status !== "pending") {
    return {
      status: 400,
      body: `draft status '${draft.status}' is not postable; must be 'approved' or 'pending'`,
    };
  }

  let connRows: GbpConnectionRow[];
  try {
    connRows = await ctx.db.query<GbpConnectionRow>(
      `SELECT id, business_id, access_token, refresh_token, expires_at, account_name
         FROM gbp_connections WHERE business_id = $1::uuid
         ORDER BY created_at DESC LIMIT 1`,
      draft.business_id,
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

  // accounts.locations.reviews.updateReply endpoint
  const gbpUrl = `https://mybusiness.googleapis.com/v4/${conn.account_name}/locations/${draft.location_id}/reviews/${draft.review_id}/reply`;
  let gbpRes: Response;
  try {
    gbpRes = await fetch(gbpUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ comment: draft.response_text }),
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

  const updateTime =
    typeof gbpData.updateTime === "string" ? gbpData.updateTime : new Date().toISOString();
  const responseId = crypto.randomUUID();

  try {
    await ctx.db.execute(
      `INSERT INTO gbp_review_responses
         (id, business_id, location_id, review_id, review_name, draft_id, response_text, gbp_update_time, posted_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, $8, NOW())`,
      responseId,
      draft.business_id,
      draft.location_id,
      draft.review_id,
      draft.review_name,
      draftId,
      draft.response_text,
      updateTime,
    );
  } catch {
    return { status: 500, body: "failed to record posted review response" };
  }

  try {
    await ctx.db.execute(
      "UPDATE gbp_review_response_drafts SET status = 'posted', updated_at = NOW() WHERE id = $1::uuid",
      draftId,
    );
  } catch {
    // Non-fatal: response posted successfully; draft status update can be retried
  }

  await ctx.events.publish("gbp.review_response_posted", {
    draft_id: draftId,
    response_id: responseId,
    review_id: draft.review_id,
    location_id: draft.location_id,
    gbp_update_time: updateTime,
  });

  return {
    status: 200,
    body: {
      response_id: responseId,
      draft_id: draftId,
      review_id: draft.review_id,
      location_id: draft.location_id,
      gbp_update_time: updateTime,
    },
  };
}

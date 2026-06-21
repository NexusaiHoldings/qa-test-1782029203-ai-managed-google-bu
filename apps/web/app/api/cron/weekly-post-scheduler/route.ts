/**
 * GET /api/cron/weekly-post-scheduler
 *
 * Vercel Cron — fires weekly (configured in vercel.json).
 * For each active GBP connection: generates an AI post tailored to the
 * business's trade category and current seasonal context, writes it to
 * gbp_post_queue, then publishes it via the GBP API with exponential
 * backoff on rate-limit errors.
 */

import { NextResponse } from "next/server";
import { buildDb } from "@/lib/db";
import { generateGbpPost, getSeasonalContext } from "@/lib/gbp/post-generator";
import {
  publishGbpPost,
  refreshGbpAccessToken,
} from "@/lib/gbp/gbp-api-client";
import type { VoiceProfile } from "@/lib/gbp/post-generator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

interface GbpConnectionRow {
  id: string;
  location_id: string;
  location_name: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string | null;
  trade_category: string;
  voice_profile: VoiceProfile | null;
  business_name: string;
}

interface PostQueueRow {
  id: string;
}

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!cronAuthorized(request)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const db = buildDb();
  const now = new Date();
  const month = now.getMonth() + 1;

  let connections: GbpConnectionRow[];
  try {
    connections = await db.query<GbpConnectionRow>(
      `SELECT id, location_id, location_name, access_token, refresh_token,
              token_expires_at, trade_category, voice_profile, business_name
       FROM gbp_connections
       WHERE is_active = true`
    );
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch GBP connections", detail: String((err as Error).message) },
      { status: 500 }
    );
  }

  const results: Array<{
    connectionId: string;
    locationName: string;
    outcome: "published" | "queued_failed" | "error";
    postName?: string;
    error?: string;
  }> = [];

  for (const conn of connections) {
    const tradeCategory = conn.trade_category ?? "general";
    const seasonalContext = getSeasonalContext(month, tradeCategory);
    const voiceProfile = conn.voice_profile ?? {
      tone: "friendly and professional",
      keywords: [tradeCategory],
      description: conn.business_name ?? "local service business",
    };

    let generatedContent: string;
    let generatedCta: string;

    try {
      const post = await generateGbpPost({
        businessName: conn.business_name ?? conn.location_name,
        voiceProfile,
        tradeCategory,
        seasonalContext,
        locationName: conn.location_name,
      });
      generatedContent = post.content;
      generatedCta = post.callToAction;
    } catch (err) {
      results.push({
        connectionId: conn.id,
        locationName: conn.location_name,
        outcome: "error",
        error: `Generation failed: ${String((err as Error).message).slice(0, 200)}`,
      });
      continue;
    }

    let queueRow: PostQueueRow[];
    try {
      queueRow = await db.query<PostQueueRow>(
        `INSERT INTO gbp_post_queue
           (id, connection_id, content, call_to_action, status, scheduled_for, created_at, updated_at, is_manual)
         VALUES
           (gen_random_uuid(), $1, $2, $3, 'queued', $4, now(), now(), false)
         RETURNING id`,
        conn.id,
        generatedContent,
        JSON.stringify({ actionType: "LEARN_MORE", label: generatedCta }),
        now.toISOString()
      );
    } catch (err) {
      results.push({
        connectionId: conn.id,
        locationName: conn.location_name,
        outcome: "error",
        error: `Queue insert failed: ${String((err as Error).message).slice(0, 200)}`,
      });
      continue;
    }

    const queueId = queueRow[0]?.id;

    let accessToken = conn.access_token;
    const tokenExpiresAt = conn.token_expires_at ? new Date(conn.token_expires_at) : null;
    const isExpired = tokenExpiresAt ? Date.now() >= tokenExpiresAt.getTime() - 60_000 : false;

    if (isExpired) {
      try {
        const refreshed = await refreshGbpAccessToken(conn.refresh_token);
        accessToken = refreshed.accessToken;
        await db.execute(
          `UPDATE gbp_connections SET access_token = $1, token_expires_at = $2, updated_at = now() WHERE id = $3`,
          accessToken,
          refreshed.expiresAt.toISOString(),
          conn.id
        );
      } catch (err) {
        await db.execute(
          `UPDATE gbp_post_queue SET status = 'failed', error_message = $1, updated_at = now() WHERE id = $2`,
          `Token refresh failed: ${String((err as Error).message).slice(0, 200)}`,
          queueId
        ).catch(() => {});
        results.push({
          connectionId: conn.id,
          locationName: conn.location_name,
          outcome: "queued_failed",
          error: "Token refresh failed",
        });
        continue;
      }
    }

    try {
      const publishResult = await publishGbpPost(
        {
          id: conn.id,
          locationId: conn.location_id,
          accessToken,
          refreshToken: conn.refresh_token,
          tokenExpiresAt,
        },
        {
          summary: generatedContent,
          callToAction: { actionType: "LEARN_MORE" },
        }
      );

      await db.execute(
        `UPDATE gbp_post_queue
         SET status = 'published', gbp_post_name = $1, published_at = now(), updated_at = now()
         WHERE id = $2`,
        publishResult.postName,
        queueId
      );

      results.push({
        connectionId: conn.id,
        locationName: conn.location_name,
        outcome: "published",
        postName: publishResult.postName,
      });
    } catch (err) {
      const errMsg = String((err as Error).message).slice(0, 300);
      await db.execute(
        `UPDATE gbp_post_queue
         SET status = 'failed', error_message = $1, retry_count = COALESCE(retry_count, 0) + 1, updated_at = now()
         WHERE id = $2`,
        errMsg,
        queueId
      ).catch(() => {});
      results.push({
        connectionId: conn.id,
        locationName: conn.location_name,
        outcome: "queued_failed",
        error: errMsg,
      });
    }
  }

  return NextResponse.json({
    processed: connections.length,
    published: results.filter((r) => r.outcome === "published").length,
    failed: results.filter((r) => r.outcome !== "published").length,
    results,
  });
}

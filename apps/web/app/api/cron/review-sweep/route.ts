/**
 * GET /api/cron/review-sweep
 *
 * Scheduled review ingestion and sentiment-aware response engine.
 * For each connected GBP location, polls the Google My Business API for
 * reviews newer than the last-seen review time, stores them in gbp_reviews,
 * classifies sentiment, and either:
 *   - 3-5 stars: drafts + posts an autonomous response via the voice profile
 *   - 1-2 stars: routes to human_review queue for manual follow-up
 *
 * Schedule: every hour (vercel.json crons). Auth: CRON_SECRET bearer token.
 */

import { NextResponse } from "next/server";
import { buildDb } from "@/lib/db";
import { processReview } from "@/lib/gbp/review-responder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

interface Db {
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  execute(sql: string, ...params: unknown[]): Promise<void>;
}

interface ConnectionRow {
  id: string;
  location_id: string;
  access_token: string;
  business_name: string;
  last_review_swept_at: string | null;
}

interface GbpReviewItem {
  name: string;
  reviewId: string;
  reviewer: { displayName?: string };
  starRating: string;
  comment?: string;
  createTime: string;
  updateTime: string;
}

interface SweepResult {
  connectionId: string;
  businessName: string;
  ingested: number;
  posted: number;
  queued: number;
  errors: number;
}

function _cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // unguarded in dev; prod must set CRON_SECRET
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

function starRatingToNumber(starRating: string): number {
  const map: Record<string, number> = {
    ONE: 1,
    TWO: 2,
    THREE: 3,
    FOUR: 4,
    FIVE: 5,
  };
  return map[starRating.toUpperCase()] ?? 0;
}

async function fetchGbpReviews(
  locationName: string,
  accessToken: string,
): Promise<GbpReviewItem[]> {
  const url = `https://mybusiness.googleapis.com/v4/${locationName}/reviews?pageSize=50&orderBy=updateTime%20desc`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`GBP reviews API error ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { reviews?: GbpReviewItem[] };
  return data.reviews ?? [];
}

async function storeReviewIfNew(
  db: Db,
  connectionId: string,
  item: GbpReviewItem,
  rating: number,
): Promise<string | null> {
  // Upsert: insert new reviews only; skip if already stored
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM gbp_reviews WHERE connection_id = $1 AND review_name = $2`,
    connectionId,
    item.name,
  );
  if (existing.length > 0) return null;

  const rows = await db.query<{ id: string }>(
    `INSERT INTO gbp_reviews
       (id, connection_id, review_name, reviewer_name, rating, comment,
        create_time, update_time, status, created_at)
     VALUES
       (gen_random_uuid(), $1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz,
        'pending', NOW())
     RETURNING id`,
    connectionId,
    item.name,
    item.reviewer?.displayName ?? "Anonymous",
    rating,
    item.comment ?? "",
    item.createTime,
    item.updateTime,
  );
  return rows[0]?.id ?? null;
}

async function sweepConnection(db: Db, conn: ConnectionRow): Promise<SweepResult> {
  const result: SweepResult = {
    connectionId: conn.id,
    businessName: conn.business_name,
    ingested: 0,
    posted: 0,
    queued: 0,
    errors: 0,
  };

  let reviews: GbpReviewItem[];
  try {
    reviews = await fetchGbpReviews(conn.location_id, conn.access_token);
  } catch {
    result.errors += 1;
    return result;
  }

  for (const item of reviews) {
    const rating = starRatingToNumber(item.starRating);
    if (rating === 0) continue; // unrecognized rating — skip

    let reviewId: string | null;
    try {
      reviewId = await storeReviewIfNew(db, conn.id, item, rating);
    } catch {
      result.errors += 1;
      continue;
    }

    if (!reviewId) continue; // already stored previously
    result.ingested += 1;

    try {
      const outcome = await processReview(db, reviewId);
      if (outcome.posted) result.posted += 1;
      else if (outcome.queued) result.queued += 1;
      else if (outcome.error) result.errors += 1;
    } catch {
      result.errors += 1;
    }
  }

  // Stamp the sweep time so next run can skip unchanged connections
  await db.execute(
    `UPDATE gbp_connections SET last_review_swept_at = NOW() WHERE id = $1`,
    conn.id,
  ).catch(() => {}); // best-effort; don't fail the sweep if column missing

  return result;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!_cronAuthorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const db = buildDb() as Db;

  let connections: ConnectionRow[];
  try {
    connections = await db.query<ConnectionRow>(
      `SELECT id, location_id, access_token, business_name, last_review_swept_at
       FROM gbp_connections
       WHERE access_token IS NOT NULL
       ORDER BY last_review_swept_at ASC NULLS FIRST
       LIMIT 20`,
    );
  } catch (err) {
    return NextResponse.json(
      { error: "db_query_failed", detail: String((err as Error).message) },
      { status: 500 },
    );
  }

  if (connections.length === 0) {
    return NextResponse.json({ processed: 0, results: [] });
  }

  const results: SweepResult[] = [];
  for (const conn of connections) {
    const sweepResult = await sweepConnection(db, conn);
    results.push(sweepResult);
  }

  const totals = results.reduce(
    (acc, r) => ({
      ingested: acc.ingested + r.ingested,
      posted: acc.posted + r.posted,
      queued: acc.queued + r.queued,
      errors: acc.errors + r.errors,
    }),
    { ingested: 0, posted: 0, queued: 0, errors: 0 },
  );

  return NextResponse.json({
    processed: connections.length,
    ...totals,
    results,
  });
}

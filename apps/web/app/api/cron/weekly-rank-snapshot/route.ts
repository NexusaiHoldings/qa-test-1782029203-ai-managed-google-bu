/**
 * GET /api/cron/weekly-rank-snapshot — Vercel Cron handler (F1-006).
 *
 * Runs weekly to fetch Google Maps local-pack rankings for every business's
 * tracked keywords and persist position snapshots in gbp_rank_snapshots.
 * Auth: Vercel sends `Authorization: Bearer <CRON_SECRET>`; when CRON_SECRET
 * is unset (dev) the route runs unguarded.
 */

import { NextResponse } from "next/server";
import {
  listAllActiveBusinessIds,
  runSnapshotForBusiness,
} from "@/lib/gbp/rank-tracker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!cronAuthorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  let businessIds: string[];
  try {
    businessIds = await listAllActiveBusinessIds();
  } catch (e) {
    return NextResponse.json(
      { error: String((e as Error).message) },
      { status: 502 },
    );
  }

  if (businessIds.length === 0) {
    return NextResponse.json({ skipped: true, reason: "no_active_keywords" });
  }

  const results: Array<{
    business_id: string;
    processed: number;
    errors: number;
  }> = [];

  for (const businessId of businessIds) {
    const { processed, errors } = await runSnapshotForBusiness(businessId);
    results.push({ business_id: businessId, processed, errors });
  }

  const totalProcessed = results.reduce((sum, r) => sum + r.processed, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);

  return NextResponse.json({
    businesses: results.length,
    total_processed: totalProcessed,
    total_errors: totalErrors,
    results,
  });
}

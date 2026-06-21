import { NextRequest, NextResponse } from 'next/server';
import { getAllBusinessesWithDigestEnabled } from '@/lib/gbp/activity-feed';
import { buildWeeklyDigestForBusiness } from '@/lib/gbp/weekly-digest-builder';
import type { DigestResult } from '@/lib/gbp/weekly-digest-builder';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  let businesses: Awaited<ReturnType<typeof getAllBusinessesWithDigestEnabled>>;
  try {
    businesses = await getAllBusinessesWithDigestEnabled();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Failed to load businesses: ${message}` }, { status: 500 });
  }

  if (businesses.length === 0) {
    return NextResponse.json({
      processed: 0,
      sent: 0,
      failed: 0,
      timestamp: new Date().toISOString(),
      results: [],
    });
  }

  const settled = await Promise.allSettled(
    businesses.map((biz) =>
      buildWeeklyDigestForBusiness(biz.id, biz.businessName, biz.ownerEmail, biz.userId),
    ),
  );

  const results: DigestResult[] = settled.map((outcome, idx) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    return {
      businessId: businesses[idx].id,
      sent: false,
      error:
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason),
    };
  });

  const sent = results.filter((r) => r.sent).length;
  const failed = results.filter((r) => !r.sent).length;

  return NextResponse.json({
    processed: businesses.length,
    sent,
    failed,
    timestamp: new Date().toISOString(),
    results,
  });
}

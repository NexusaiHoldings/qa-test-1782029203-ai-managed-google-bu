import { Pool } from 'pg';
import { handleSendNotification } from '@nexus/notifications';
import type { Db, DbRow, HandlerContext } from '@nexus/notifications';
import { getWeeklyActivities } from './activity-feed';
import type { ActivityItem } from './activity-feed';

export interface DigestStats {
  postsPublished: number;
  reviewsResponded: number;
  rankingChanges: number;
  totalActions: number;
}

export interface DigestResult {
  businessId: string;
  sent: boolean;
  error?: string;
}

let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    const connString = process.env.DATABASE_URL;
    if (!connString) throw new Error('DATABASE_URL is not configured');
    _pool = new Pool({ connectionString: connString, max: 5 });
  }
  return _pool;
}

function createDb(pool: Pool): Db {
  return {
    async query<T = DbRow>(sql: string, ...params: unknown[]): Promise<T[]> {
      const result = await pool.query(sql, params as unknown[]);
      return result.rows as T[];
    },
    async execute(sql: string, ...params: unknown[]): Promise<void> {
      await pool.query(sql, params as unknown[]);
    },
  };
}

function buildHandlerContext(): HandlerContext {
  return {
    db: createDb(getPool()),
    events: {
      async publish(_subject: string, _payload: Record<string, unknown>): Promise<void> {},
    },
  };
}

function computeStats(activities: ActivityItem[]): DigestStats {
  const stats: DigestStats = {
    postsPublished: 0,
    reviewsResponded: 0,
    rankingChanges: 0,
    totalActions: activities.length,
  };
  for (const act of activities) {
    if (act.type === 'post_published') stats.postsPublished++;
    else if (act.type === 'review_responded') stats.reviewsResponded++;
    else if (act.type === 'ranking_change') stats.rankingChanges++;
  }
  return stats;
}

function buildDigestHtml(
  businessName: string,
  weekStart: Date,
  weekEnd: Date,
  activities: ActivityItem[],
  stats: DigestStats,
): string {
  const fmtFull = (d: Date): string =>
    d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const fmtShort = (d: Date): string =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const dashboardUrl = process.env.NEXTAUTH_URL
    ? `${process.env.NEXTAUTH_URL}/dashboard`
    : '/dashboard';

  const typeLabel: Record<string, string> = {
    post_published: 'Post Published',
    review_responded: 'Review Responded',
    ranking_change: 'Ranking Update',
    post_queued: 'Post Queued',
    review_queued: 'Review Queued',
  };

  const rowsHtml = activities
    .slice(0, 10)
    .map(
      (a) =>
        `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${fmtShort(new Date(a.createdAt))}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${typeLabel[a.type] ?? a.type}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${a.title}</td>
    </tr>`,
    )
    .join('\n');

  const overflow =
    activities.length > 10
      ? `<p style="color:#6b7280;font-size:14px;">…and ${activities.length - 10} more actions this week.</p>`
      : '';

  const activitySection =
    activities.length > 0
      ? `<h3 style="font-size:16px;font-weight:600;color:#111827;margin:0 0 12px;">Recent Activity</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:8px 12px;text-align:left;font-weight:600;color:#374151;">Date</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;color:#374151;">Type</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;color:#374151;">Description</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>${overflow}`
      : '<p style="color:#6b7280;">No AI actions were completed this week.</p>';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>Weekly AI Activity Digest</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;margin:0;padding:0;">
<div style="max-width:600px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
  <div style="background:#1d4ed8;padding:32px 40px;">
    <h2 style="color:#fff;margin:0;font-size:20px;">Weekly AI Activity Report</h2>
    <p style="color:#bfdbfe;margin:6px 0 0;">${businessName} &mdash; ${fmtFull(weekStart)} &ndash; ${fmtFull(weekEnd)}</p>
  </div>
  <div style="padding:32px 40px;">
    <table style="width:100%;border-collapse:collapse;margin-bottom:32px;">
      <tr>
        <td style="text-align:center;background:#eff6ff;border-radius:8px;padding:16px;">
          <div style="font-size:2rem;font-weight:700;color:#1d4ed8;">${stats.postsPublished}</div>
          <div style="font-size:13px;color:#4b5563;margin-top:4px;">Posts Published</div>
        </td>
        <td style="width:12px;"></td>
        <td style="text-align:center;background:#f0fdf4;border-radius:8px;padding:16px;">
          <div style="font-size:2rem;font-weight:700;color:#16a34a;">${stats.reviewsResponded}</div>
          <div style="font-size:13px;color:#4b5563;margin-top:4px;">Reviews Responded</div>
        </td>
        <td style="width:12px;"></td>
        <td style="text-align:center;background:#faf5ff;border-radius:8px;padding:16px;">
          <div style="font-size:2rem;font-weight:700;color:#7c3aed;">${stats.rankingChanges}</div>
          <div style="font-size:13px;color:#4b5563;margin-top:4px;">Ranking Updates</div>
        </td>
      </tr>
    </table>
    ${activitySection}
    <div style="margin-top:32px;">
      <a href="${dashboardUrl}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">View Full Dashboard</a>
    </div>
  </div>
  <div style="padding:16px 40px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
    You received this because you have AI automation enabled for ${businessName}.
  </div>
</div>
</body>
</html>`;
}

export async function buildWeeklyDigestForBusiness(
  businessId: string,
  businessName: string,
  ownerEmail: string,
  userId: string,
): Promise<DigestResult> {
  try {
    const now = new Date();
    const weekEnd = new Date(now);
    weekEnd.setHours(0, 0, 0, 0);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 7);

    const activities = await getWeeklyActivities(businessId, weekStart, weekEnd);
    const stats = computeStats(activities);
    const html = buildDigestHtml(businessName, weekStart, weekEnd, activities, stats);
    const ctx = buildHandlerContext();

    const result = await handleSendNotification({
      body: {
        user_id: userId,
        template_name: 'weekly_activity_digest',
        category: 'digest',
        to_email: ownerEmail,
        html_template: html,
        variables: {
          businessName,
          totalActions: String(stats.totalActions),
          postsPublished: String(stats.postsPublished),
          reviewsResponded: String(stats.reviewsResponded),
          rankingChanges: String(stats.rankingChanges),
        },
      },
      config: {
        default_channels: ['email'],
        resend_from_email:
          process.env.RESEND_FROM_EMAIL ?? 'noreply@example.com',
      },
      ctx,
    });

    if (result.status >= 400) {
      return { businessId, sent: false, error: String(result.body) };
    }
    return { businessId, sent: true };
  } catch (error) {
    return {
      businessId,
      sent: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

import { Pool } from 'pg';

export type ActivityType =
  | 'post_published'
  | 'review_responded'
  | 'ranking_change'
  | 'post_queued'
  | 'review_queued';

export type ActivityStatus = 'completed' | 'queued' | 'approved' | 'rejected';

export interface ActivityItem {
  id: string;
  businessId: string;
  type: ActivityType;
  status: ActivityStatus;
  title: string;
  description: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ActivityFeedResult {
  items: ActivityItem[];
  total: number;
  hasMore: boolean;
}

export interface GbpBusiness {
  id: string;
  userId: string;
  businessName: string;
  ownerEmail: string;
}

let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    const connString = process.env.DATABASE_URL;
    if (!connString) throw new Error('DATABASE_URL is not configured');
    _pool = new Pool({ connectionString: connString, max: 10 });
  }
  return _pool;
}

export async function getActivities(
  businessId: string,
  limit: number = 20,
  offset: number = 0,
): Promise<ActivityFeedResult> {
  const pool = getPool();
  const [countRes, rowsRes] = await Promise.all([
    pool.query<{ count: string }>(
      'SELECT COUNT(*) FROM ai_activities WHERE business_id = $1',
      [businessId],
    ),
    pool.query<{
      id: string;
      business_id: string;
      type: ActivityType;
      status: ActivityStatus;
      title: string;
      description: string;
      metadata: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, business_id, type, status, title, description, metadata,
              created_at, updated_at
       FROM ai_activities
       WHERE business_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [businessId, limit, offset],
    ),
  ]);

  const total = parseInt(countRes.rows[0]?.count ?? '0', 10);
  const items: ActivityItem[] = rowsRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    type: r.type,
    status: r.status,
    title: r.title,
    description: r.description,
    metadata: r.metadata ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  return { items, total, hasMore: offset + limit < total };
}

export async function approveActivity(activityId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE ai_activities
     SET status = 'approved', updated_at = NOW()
     WHERE id = $1 AND status = 'queued'`,
    [activityId],
  );
}

export async function rejectActivity(activityId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE ai_activities
     SET status = 'rejected', updated_at = NOW()
     WHERE id = $1 AND status = 'queued'`,
    [activityId],
  );
}

export async function getWeeklyActivities(
  businessId: string,
  weekStart: Date,
  weekEnd: Date,
): Promise<ActivityItem[]> {
  const pool = getPool();
  const res = await pool.query<{
    id: string;
    business_id: string;
    type: ActivityType;
    status: ActivityStatus;
    title: string;
    description: string;
    metadata: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, business_id, type, status, title, description, metadata,
            created_at, updated_at
     FROM ai_activities
     WHERE business_id = $1
       AND created_at >= $2
       AND created_at < $3
       AND status IN ('completed', 'approved')
     ORDER BY created_at DESC`,
    [businessId, weekStart, weekEnd],
  );

  return res.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    type: r.type,
    status: r.status,
    title: r.title,
    description: r.description,
    metadata: r.metadata ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getBusinessForUser(userId: string): Promise<GbpBusiness | null> {
  const pool = getPool();
  const res = await pool.query<{
    id: string;
    user_id: string;
    business_name: string;
    owner_email: string;
  }>(
    `SELECT gc.id, gc.user_id, gc.business_name, u.email AS owner_email
     FROM gbp_connections gc
     JOIN users u ON u.id = gc.user_id
     WHERE gc.user_id = $1
     LIMIT 1`,
    [userId],
  );

  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    businessName: row.business_name,
    ownerEmail: row.owner_email,
  };
}

export async function getAllBusinessesWithDigestEnabled(): Promise<GbpBusiness[]> {
  const pool = getPool();
  const res = await pool.query<{
    id: string;
    user_id: string;
    business_name: string;
    owner_email: string;
  }>(
    `SELECT gc.id, gc.user_id, gc.business_name, u.email AS owner_email
     FROM gbp_connections gc
     JOIN users u ON u.id = gc.user_id
     WHERE gc.digest_enabled = true`,
  );

  return res.rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    businessName: r.business_name,
    ownerEmail: r.owner_email,
  }));
}

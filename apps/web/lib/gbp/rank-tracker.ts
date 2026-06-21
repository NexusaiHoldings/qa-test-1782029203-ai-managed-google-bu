/**
 * GBP keyword rank tracker (F1-006).
 *
 * Fetches Google Maps / Local Pack rankings for up to 20 service-area
 * keywords per business via the DataForSEO API, then persists position
 * snapshots in gbp_rank_snapshots for monthly delta reporting.
 */

export interface GbpKeyword {
  id: string;
  business_id: string;
  keyword: string;
  location: string | null;
  is_active: boolean;
  created_at: string;
}

export interface CompetitorEntry {
  name: string;
  position: number;
  rating: number | null;
  reviews: number | null;
}

export interface RankSnapshot {
  id: string;
  business_id: string;
  keyword_id: string;
  keyword: string;
  rank_position: number | null;
  competitor_data: CompetitorEntry[];
  snapshot_date: string;
  created_at: string;
}

export interface KeywordRankDelta {
  keyword: string;
  current_position: number | null;
  previous_position: number | null;
  delta: number | null;
  competitor_data: CompetitorEntry[];
  snapshot_date: string;
}

export interface MonthlyRankReport {
  business_id: string;
  month: string;
  keywords: KeywordRankDelta[];
  generated_at: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pool: any = null;

function getPool(): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
} {
  if (_pool) return _pool as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    };
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
}

function normalizeCompetitors(raw: unknown): CompetitorEntry[] {
  if (!raw) return [];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as CompetitorEntry[]) : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) return raw as CompetitorEntry[];
  return [];
}

export async function listKeywordsForBusiness(businessId: string): Promise<GbpKeyword[]> {
  try {
    const { rows } = await getPool().query(
      `SELECT id, business_id, keyword, location, is_active, created_at
         FROM gbp_keywords
        WHERE business_id = $1 AND is_active = true
        ORDER BY created_at ASC
        LIMIT 20`,
      [businessId],
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      business_id: String(r.business_id),
      keyword: String(r.keyword),
      location: r.location ? String(r.location) : null,
      is_active: Boolean(r.is_active),
      created_at: String(r.created_at),
    }));
  } catch {
    return [];
  }
}

export async function listAllActiveBusinessIds(): Promise<string[]> {
  try {
    const { rows } = await getPool().query(
      `SELECT DISTINCT business_id FROM gbp_keywords WHERE is_active = true`,
    );
    return (rows as Record<string, unknown>[]).map((r) => String(r.business_id));
  } catch {
    return [];
  }
}

export async function fetchKeywordRankings(
  keyword: string,
  location: string,
): Promise<{ position: number | null; competitors: CompetitorEntry[] }> {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;

  if (!login || !password) {
    return { position: null, competitors: [] };
  }

  const endpoint =
    process.env.DATAFORSEO_ENDPOINT ?? "https://api.dataforseo.com";
  const credentials = Buffer.from(`${login}:${password}`).toString("base64");

  try {
    const resp = await fetch(
      `${endpoint}/v3/serp/google/local_pack/live/advanced`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify([
          {
            keyword,
            location_name: location || "United States",
            language_code: "en",
            depth: 20,
          },
        ]),
      },
    );

    if (!resp.ok) {
      return { position: null, competitors: [] };
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const tasks = (data.tasks as Record<string, unknown>[] | undefined) ?? [];
    const task = tasks[0] as Record<string, unknown> | undefined;
    if (!task) return { position: null, competitors: [] };

    const results = (task.result as Record<string, unknown>[] | undefined) ?? [];
    const result = results[0] as Record<string, unknown> | undefined;
    if (!result) return { position: null, competitors: [] };

    const items = (result.items as Record<string, unknown>[] | undefined) ?? [];
    const localItems = items.filter(
      (item) => (item as Record<string, unknown>).type === "local_pack",
    ) as Record<string, unknown>[];

    const competitors: CompetitorEntry[] = localItems.map((item, idx) => ({
      name: String(item.title ?? item.domain ?? `Competitor ${idx + 1}`),
      position: typeof item.rank_group === "number" ? item.rank_group : idx + 1,
      rating: item.rating != null ? Number(item.rating) : null,
      reviews:
        item.reviews_count != null ? Number(item.reviews_count) : null,
    }));

    const topPosition =
      competitors.length > 0 ? competitors[0].position : null;

    return { position: topPosition, competitors };
  } catch {
    return { position: null, competitors: [] };
  }
}

export async function saveRankSnapshot(
  businessId: string,
  keywordId: string,
  keyword: string,
  position: number | null,
  competitors: CompetitorEntry[],
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO gbp_rank_snapshots
         (business_id, keyword_id, keyword, rank_position, competitor_data, snapshot_date)
       VALUES ($1, $2, $3, $4, $5::jsonb, CURRENT_DATE)
       ON CONFLICT (business_id, keyword_id, snapshot_date)
       DO UPDATE SET
         rank_position   = EXCLUDED.rank_position,
         competitor_data = EXCLUDED.competitor_data`,
      [businessId, keywordId, keyword, position, JSON.stringify(competitors)],
    );
  } catch {
    // Table may not exist on a fresh deploy; swallow so the cron doesn't fail hard
  }
}

export async function getMonthlyReport(
  businessId: string,
  month: string,
): Promise<MonthlyRankReport> {
  // month format: "YYYY-MM"
  const startDate = `${month}-01`;
  // Use the last day of the month by truncating to the next month minus 1 day
  const [yr, mo] = month.split("-").map(Number);
  const nextMonth = mo === 12 ? `${yr + 1}-01-01` : `${yr}-${String(mo + 1).padStart(2, "0")}-01`;

  try {
    const { rows } = await getPool().query(
      `SELECT
           s.keyword,
           s.rank_position,
           s.competitor_data,
           s.snapshot_date::text,
           LAG(s.rank_position) OVER (
             PARTITION BY s.business_id, s.keyword
             ORDER BY s.snapshot_date
           ) AS previous_position
         FROM gbp_rank_snapshots s
        WHERE s.business_id = $1
          AND s.snapshot_date >= $2::date
          AND s.snapshot_date < $3::date
        ORDER BY s.keyword, s.snapshot_date DESC`,
      [businessId, startDate, nextMonth],
    );

    const seen = new Set<string>();
    const keywords: KeywordRankDelta[] = [];

    for (const r of rows as Record<string, unknown>[]) {
      const kw = String(r.keyword);
      if (seen.has(kw)) continue;
      seen.add(kw);

      const current =
        r.rank_position != null ? Number(r.rank_position) : null;
      const previous =
        r.previous_position != null ? Number(r.previous_position) : null;
      // positive delta = improved (moved up), negative = dropped
      const delta =
        current != null && previous != null ? previous - current : null;

      keywords.push({
        keyword: kw,
        current_position: current,
        previous_position: previous,
        delta,
        competitor_data: normalizeCompetitors(r.competitor_data),
        snapshot_date: String(r.snapshot_date),
      });
    }

    return { business_id: businessId, month, keywords, generated_at: new Date().toISOString() };
  } catch {
    return { business_id: businessId, month, keywords: [], generated_at: new Date().toISOString() };
  }
}

export async function runSnapshotForBusiness(businessId: string): Promise<{
  processed: number;
  errors: number;
}> {
  const keywords = await listKeywordsForBusiness(businessId);
  let processed = 0;
  let errors = 0;

  for (const kw of keywords) {
    try {
      const loc = kw.location ?? "";
      const { position, competitors } = await fetchKeywordRankings(kw.keyword, loc);
      await saveRankSnapshot(businessId, kw.id, kw.keyword, position, competitors);
      processed++;
    } catch {
      errors++;
    }
  }

  return { processed, errors };
}

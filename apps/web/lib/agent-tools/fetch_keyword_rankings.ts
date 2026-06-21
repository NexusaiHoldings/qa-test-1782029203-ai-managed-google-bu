/**
 * Agent tool handler: fetch_keyword_rankings
 *
 * Calls the DataForSEO Local Pack API for each of a business's tracked
 * service-area keywords, writes position snapshots to gbp_rank_snapshots,
 * and returns delta vs prior week. Called by the weekly rank snapshot cron.
 *
 * Autonomy = autonomous — executes inline without cross-boundary confirmation.
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

interface KeywordRow {
  readonly id: string;
  readonly business_id: string;
  readonly keyword: string;
  readonly location_code: number;
  readonly language_code: string;
}

interface PriorSnapshotRow {
  readonly keyword_id: string;
  readonly position: number | null;
  readonly snapped_at: string;
}

interface DataForSeoLocalPackItem {
  readonly title: string | null;
  readonly domain: string | null;
  readonly rank_group: number | null;
  readonly rank_absolute: number | null;
}

interface DataForSeoTaskResult {
  readonly keyword: string | null;
  readonly position: number | null;
  readonly title: string | null;
  readonly domain: string | null;
}

interface RankingDelta {
  readonly keyword_id: string;
  readonly keyword: string;
  readonly current_position: number | null;
  readonly prior_position: number | null;
  readonly delta: number | null;
  readonly snapshot_id: string;
}

async function fetchLocalPackRanking(
  keyword: string,
  locationCode: number,
  languageCode: string,
  businessDomain: string,
): Promise<DataForSeoTaskResult> {
  const login = process.env.DATAFORSEO_LOGIN ?? "";
  const password = process.env.DATAFORSEO_PASSWORD ?? "";
  if (!login || !password) {
    return { keyword, position: null, title: null, domain: null };
  }

  const credentials = Buffer.from(`${login}:${password}`).toString("base64");
  const payload = [
    {
      keyword,
      location_code: locationCode,
      language_code: languageCode,
      depth: 20,
    },
  ];

  let res: Response;
  try {
    res = await fetch("https://api.dataforseo.com/v3/serp/google/local_pack/live/advanced", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return { keyword, position: null, title: null, domain: null };
  }

  if (!res.ok) {
    return { keyword, position: null, title: null, domain: null };
  }

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return { keyword, position: null, title: null, domain: null };
  }

  const tasks = Array.isArray(data.tasks) ? (data.tasks as unknown[]) : [];
  if (tasks.length === 0) {
    return { keyword, position: null, title: null, domain: null };
  }

  const task = tasks[0] as Record<string, unknown>;
  const taskResult = Array.isArray(task.result) ? (task.result as unknown[]) : [];
  if (taskResult.length === 0) {
    return { keyword, position: null, title: null, domain: null };
  }

  const result = taskResult[0] as Record<string, unknown>;
  const items = Array.isArray(result.items) ? (result.items as unknown[]) : [];

  const lowerDomain = businessDomain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");

  for (const rawItem of items) {
    const item = rawItem as DataForSeoLocalPackItem;
    const itemDomain = (item.domain ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (itemDomain && lowerDomain && itemDomain.includes(lowerDomain)) {
      const position = item.rank_group ?? item.rank_absolute ?? null;
      return { keyword, position, title: item.title ?? null, domain: item.domain ?? null };
    }
  }

  return { keyword, position: null, title: null, domain: null };
}

export async function handleFetchKeywordRankings(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const businessId = typeof args.business_id === "string" ? args.business_id : null;
  if (!businessId) {
    return { status: 400, body: "business_id is required" };
  }

  let keywordRows: KeywordRow[];
  try {
    keywordRows = await ctx.db.query<KeywordRow>(
      `SELECT id, business_id, keyword, location_code, language_code
         FROM gbp_tracked_keywords
        WHERE business_id = $1::uuid AND active = true
        ORDER BY keyword`,
      businessId,
    );
  } catch {
    return { status: 500, body: "database error fetching tracked keywords" };
  }

  if (keywordRows.length === 0) {
    return { status: 200, body: { message: "no tracked keywords for this business", deltas: [] } };
  }

  interface BusinessRow {
    readonly id: string;
    readonly domain: string | null;
  }
  let businessRows: BusinessRow[];
  try {
    businessRows = await ctx.db.query<BusinessRow>(
      `SELECT id, domain FROM businesses WHERE id = $1::uuid`,
      businessId,
    );
  } catch {
    return { status: 500, body: "database error fetching business" };
  }

  const businessDomain =
    businessRows.length > 0 && businessRows[0].domain ? businessRows[0].domain : "";

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  let priorSnapshots: PriorSnapshotRow[];
  try {
    priorSnapshots = await ctx.db.query<PriorSnapshotRow>(
      `SELECT DISTINCT ON (keyword_id) keyword_id, position, snapped_at
         FROM gbp_rank_snapshots
        WHERE business_id = $1::uuid
          AND snapped_at <= $2::timestamptz
        ORDER BY keyword_id, snapped_at DESC`,
      businessId,
      oneWeekAgo,
    );
  } catch {
    priorSnapshots = [];
  }

  const priorByKeywordId = new Map<string, number | null>();
  for (const snap of priorSnapshots) {
    priorByKeywordId.set(snap.keyword_id, snap.position);
  }

  const snappedAt = new Date().toISOString();
  const deltas: RankingDelta[] = [];
  const errors: string[] = [];

  for (const kw of keywordRows) {
    const result = await fetchLocalPackRanking(
      kw.keyword,
      kw.location_code,
      kw.language_code,
      businessDomain,
    );

    const snapshotId = crypto.randomUUID();
    try {
      await ctx.db.execute(
        `INSERT INTO gbp_rank_snapshots
           (id, business_id, keyword_id, keyword, position, snapped_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz)`,
        snapshotId,
        businessId,
        kw.id,
        kw.keyword,
        result.position,
        snappedAt,
      );
    } catch {
      errors.push(`failed to write snapshot for keyword "${kw.keyword}"`);
      continue;
    }

    const priorPosition = priorByKeywordId.has(kw.id) ? priorByKeywordId.get(kw.id)! : null;
    const delta =
      result.position !== null && priorPosition !== null
        ? priorPosition - result.position
        : null;

    deltas.push({
      keyword_id: kw.id,
      keyword: kw.keyword,
      current_position: result.position,
      prior_position: priorPosition,
      delta,
      snapshot_id: snapshotId,
    });
  }

  await ctx.events.publish("gbp.keyword_rankings_fetched", {
    business_id: businessId,
    snapped_at: snappedAt,
    keyword_count: deltas.length,
    error_count: errors.length,
  });

  return {
    status: 200,
    body: {
      business_id: businessId,
      snapped_at: snappedAt,
      deltas,
      errors: errors.length > 0 ? errors : undefined,
    },
  };
}

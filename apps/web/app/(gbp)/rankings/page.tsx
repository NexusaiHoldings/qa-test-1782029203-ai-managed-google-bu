/**
 * /rankings — Monthly local SEO ranking report (F1-006).
 *
 * Renders position changes for up to 20 service-area keywords with
 * competitor comparison. CEO briefing: "monthly local SEO ranking report
 * showing position changes for up to 20 service-area keywords with
 * competitor comparison."
 */

import type { JSX } from "react";
import { getServerSession } from "@nexus/identity-and-access";
import { getMonthlyReport } from "@/lib/gbp/rank-tracker";
import type { KeywordRankDelta, CompetitorEntry } from "@/lib/gbp/rank-tracker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function DeltaBadge({ delta }: { delta: number | null }): JSX.Element {
  if (delta === null) return <span className="muted">—</span>;
  if (delta > 0)
    return (
      <span style={{ color: "var(--color-success, green)" }}>
        ▲ {delta}
      </span>
    );
  if (delta < 0)
    return (
      <span style={{ color: "var(--color-danger, red)" }}>
        ▼ {Math.abs(delta)}
      </span>
    );
  return <span className="muted">= 0</span>;
}

function formatPosition(pos: number | null): string {
  return pos != null ? `#${pos}` : "—";
}

function CompetitorList({
  competitors,
}: {
  competitors: CompetitorEntry[];
}): JSX.Element {
  if (competitors.length === 0) {
    return <span className="muted">—</span>;
  }
  return (
    <ul style={{ margin: 0, paddingLeft: "1rem", listStyle: "none" }}>
      {competitors.slice(0, 3).map((c) => (
        <li key={`${c.name}-${c.position}`} className="muted">
          #{c.position} {c.name}
          {c.rating != null ? ` · ★${c.rating}` : ""}
          {c.reviews != null ? ` (${c.reviews} reviews)` : ""}
        </li>
      ))}
    </ul>
  );
}

interface PageProps {
  searchParams: Promise<{ month?: string; business_id?: string }>;
}

export default async function RankingsPage({
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const params = await searchParams;
  const session = await getServerSession();
  const businessId =
    params.business_id ?? (session?.user?.id as string | undefined) ?? "";
  const month = params.month ?? currentMonth();

  const report = businessId
    ? await getMonthlyReport(businessId, month)
    : {
        business_id: "",
        month,
        keywords: [] as KeywordRankDelta[],
        generated_at: new Date().toISOString(),
      };

  const hasData = report.keywords.length > 0;

  return (
    <main>
      <h1>Local SEO Rankings</h1>
      <p>
        Monthly keyword position report — track your Google Maps ranking
        changes and competitor positions for up to 20 service-area keywords.
      </p>

      <form method="GET" className="toolbar">
        <label htmlFor="month-picker">Report month</label>
        <input
          id="month-picker"
          type="month"
          name="month"
          defaultValue={month}
          max={currentMonth()}
        />
        <button type="submit" className="btn">
          View Report
        </button>
      </form>

      {!businessId ? (
        <div className="empty">
          <p>Sign in to view your keyword ranking report.</p>
        </div>
      ) : !hasData ? (
        <div className="empty">
          <p>
            No ranking data for <strong>{month}</strong>. Rankings are
            captured weekly — check back after the next scheduled snapshot.
          </p>
        </div>
      ) : (
        <>
          <p className="muted">
            {report.keywords.length} keyword
            {report.keywords.length !== 1 ? "s" : ""} tracked · {month} ·
            generated {new Date(report.generated_at).toLocaleString()}
          </p>

          <table>
            <thead>
              <tr>
                <th>Keyword</th>
                <th>Current Position</th>
                <th>Previous</th>
                <th>Change</th>
                <th>Top Competitors</th>
                <th>Last Snapshot</th>
              </tr>
            </thead>
            <tbody>
              {report.keywords.map((kw: KeywordRankDelta) => (
                <tr key={kw.keyword}>
                  <td>{kw.keyword}</td>
                  <td>
                    <strong>{formatPosition(kw.current_position)}</strong>
                  </td>
                  <td className="muted">
                    {formatPosition(kw.previous_position)}
                  </td>
                  <td>
                    <DeltaBadge delta={kw.delta} />
                  </td>
                  <td>
                    <CompetitorList competitors={kw.competitor_data} />
                  </td>
                  <td className="muted">{kw.snapshot_date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}

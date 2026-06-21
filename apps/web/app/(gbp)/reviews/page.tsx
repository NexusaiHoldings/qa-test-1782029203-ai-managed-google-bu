/**
 * /reviews — GBP Review Management Dashboard
 *
 * Shows three sections:
 *  1. Escalation queue: 1-2 star reviews awaiting a human-authored response
 *  2. Pending: reviews currently being processed or that encountered errors
 *  3. Response history: autonomously posted responses
 *
 * Server component — reads directly from the DB via raw SQL.
 * Requires a logged-in session (redirects to /login otherwise).
 */

import type { JSX } from "react";
import { redirect } from "next/navigation";
import { buildDb } from "@/lib/db";
import { getSessionUser } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ReviewRow {
  id: string;
  reviewer_name: string;
  rating: number;
  comment: string | null;
  status: string;
  sentiment: string | null;
  response_text: string | null;
  response_posted_at: string | null;
  create_time: string;
  business_name: string;
}

interface Db {
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  execute(sql: string, ...params: unknown[]): Promise<void>;
}

function starDisplay(rating: number): string {
  return "★".repeat(rating) + "☆".repeat(Math.max(0, 5 - rating));
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

async function loadReviews(db: Db): Promise<{
  escalation: ReviewRow[];
  pending: ReviewRow[];
  history: ReviewRow[];
}> {
  const base = `
    SELECT r.id, r.reviewer_name, r.rating, r.comment, r.status,
           r.sentiment, r.response_text, r.response_posted_at, r.create_time,
           c.business_name
    FROM gbp_reviews r
    JOIN gbp_connections c ON c.id = r.connection_id
  `;

  const [escalation, pending, history] = await Promise.all([
    db.query<ReviewRow>(
      `${base} WHERE r.status = 'human_review' ORDER BY r.create_time DESC LIMIT 50`,
    ),
    db.query<ReviewRow>(
      `${base} WHERE r.status IN ('pending', 'draft_failed', 'post_failed')
       ORDER BY r.create_time DESC LIMIT 50`,
    ),
    db.query<ReviewRow>(
      `${base} WHERE r.status = 'posted'
       ORDER BY r.response_posted_at DESC LIMIT 100`,
    ),
  ]);

  return { escalation, pending, history };
}

export default async function ReviewsPage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const db = buildDb() as Db;

  let escalation: ReviewRow[] = [];
  let pending: ReviewRow[] = [];
  let history: ReviewRow[] = [];
  let loadError: string | null = null;

  try {
    ({ escalation, pending, history } = await loadReviews(db));
  } catch (err) {
    loadError = String((err as Error).message);
  }

  return (
    <main>
      <h1>Review Management</h1>
      <p>
        Automated review response engine — 3-5 star reviews receive an AI-drafted response
        using your business voice profile; 1-2 star reviews are escalated for human review.
      </p>

      {loadError && (
        <div className="card">
          <p className="muted">
            Unable to load review data: {loadError}. Ensure the GBP database tables have been
            provisioned.
          </p>
        </div>
      )}

      {/* Escalation Queue */}
      <section>
        <h2>Escalation Queue ({escalation.length})</h2>
        <p className="muted">
          Low-rating reviews (1–2 stars) requiring a personal, human-authored response.
        </p>
        {escalation.length === 0 ? (
          <div className="empty">No escalated reviews — you are all caught up.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Reviewer</th>
                <th>Business</th>
                <th>Rating</th>
                <th>Review</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {escalation.map((r) => (
                <tr key={r.id}>
                  <td>{r.reviewer_name}</td>
                  <td className="muted">{r.business_name}</td>
                  <td title={`${r.rating}/5`}>{starDisplay(r.rating)}</td>
                  <td>{r.comment ?? <span className="muted">(no text)</span>}</td>
                  <td className="muted">{formatDate(r.create_time)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Pending / Processing */}
      {pending.length > 0 && (
        <section>
          <h2>Pending ({pending.length})</h2>
          <p className="muted">
            Reviews awaiting processing or that encountered an error during drafting.
          </p>
          <table>
            <thead>
              <tr>
                <th>Reviewer</th>
                <th>Business</th>
                <th>Rating</th>
                <th>Status</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((r) => (
                <tr key={r.id}>
                  <td>{r.reviewer_name}</td>
                  <td className="muted">{r.business_name}</td>
                  <td title={`${r.rating}/5`}>{starDisplay(r.rating)}</td>
                  <td>
                    <span className="muted">{r.status.replace(/_/g, " ")}</span>
                  </td>
                  <td className="muted">{formatDate(r.create_time)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Response History */}
      <section>
        <h2>Response History ({history.length})</h2>
        <p className="muted">
          Autonomously posted responses generated from your business voice profile.
        </p>
        {history.length === 0 ? (
          <div className="empty">
            No posted responses yet. The sweep cron runs hourly and will appear here once
            reviews have been ingested and processed.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Reviewer</th>
                <th>Business</th>
                <th>Rating</th>
                <th>Sentiment</th>
                <th>Response (preview)</th>
                <th>Posted</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id}>
                  <td>{r.reviewer_name}</td>
                  <td className="muted">{r.business_name}</td>
                  <td title={`${r.rating}/5`}>{starDisplay(r.rating)}</td>
                  <td className="muted">{r.sentiment ?? "—"}</td>
                  <td title={r.response_text ?? ""}>
                    {r.response_text
                      ? r.response_text.length > 80
                        ? `${r.response_text.slice(0, 80)}…`
                        : r.response_text
                      : <span className="muted">—</span>}
                  </td>
                  <td className="muted">{formatDate(r.response_posted_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

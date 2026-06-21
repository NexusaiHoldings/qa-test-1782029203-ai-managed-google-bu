import { revalidatePath } from "next/cache";
import { buildDb } from "@/lib/db";
import { generateGbpPost, getSeasonalContext } from "@/lib/gbp/post-generator";
import { publishGbpPost } from "@/lib/gbp/gbp-api-client";
import type { VoiceProfile } from "@/lib/gbp/post-generator";

interface QueueRow {
  id: string;
  connection_id: string;
  location_name: string;
  content: string;
  status: string;
  is_manual: boolean;
  error_message: string | null;
  created_at: string;
  published_at: string | null;
  gbp_post_name: string | null;
}

interface ConnectionRow {
  id: string;
  location_name: string;
  business_name: string;
  trade_category: string;
  location_id: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string | null;
  voice_profile: VoiceProfile | null;
}

async function triggerManualPost(formData: FormData): Promise<void> {
  "use server";

  const connectionId = formData.get("connection_id") as string | null;
  if (!connectionId) return;

  const db = buildDb();
  const rows = await db.query<ConnectionRow>(
    `SELECT id, location_name, business_name, trade_category, location_id,
            access_token, refresh_token, token_expires_at, voice_profile
     FROM gbp_connections
     WHERE id = $1 AND is_active = true
     LIMIT 1`,
    connectionId
  );

  const conn = rows[0];
  if (!conn) return;

  const month = new Date().getMonth() + 1;
  const seasonalContext = getSeasonalContext(month, conn.trade_category ?? "general");
  const voiceProfile = conn.voice_profile ?? {
    tone: "friendly and professional",
    keywords: [conn.trade_category ?? "service"],
    description: conn.business_name ?? "local service business",
  };

  let content = "";
  let callToAction = "Contact us today";

  try {
    const post = await generateGbpPost({
      businessName: conn.business_name ?? conn.location_name,
      voiceProfile,
      tradeCategory: conn.trade_category ?? "general",
      seasonalContext,
      locationName: conn.location_name,
    });
    content = post.content;
    callToAction = post.callToAction;
  } catch {
    content = `${conn.business_name ?? conn.location_name} — ready to help with all your ${conn.trade_category ?? "service"} needs this season.`;
  }

  const queueRows = await db.query<{ id: string }>(
    `INSERT INTO gbp_post_queue
       (id, connection_id, content, call_to_action, status, scheduled_for, created_at, updated_at, is_manual)
     VALUES
       (gen_random_uuid(), $1, $2, $3, 'queued', now(), now(), now(), true)
     RETURNING id`,
    connectionId,
    content,
    JSON.stringify({ actionType: "LEARN_MORE", label: callToAction })
  );

  const queueId = queueRows[0]?.id;
  if (!queueId) return;

  try {
    const result = await publishGbpPost(
      {
        id: conn.id,
        locationId: conn.location_id,
        accessToken: conn.access_token,
        refreshToken: conn.refresh_token,
        tokenExpiresAt: conn.token_expires_at ? new Date(conn.token_expires_at) : null,
      },
      { summary: content, callToAction: { actionType: "LEARN_MORE" } }
    );
    await db.execute(
      `UPDATE gbp_post_queue
       SET status = 'published', gbp_post_name = $1, published_at = now(), updated_at = now()
       WHERE id = $2`,
      result.postName,
      queueId
    );
  } catch (err) {
    await db.execute(
      `UPDATE gbp_post_queue
       SET status = 'failed', error_message = $1, updated_at = now()
       WHERE id = $2`,
      String((err as Error).message).slice(0, 300),
      queueId
    ).catch(() => {});
  }

  revalidatePath("/posts");
}

export default async function PostsPage() {
  const db = buildDb();

  let queuedPosts: QueueRow[] = [];
  let publishedPosts: QueueRow[] = [];
  let connections: ConnectionRow[] = [];

  try {
    queuedPosts = await db.query<QueueRow>(
      `SELECT q.id, q.connection_id, c.location_name, q.content, q.status,
              q.is_manual, q.error_message, q.created_at, q.published_at, q.gbp_post_name
       FROM gbp_post_queue q
       JOIN gbp_connections c ON c.id = q.connection_id
       WHERE q.status IN ('queued', 'failed')
       ORDER BY q.created_at DESC
       LIMIT 50`
    );
  } catch {
    // table may not exist yet — show empty state
  }

  try {
    publishedPosts = await db.query<QueueRow>(
      `SELECT q.id, q.connection_id, c.location_name, q.content, q.status,
              q.is_manual, q.error_message, q.created_at, q.published_at, q.gbp_post_name
       FROM gbp_post_queue q
       JOIN gbp_connections c ON c.id = q.connection_id
       WHERE q.status = 'published'
       ORDER BY q.published_at DESC
       LIMIT 50`
    );
  } catch {
    // table may not exist yet — show empty state
  }

  try {
    connections = await db.query<ConnectionRow>(
      `SELECT id, location_name, business_name, trade_category,
              location_id, access_token, refresh_token, token_expires_at, voice_profile
       FROM gbp_connections
       WHERE is_active = true
       ORDER BY location_name ASC`
    );
  } catch {
    // table may not exist yet — show empty state
  }

  function formatDate(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function statusBadge(status: string): string {
    const map: Record<string, string> = {
      queued: "⏳ Queued",
      published: "✓ Published",
      failed: "✗ Failed",
      cancelled: "– Cancelled",
    };
    return map[status] ?? status;
  }

  return (
    <main>
      <h1>GBP Post Queue</h1>
      <p>
        Weekly AI-generated posts are automatically created and published to your Google Business
        Profile. Monitor queue status, review published history, or trigger a post immediately.
      </p>

      <section>
        <h2>Queue Status</h2>
        {queuedPosts.length === 0 ? (
          <div className="empty">
            <p>No posts in the queue. The weekly scheduler will generate posts automatically.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Location</th>
                <th>Content</th>
                <th>Status</th>
                <th>Created</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {queuedPosts.map((post) => (
                <tr key={post.id}>
                  <td>{post.location_name}</td>
                  <td>
                    <span title={post.content}>
                      {post.content.slice(0, 120)}
                      {post.content.length > 120 ? "…" : ""}
                    </span>
                    {post.error_message && (
                      <p className="muted" style={{ marginTop: 4, fontSize: "0.8em", color: "var(--color-error, red)" }}>
                        {post.error_message.slice(0, 100)}
                      </p>
                    )}
                  </td>
                  <td>{statusBadge(post.status)}</td>
                  <td className="muted">{formatDate(post.created_at)}</td>
                  <td className="muted">{post.is_manual ? "Manual" : "Scheduled"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Published History</h2>
        {publishedPosts.length === 0 ? (
          <div className="empty">
            <p>No published posts yet. Posts will appear here after the scheduler runs.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Location</th>
                <th>Content</th>
                <th>Published</th>
                <th>Source</th>
                <th>GBP Post</th>
              </tr>
            </thead>
            <tbody>
              {publishedPosts.map((post) => (
                <tr key={post.id}>
                  <td>{post.location_name}</td>
                  <td>
                    {post.content.slice(0, 120)}
                    {post.content.length > 120 ? "…" : ""}
                  </td>
                  <td className="muted">{formatDate(post.published_at)}</td>
                  <td className="muted">{post.is_manual ? "Manual" : "Scheduled"}</td>
                  <td className="muted">
                    {post.gbp_post_name ? (
                      <span title={post.gbp_post_name} style={{ fontFamily: "monospace", fontSize: "0.8em" }}>
                        {post.gbp_post_name.slice(-12)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Manual Override</h2>
        <p className="muted">
          Generate and immediately publish an AI-crafted post for any connected location.
        </p>
        {connections.length === 0 ? (
          <div className="empty">
            <p>No active GBP connections found. Connect a Google Business Profile to get started.</p>
          </div>
        ) : (
          <form action={triggerManualPost}>
            <div className="toolbar">
              <select name="connection_id" required>
                <option value="">— Select a location —</option>
                {connections.map((conn) => (
                  <option key={conn.id} value={conn.id}>
                    {conn.business_name ?? conn.location_name} ({conn.trade_category ?? "general"})
                  </option>
                ))}
              </select>
              <button type="submit">Generate &amp; Publish Now</button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}

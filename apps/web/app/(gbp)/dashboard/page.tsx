import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  getActivities,
  approveActivity,
  rejectActivity,
  getBusinessForUser,
} from '@/lib/gbp/activity-feed';
import type { ActivityItem } from '@/lib/gbp/activity-feed';

interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

async function getSession(): Promise<SessionUser | null> {
  const cookieStore = cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const baseUrl =
    process.env.NEXTAUTH_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  try {
    const res = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { cookie: cookieHeader },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { user?: SessionUser };
    return data.user ?? null;
  } catch {
    return null;
  }
}

async function handleApprove(formData: FormData): Promise<void> {
  'use server';
  const activityId = formData.get('activityId');
  if (typeof activityId === 'string' && activityId) {
    await approveActivity(activityId);
    revalidatePath('/dashboard');
  }
}

async function handleReject(formData: FormData): Promise<void> {
  'use server';
  const activityId = formData.get('activityId');
  if (typeof activityId === 'string' && activityId) {
    await rejectActivity(activityId);
    revalidatePath('/dashboard');
  }
}

const STATUS_COLORS: Record<string, string> = {
  completed: '#16a34a',
  approved: '#2563eb',
  queued: '#d97706',
  rejected: '#dc2626',
};

const TYPE_LABELS: Record<string, string> = {
  post_published: 'Post Published',
  review_responded: 'Review Responded',
  ranking_change: 'Ranking Change',
  post_queued: 'Post Queued',
  review_queued: 'Review Queued',
};

function formatDate(date: Date): string {
  return new Date(date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function QueuedCard({
  item,
  approveAction,
  rejectAction,
}: {
  item: ActivityItem;
  approveAction: (formData: FormData) => Promise<void>;
  rejectAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <div className="card" style={{ marginBottom: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' }}>
        <div style={{ flex: 1 }}>
          <strong>{item.title}</strong>
          {item.description && <p className="muted" style={{ margin: '4px 0 0' }}>{item.description}</p>}
          <p className="muted" style={{ margin: '6px 0 0', fontSize: '13px' }}>
            {TYPE_LABELS[item.type] ?? item.type} &middot; {formatDate(item.createdAt)}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
          <form action={approveAction}>
            <input type="hidden" name="activityId" value={item.id} />
            <button type="submit" className="btn">Approve</button>
          </form>
          <form action={rejectAction}>
            <input type="hidden" name="activityId" value={item.id} />
            <button type="submit" className="btn secondary">Reject</button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default async function DashboardPage(): Promise<JSX.Element> {
  const session = await getSession();
  if (!session) {
    redirect('/login');
  }

  const business = await getBusinessForUser(session.id);

  if (!business) {
    return (
      <main>
        <h1>AI Activity Dashboard</h1>
        <p>Monitor and manage all AI-driven actions for your business.</p>
        <div className="empty">
          <p>No Google Business Profile connected yet.</p>
          <a href="/setup" className="btn">Connect Your Business</a>
        </div>
      </main>
    );
  }

  const { items: activities, total, hasMore } = await getActivities(business.id, 20, 0);
  const queued = activities.filter((a) => a.status === 'queued');
  const completed = activities.filter((a) => a.status !== 'queued');

  return (
    <main>
      <h1>AI Activity Dashboard</h1>
      <p>Monitor and manage all AI-driven actions for {business.businessName}.</p>

      {queued.length > 0 && (
        <section style={{ marginBottom: '32px' }}>
          <h2>Pending Approval ({queued.length})</h2>
          {queued.map((item) => (
            <QueuedCard
              key={item.id}
              item={item}
              approveAction={handleApprove}
              rejectAction={handleReject}
            />
          ))}
        </section>
      )}

      <section>
        <h2>Activity Feed</h2>
        {total === 0 ? (
          <div className="empty">
            <p>No AI actions recorded yet. Once your AI assistant starts working, activity will appear here.</p>
          </div>
        ) : (
          <>
            <p className="muted">
              {total} total action{total !== 1 ? 's' : ''}
              {hasMore ? ` — showing most recent 20` : ''}
            </p>
            {completed.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Description</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {completed.map((item) => (
                    <tr key={item.id}>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>{formatDate(item.createdAt)}</td>
                      <td>{TYPE_LABELS[item.type] ?? item.type}</td>
                      <td>{item.title}</td>
                      <td>
                        <span style={{ fontWeight: 600, color: STATUS_COLORS[item.status] ?? '#6b7280' }}>
                          {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              queued.length === 0 && (
                <div className="empty">
                  <p>No completed actions yet — your AI assistant is getting started.</p>
                </div>
              )
            )}
          </>
        )}
      </section>
    </main>
  );
}

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { serverApi } from '@/lib/server/session.js';
import ModerationQueue from './moderation-queue.js';

export const metadata = { title: 'Moderation · Studio' };
export const dynamic = 'force-dynamic';

const VIEWS = [
  { id: 'submitted', label: 'Waiting' },
  { id: 'changes_requested', label: 'Changes requested' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
];

/** Screen S9: moderation queue, oldest submission first (FS-11.1). staff.moderator only. */
export default async function ModerationPage({ searchParams }) {
  const requested = (await searchParams).status;
  const status = VIEWS.some((v) => v.id === requested) ? requested : 'submitted';
  const queue = await serverApi(`/design-publications?status=${status}&limit=100`);
  if (queue.status === 401) redirect('/sign-in?next=/moderation');

  return (
    <main className="page">
      <header className="page-header">
        <h1>Moderation</h1>
        <Link href="/projects" className="btn">
          Projects
        </Link>
      </header>
      {queue.status === 403 ? (
        <p role="alert" className="muted empty">
          The moderation queue is for moderators.
        </p>
      ) : queue.status !== 200 ? (
        <p role="alert" className="error-text">
          The queue could not be loaded ({queue.data?.error?.message ?? queue.status}).
        </p>
      ) : (
        <>
          <nav className="tabs scope-tabs" aria-label="Queue">
            {VIEWS.map((v) => (
              <Link
                key={v.id}
                href={v.id === 'submitted' ? '/moderation' : `/moderation?status=${v.id}`}
                className="tab"
                aria-current={v.id === status ? 'page' : undefined}
              >
                {v.label}
              </Link>
            ))}
          </nav>
          <ModerationQueue items={queue.data.data} canDecide={status === 'submitted'} />
        </>
      )}
    </main>
  );
}

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { serverApi } from '@/lib/server/session.js';
import DuplicateButton from './duplicate-button.js';
import NewProjectForm from './new-project-form.js';

export const metadata = { title: 'Projects · Studio' };
export const dynamic = 'force-dynamic';

const STATUS_LABEL = {
  draft: 'Draft',
  in_review: 'In review',
  published: 'Published',
  archived: 'Archived',
};

// Screen S4: owned and shared tabs (06-ui-ux/screen-inventory.md).
const SCOPES = [
  { id: 'all', label: 'All' },
  { id: 'owned', label: 'Mine' },
  { id: 'shared', label: 'Shared with me' },
];

export default async function ProjectsPage({ searchParams }) {
  const requested = (await searchParams).scope;
  const scope = SCOPES.some((s) => s.id === requested) ? requested : 'all';
  const [projects, profiles] = await Promise.all([
    serverApi(`/design-projects?limit=100&scope=${scope}`),
    serverApi('/machine-profiles'),
  ]);
  if (projects.status === 401) redirect('/sign-in?next=/projects');
  if (projects.status !== 200) {
    return (
      <main className="page">
        <p role="alert" className="error-text">
          Projects could not be loaded ({projects.data?.error?.message ?? projects.status}).
        </p>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="page-header">
        <h1>Projects</h1>
        <form action="/auth/sign-out" method="post">
          <button className="btn">Sign out</button>
        </form>
      </header>

      <NewProjectForm profiles={profiles.data?.data ?? []} />

      <nav className="tabs scope-tabs" aria-label="Which projects">
        {SCOPES.map((s) => (
          <Link
            key={s.id}
            href={s.id === 'all' ? '/projects' : `/projects?scope=${s.id}`}
            className="tab"
            aria-current={s.id === scope ? 'page' : undefined}
          >
            {s.label}
          </Link>
        ))}
      </nav>

      {projects.data.data.length === 0 ? (
        <p className="muted empty">
          {scope === 'shared'
            ? 'Nobody has shared a project with you yet.'
            : 'No projects yet. Create one to open the Studio.'}
        </p>
      ) : (
        <ul className="project-grid">
          {projects.data.data.map((p) => (
            <li key={p.id} className="card project-card">
              <Link href={`/studio/${p.id}`} className="project-title">
                {p.title}
              </Link>
              <span className="muted">
                {STATUS_LABEL[p.status] ?? p.status}
                {p.visibility === 'shared' && ' · shared'} · edited{' '}
                <time dateTime={p.updatedAt}>{new Date(p.updatedAt).toLocaleString('en-GB')}</time>
              </span>
              <span className="project-actions">
                <DuplicateButton projectId={p.id} title={p.title} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

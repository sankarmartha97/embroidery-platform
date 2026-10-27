import Link from 'next/link';
import { redirect } from 'next/navigation';
import { serverApi } from '@/lib/server/session.js';
import NewProjectForm from './new-project-form.js';

export const metadata = { title: 'Projects · Studio' };
export const dynamic = 'force-dynamic';

const STATUS_LABEL = {
  draft: 'Draft',
  in_review: 'In review',
  published: 'Published',
  archived: 'Archived',
};

export default async function ProjectsPage() {
  const [projects, profiles] = await Promise.all([
    serverApi('/design-projects?limit=100'),
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

      {projects.data.data.length === 0 ? (
        <p className="muted empty">No projects yet. Create one to open the Studio.</p>
      ) : (
        <ul className="project-grid">
          {projects.data.data.map((p) => (
            <li key={p.id}>
              <Link href={`/studio/${p.id}`} className="card project-card">
                <span className="project-title">{p.title}</span>
                <span className="muted">
                  {STATUS_LABEL[p.status] ?? p.status} · edited{' '}
                  <time dateTime={p.updatedAt}>
                    {new Date(p.updatedAt).toLocaleString('en-GB')}
                  </time>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

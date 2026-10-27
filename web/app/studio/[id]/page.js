import { notFound, redirect } from 'next/navigation';
import Studio from '@/components/studio/Studio.js';
import { serverApi } from '@/lib/server/session.js';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }) {
  const { id } = await params;
  const { data } = await serverApi(`/design-projects/${id}`);
  return { title: `${data?.title ?? 'Project'} · Studio` };
}

export default async function StudioPage({ params }) {
  const { id } = await params;
  const [project, formats, profiles] = await Promise.all([
    serverApi(`/design-projects/${id}`),
    serverApi('/machine-formats'),
    serverApi('/machine-profiles'),
  ]);
  if (project.status === 401) redirect(`/sign-in?next=/studio/${id}`);
  if (project.status === 404) notFound();
  if (project.status !== 200) throw new Error(`Project could not be loaded (${project.status})`);

  return (
    <Studio
      initialProject={project.data}
      formats={formats.data?.data ?? []}
      profiles={profiles.data?.data ?? []}
    />
  );
}

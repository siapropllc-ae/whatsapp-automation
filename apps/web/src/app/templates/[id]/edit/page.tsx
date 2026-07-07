'use client';

import { useParams, useRouter } from 'next/navigation';
import useSWR from 'swr';
import { DashLayout } from '@/components/DashLayout';
import { Button } from '@/components/Button';
import { CardSkeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { TemplateEditor } from '@/components/TemplateEditor';
import { apiFetch } from '@/lib/api';
import type { Template } from '@/types/api';

export default function EditTemplatePage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { data: template, error, isLoading } = useSWR<Template>(
    `/templates/${params.id}`,
    (url: string) => apiFetch<Template>(url),
  );

  const handleSaved = (t: Template) => {
    router.push(`/templates/${t.id}/edit`);
  };

  return (
    <DashLayout title="Edit Template">
      {isLoading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : error || !template ? (
        <EmptyState
          title="Template not found"
          subtitle="It may have been deleted."
          action={<Button variant="outline" onClick={() => router.push('/templates')}>Back to Templates</Button>}
        />
      ) : (
        <TemplateEditor mode="edit" initial={template} onSaved={handleSaved} />
      )}
    </DashLayout>
  );
}

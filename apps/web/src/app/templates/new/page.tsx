'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { DashLayout } from '@/components/DashLayout';
import { TemplateEditor } from '@/components/TemplateEditor';
import { RE_TEMPLATES } from '@/data/re-templates';
import type { Template } from '@/types/api';

export default function NewTemplatePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromLibraryId = searchParams.get('from');
  const libraryTemplate = fromLibraryId ? RE_TEMPLATES.find((t) => t.id === fromLibraryId) : undefined;

  const handleSaved = (template: Template) => {
    router.push(`/templates/${template.id}/edit`);
  };

  return (
    <DashLayout title="New Template">
      <TemplateEditor
        mode="create"
        prefillFromLibrary={libraryTemplate ? { name: libraryTemplate.name, body: libraryTemplate.body } : undefined}
        onSaved={handleSaved}
      />
    </DashLayout>
  );
}

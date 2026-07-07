'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { DashLayout } from '@/components/DashLayout';
import { TemplateEditor } from '@/components/TemplateEditor';
import { RE_TEMPLATES } from '@/data/re-templates';
import type { Template } from '@/types/api';

function NewTemplateContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromLibraryId = searchParams.get('from');
  const libraryTemplate = fromLibraryId ? RE_TEMPLATES.find((t) => t.id === fromLibraryId) : undefined;

  const handleSaved = (template: Template) => {
    router.push(`/templates/${template.id}/edit`);
  };

  return (
    <TemplateEditor
      mode="create"
      prefillFromLibrary={libraryTemplate ? { name: libraryTemplate.name, body: libraryTemplate.body } : undefined}
      onSaved={handleSaved}
    />
  );
}

export default function NewTemplatePage() {
  return (
    <DashLayout title="New Template">
      <Suspense fallback={null}>
        <NewTemplateContent />
      </Suspense>
    </DashLayout>
  );
}

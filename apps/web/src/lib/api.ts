export interface SavedMedia {
  url: string;
  type: 'IMAGE' | 'DOCUMENT' | 'VIDEO';
  mimeType: string;
  filename: string;
  size: number;
}

/** Uploads a file to the media endpoint. Shared by MediaDropzone and the campaign wizard's attachment picker. */
export async function uploadMedia(file: File): Promise<SavedMedia> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/media/upload', { method: 'POST', body: form });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<SavedMedia>;
}

/** Base fetch helper — routes through /api/* Next.js proxy */
export async function apiFetch<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const method = options?.method?.toUpperCase() ?? 'GET';
  const needsBody = ['POST', 'PUT', 'PATCH'].includes(method);
  const body = options?.body ?? (needsBody ? '{}' : undefined);
  // FormData must NOT get a manual Content-Type — fetch sets its own multipart
  // boundary only when the header is left unset.
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

  const res = await fetch(`/api${path}`, {
    headers: {
      ...(body !== undefined && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...(options?.headers ?? {}),
    },
    ...options,
    ...(body !== undefined && { body }),
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    } catch {
      // ignore parse error
    }
    throw new Error(message);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// Même origine : le navigateur appelle /api, Next réécrit vers l'API (voir next.config.mjs).
// En Docker, NEXT_PUBLIC_API_URL=/api est aussi posé au build (variable inlinée).
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

function authHeader(): Record<string, string> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** On an expired/invalid session, clear the token and bounce to the login page. */
function handleUnauthorized(status: number): void {
  if (status === 401 && typeof window !== 'undefined') {
    window.localStorage.removeItem('token');
    if (window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
  }
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeader(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    handleUnauthorized(res.status);
    const body = (await res.json().catch(() => ({}))) as { message?: unknown };
    throw new Error(typeof body.message === 'string' ? body.message : `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: authHeader(), body: form });
  if (!res.ok) {
    handleUnauthorized(res.status);
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Upload many files to a batch in small sequential chunks instead of one huge
 * multipart request — large batches (200+ scanned PDFs) otherwise overflow the
 * server's in-memory buffering and the connection is dropped ("Request aborted").
 * There is no hard cap on the total: files are sent `chunkSize` at a time, so any
 * count scales. Each request appends to the same batch; `finalize=true` on the last
 * chunk triggers the processing job. `onProgress` reports files sent for the UI bar.
 */
export async function apiUploadChunked<T>(
  path: string,
  files: File[],
  opts?: { chunkSize?: number; onProgress?: (sent: number, total: number) => void },
): Promise<T | null> {
  const chunkSize = opts?.chunkSize ?? 10;
  let last: T | null = null;
  for (let i = 0; i < files.length; i += chunkSize) {
    const slice = files.slice(i, i + chunkSize);
    const form = new FormData();
    slice.forEach((f) => form.append('files', f));
    const isLast = i + chunkSize >= files.length;
    last = await apiUpload<T>(`${path}?finalize=${isLast}`, form);
    opts?.onProgress?.(Math.min(i + chunkSize, files.length), files.length);
  }
  return last;
}

/**
 * Download an export blob (Excel/PDF/…) and trigger a "Save as".
 * `exportPath` is the export endpoint (e.g. `/referentials/locations/export`).
 * Returns false on failure so the caller can surface a toast.
 */
export async function downloadExport(
  exportPath: string,
  format: string,
  filename: string,
): Promise<boolean> {
  const res = await fetch(`${API_BASE}${exportPath}?format=${format}`, { headers: authHeader() });
  if (!res.ok) {
    handleUnauthorized(res.status);
    return false;
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

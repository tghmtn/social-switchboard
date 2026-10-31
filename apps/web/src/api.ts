export type User = { id: string; email: string; name: string };
export type Workspace = { id: string; name: string; role: 'owner' | 'admin' | 'agent' };
export type Me = { user: User; workspaces: Workspace[] };
export type Health = { status: string; version: string };

type Issue = { path: (string | number)[]; message: string };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: Issue[];

  constructor(status: number, code: string, issues: Issue[] = []) {
    super(code);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }

  /** First validation message per top-level field, for showing under form inputs. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const issue of this.issues) {
      const field = String(issue.path[0] ?? '');
      out[field] ??= issue.message;
    }
    return out;
  }
}

export async function api<T>(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `http_${res.status}`, data?.issues);
  return data as T;
}

import type {
  FlowGraph,
  FlowIssue,
  OutboundMessage,
  TriggerConfig,
} from '@social-switchboard/flow';
import { useCallback, useEffect, useState } from 'react';

export type User = { id: string; email: string; firstName: string; lastName: string; name: string };
export type Workspace = { id: string; name: string; role: 'owner' | 'admin' | 'agent' };
export type Me = { user: User; workspaces: Workspace[] };
export type Health = { status: string; version: string };
export type Overview = {
  contacts: number;
  newContacts7d: number;
  liveFlows: number;
  activeRuns: number;
  sent7d: number;
  leads: number;
  instagram: number;
};

export type FlowSummary = {
  id: string;
  name: string;
  publishedNumber: number | null;
  hasUnpublishedChanges: boolean;
  updatedAt: string;
  triggers: number;
  activeRuns: number;
  totalRuns: number;
};
export type Trigger = {
  id: string;
  flowId: string;
  config: TriggerConfig;
  channels: string[] | null;
  enabled: boolean;
  position: number;
  flowName?: string;
  flowPublished?: boolean;
};
export type FlowDetail = {
  flow: {
    id: string;
    name: string;
    draft: FlowGraph;
    publishedVersionId: string | null;
    updatedAt: string;
  };
  issues: FlowIssue[];
  triggers: Trigger[];
  versions: { id: string; number: number; createdAt: string }[];
};
export type Starter = { key: string; name: string; description: string; trigger?: TriggerConfig };

export type SimMessage = {
  id: string;
  direction: 'in' | 'out';
  status: 'received' | 'queued' | 'sent' | 'failed' | 'blocked';
  content:
    | {
        kind: 'in';
        text?: string;
        payload?: string;
        ref?: string;
        comment?: { id: string; mediaId?: string };
      }
    | {
        kind: 'out';
        message: OutboundMessage;
        payloads: Record<string, string>;
        privateReplyTo?: string;
        publicReplyTo?: string;
      };
  error: string | null;
  createdAt: string;
};
export type SimRun = {
  id: string;
  flowId: string;
  flowName: string;
  test: boolean;
  status: 'waiting' | 'completed' | 'failed' | 'expired' | 'cancelled';
  waitKind: 'delay' | 'input' | 'choice' | null;
  wakeAt: string | null;
  error: string | null;
  startedAt: string;
};
export type SimState = {
  contact: {
    id: string;
    tags: string[];
    fields: Record<string, string | number | boolean | null>;
    automationPausedAt: string | null;
  } | null;
  messages: SimMessage[];
  runs: SimRun[];
};

export type ContactRow = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  username: string | null;
  tags: string[];
  channels: string[];
  automationPausedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
};
export type ContactDetail = {
  contact: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    tags: string[];
    fields: { key: string; label: string; type: string; value: string | number | boolean | null }[];
    automationPausedAt: string | null;
    lastSeenAt: string | null;
    createdAt: string;
  };
  identities: { channel: string; externalId: string; username: string | null }[];
  consents: { channel: string; granted: boolean; source: string; at: string }[];
  events: { id: number; type: string; data: Record<string, unknown>; at: string }[];
  runs: {
    id: string;
    flowId: string;
    flowName: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
    error: string | null;
  }[];
};
export type InstagramMedia = {
  id: string;
  caption: string;
  kind: string;
  thumbnail?: string;
  permalink?: string;
  timestamp?: string;
};
export type InstagramAccount = {
  id: string;
  igUserId: string;
  username: string | null;
  name: string | null;
  profilePictureUrl: string | null;
  accountType: string | null;
  status: 'connected' | 'disconnected' | 'error';
  statusDetail: string | null;
  tokenExpiresAt: string | null;
  connectedAt: string;
};
export type InstagramSettings = {
  publicUrl: string;
  isPublic: boolean;
  urls: {
    oauthRedirect: string;
    deauthorize: string;
    dataDeletion: string;
    webhook: string;
    privacy: string;
    terms: string;
  };
  instagramAppId: string | null;
  hasInstagramAppSecret: boolean;
  hasFacebookAppSecret: boolean;
  webhookVerifyToken: string;
  webhookVerifiedAt: string | null;
  lastWebhookAt: string | null;
  accounts: InstagramAccount[];
};
export type Guide = { markdown: string; source: 'latest' | 'bundled' };
export type FieldDef = { id: string; key: string; label: string; type: string; options: string[] };
export type Tag = { id: string; name: string; contacts: number };

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

/** Loads `path` on mount (and when it changes). `path: null` skips loading. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(path !== null);

  const reload = useCallback(async () => {
    if (path === null) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

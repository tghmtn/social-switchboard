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
  waitKind: 'delay' | 'input' | 'choice' | 'ai' | 'route' | null;
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
  /** Set when a profile picture is kept: part of the picture's URL (see avatarUrl). */
  avatarVersion: number | null;
  tags: string[];
  channels: string[];
  automationPausedAt: string | null;
  /** Set when a person replied in the channel's app: the pause ends by itself then. */
  automationResumeAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
};
/** A contact's kept profile picture, if any. */
export const avatarUrl = (c: { id: string; avatarVersion: number | null }) =>
  c.avatarVersion ? `/api/contacts/${c.id}/avatar?v=${c.avatarVersion}` : undefined;

export type ContactDetail = {
  contact: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    avatarVersion: number | null;
    tags: string[];
    fields: { key: string; label: string; type: string; value: string | number | boolean | null }[];
    automationPausedAt: string | null;
    /** Set when a person replied in the channel's app: the pause ends by itself then. */
    automationResumeAt: string | null;
    lastSeenAt: string | null;
    createdAt: string;
  };
  identities: {
    channel: string;
    externalId: string;
    username: string | null;
    /** What the channel shares (Instagram: once they've messaged). Null until known. */
    displayName: string | null;
    followsUs: boolean | null;
    weFollow: boolean | null;
    followerCount: number | null;
    verified: boolean | null;
    profileSyncedAt: string | null;
  }[];
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
  /** Which way Connect logs in: Unified login (newer apps) or Instagram login (older ones). */
  loginMode: 'unified' | 'instagram' | null;
  loginUrl: string | null;
  metaAppId: string | null;
  configId: string | null;
  loginRedirectMatches: boolean | null;
  instagramAppId: string | null;
  hasInstagramAppSecret: boolean;
  hasFacebookAppSecret: boolean;
  /** Unified login finished but Meta didn't say which account: its ID finishes connecting. */
  accountIdNeeded: boolean;
  webhookVerifyToken: string;
  webhookVerifiedAt: string | null;
  lastWebhookAt: string | null;
  /** Last DM Instagram accepted from us: proves the account allows messages from apps. */
  lastSentAt: string | null;
  accounts: InstagramAccount[];
};
/** Inbox: one conversation in the list. */
export type InboxConversation = {
  contactId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  username: string | null;
  channel: string | null;
  avatarVersion: number | null;
  status: 'open' | 'closed';
  assignedUserId: string | null;
  automationPausedAt: string | null;
  automationResumeAt: string | null;
  last: { direction: 'in' | 'out'; status: string; text: string; byPerson: boolean; at: string };
  unread: number;
};
export type InboxView = 'open' | 'unread' | 'mine' | 'attention' | 'closed' | 'all';
export type InboxList = {
  conversations: InboxConversation[];
  counts: Record<InboxView, number>;
};
type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'file'; url: string; name: string };
export type InboxMessageContent =
  | {
      kind: 'in';
      text?: string;
      payload?: string;
      ref?: string;
      comment?: { id: string; mediaId?: string };
    }
  | {
      kind: 'out';
      message: {
        parts: MessagePart[];
        buttons: { id: string; kind: string; label: string; url?: string }[];
        quickReplies: { id: string; label: string }[];
      };
      privateReplyTo?: string;
      publicReplyTo?: string;
      byPerson?: boolean;
    };
export type InboxDetail = {
  contact: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    avatarVersion: number | null;
    status: 'open' | 'closed';
    assignedUserId: string | null;
    automationPausedAt: string | null;
    automationResumeAt: string | null;
  };
  identities: { channel: string; username: string | null; followsUs: boolean | null }[];
  /** Instagram replies are allowed until then (24 hours after their last DM). */
  replyWindowEndsAt: string | null;
  messages: {
    id: string;
    seq: number;
    direction: 'in' | 'out';
    status: string;
    error: string | null;
    at: string;
    content: InboxMessageContent;
    /** "them", "Flow", or the teammate's name. */
    by: string;
  }[];
  notes: { id: number; text: string; by: string; at: string }[];
  team: { id: string; name: string }[];
};
export type AiSettings = {
  model: string;
  effort: string;
  hasKey: boolean;
  models: { id: string; label: string; note: string; input: number; output: number }[];
  efforts: string[];
};
export type AiUsage = {
  since: string;
  models: {
    model: string;
    label: string;
    requests: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    estimatedCost: number;
  }[];
  actions: { tool: string; decision: string; ok: boolean; summary: string; at: string }[];
};
export type AssistantItem =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | {
      type: 'tool';
      id: string;
      label: string;
      state: 'running' | 'done' | 'failed' | 'declined' | 'waiting';
      changes: boolean;
      detail: string[];
      error?: string;
    };
export type AssistantThread = {
  id: string;
  title: string;
  /** idle, working, waiting (for approval) or error. */
  status: string;
  error: string | null;
  items: AssistantItem[];
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

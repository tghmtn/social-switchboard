import type {
  FieldValue,
  FlowGraph,
  OutboundMessage,
  RunState,
  TriggerConfig,
} from '@social-switchboard/flow';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export type SmtpSettings = {
  host: string;
  port: number;
  /** tls: encrypted from the start (usually 465). starttls: upgraded (usually 587). */
  security: 'tls' | 'starttls' | 'none';
  user: string;
  from: string;
  fromName: string;
};
export type TwilioSettings = { accountSid: string; from: string };
/** What the app can alert people about. */
export const NOTICE_KINDS = [
  'handoff',
  'assigned',
  'team',
  'unanswered',
  'paused',
  'snooze',
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
/** browser: Switchboard's own notifications (Web Push); push: an ntfy topic. */
export const ALERT_CHANNELS = ['browser', 'push', 'email', 'sms'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const workspaceId = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' });

// Every tenant-owned table carries workspace_id, so several workspaces per install
// (e.g. an agency running clients) is a later switch, not a rewrite.
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** IANA zone for time conditions and "until 09:00" delays. */
  timeZone: text('time_zone').notNull().default('UTC'),
  /** Push notifications: an ntfy topic URL (ntfy.sh or self-hosted), and its token if it has one. */
  notifyUrl: text('notify_url'),
  notifyTokenEnc: text('notify_token_enc'),
  /** Email alerts go out through this SMTP server (any provider); its password is encrypted. */
  smtp: jsonb('smtp').$type<SmtpSettings | null>(),
  smtpPassEnc: text('smtp_pass_enc'),
  /** Text-message alerts go out through this Twilio account; its auth token is encrypted. */
  twilio: jsonb('twilio').$type<TwilioSettings | null>(),
  twilioTokenEnc: text('twilio_token_enc'),
  /**
   * AI, bring your own key. Both providers' keys (encrypted) and models can be saved; aiProvider
   * picks the one every AI feature uses. aiModel and aiKeyEnc are Anthropic's.
   */
  aiProvider: text('ai_provider').notNull().default('anthropic'),
  aiEffort: text('ai_effort'),
  aiModel: text('ai_model'),
  aiKeyEnc: text('ai_key_enc'),
  aiOpenaiModel: text('ai_openai_model'),
  aiOpenaiKeyEnc: text('ai_openai_key_enc'),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Stored lowercased; uniqueness is enforced on that form.
  email: text('email').notNull().unique(),
  firstName: text('first_name').notNull().default(''),
  lastName: text('last_name').notNull().default(''),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});

export const memberRole = pgEnum('member_role', ['owner', 'admin', 'agent']);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRole('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const sessions = pgTable(
  'sessions',
  {
    // SHA-256 of the cookie token, so a database leak doesn't leak live sessions.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

/** Team invites: a one-time link to join the workspace in a role. Only the link's hash is kept. */
export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: workspaceId(),
  /** Stored lowercased, like users.email. */
  email: text('email').notNull(),
  role: memberRole('role').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * Where each teammate wants alerts: their own push topic, email and phone, and which events go
 * where. No row means the defaults (see notify.ts).
 */
export const notificationPrefs = pgTable(
  'notification_prefs',
  {
    workspaceId: workspaceId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** An ntfy topic URL for this person's phone. */
    pushUrl: text('push_url'),
    pushTokenEnc: text('push_token_enc'),
    /** Defaults to their sign-in email when empty. */
    email: text('email'),
    /** E.164, like +18015551234. */
    phone: text('phone'),
    events: jsonb('events').$type<Partial<Record<NoticeKind, AlertChannel[]>>>(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

// ---------------------------------------------------------------- contacts

export const conversationStatus = pgEnum('conversation_status', ['open', 'closed']);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    email: text('email'),
    phone: text('phone'),
    /** Values for workspace-defined fields, keyed by field key. */
    customFields: jsonb('custom_fields').$type<Record<string, FieldValue>>().notNull().default({}),
    /**
     * Automation is off for this contact: a hand-off step (until a person resumes it), or a
     * person replying from the channel's own app (until automationResumeAt).
     */
    automationPausedAt: timestamp('automation_paused_at', { withTimezone: true }),
    /** When a person-replied pause ends by itself. Null with a pause: it lasts until resumed. */
    automationResumeAt: timestamp('automation_resume_at', { withTimezone: true }),
    /** Inbox: closed once handled; a new message from them opens it again. */
    conversationStatus: conversationStatus('conversation_status').notNull().default('open'),
    /** Inbox: the teammate looking after this conversation. */
    assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Inbox: out of the open views until then; a new message from them brings it back sooner. */
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    /** Who snoozed it; cleared once they've been told it's back. */
    snoozedBy: uuid('snoozed_by').references(() => users.id, { onDelete: 'set null' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('contacts_workspace_created_idx').on(t.workspaceId, t.createdAt),
    index('contacts_workspace_email_idx').on(t.workspaceId, t.email),
    index('contacts_snooze_due_idx').on(t.snoozedUntil).where(sql`${t.snoozedBy} is not null`),
  ],
);

/** How a contact is known on each channel (Instagram user id, simulator session, ...). */
export const contactIdentities = pgTable(
  'contact_identities',
  {
    workspaceId: workspaceId(),
    channel: text('channel').notNull(),
    externalId: text('external_id').notNull(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    username: text('username'),
    /** The connected account this person talks to, e.g. our Instagram account's id. */
    accountRef: text('account_ref'),
    /**
     * What the channel shares about them (Instagram: only once they've messaged), refreshed
     * now and then. Null until known.
     */
    displayName: text('display_name'),
    followsUs: boolean('follows_us'),
    weFollow: boolean('we_follow'),
    followerCount: integer('follower_count'),
    verified: boolean('verified'),
    profileSyncedAt: timestamp('profile_synced_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.channel, t.externalId] }),
    index('contact_identities_contact_idx').on(t.contactId),
  ],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** A contact's profile picture, kept here because the channel's own links expire. */
export const contactAvatars = pgTable('contact_avatars', {
  contactId: uuid('contact_id')
    .primaryKey()
    .references(() => contacts.id, { onDelete: 'cascade' }),
  workspaceId: workspaceId(),
  contentType: text('content_type').notNull(),
  data: bytea('data').notNull(),
  updatedAt: updatedAt(),
});

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('tags_workspace_name_idx').on(t.workspaceId, sql`lower(${t.name})`)],
);

export const contactTags = pgTable(
  'contact_tags',
  {
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.tagId] }),
    index('contact_tags_tag_idx').on(t.tagId),
  ],
);

export const fieldType = pgEnum('field_type', [
  'text',
  'number',
  'date',
  'email',
  'phone',
  'url',
  'choice',
]);

export const fieldDefinitions = pgTable(
  'field_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: fieldType('type').notNull().default('text'),
    /** Allowed values for "choice" fields. */
    options: jsonb('options').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [unique('field_definitions_workspace_key').on(t.workspaceId, t.key)],
);

/** Append-only consent log; the latest row per contact and channel is the current state. */
export const consents = pgTable(
  'consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    granted: boolean('granted').notNull(),
    /** Where it came from, e.g. "flow:<id>" or "manual:<userId>". */
    source: text('source').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('consents_contact_idx').on(t.contactId, t.channel, t.createdAt)],
);

/** The contact's activity timeline: tags, fields, flows, hand-offs. */
export const contactEvents = pgTable(
  'contact_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: workspaceId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('contact_events_contact_idx').on(t.contactId, t.createdAt)],
);

// ---------------------------------------------------------------- flows

export const flows = pgTable(
  'flows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    /** The builder's working copy. Runs never use it directly; they use a version. */
    draft: jsonb('draft').$type<FlowGraph>().notNull(),
    publishedVersionId: uuid('published_version_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('flows_workspace_idx').on(t.workspaceId)],
);

export const flowVersionKind = pgEnum('flow_version_kind', ['published', 'test']);

/** Immutable snapshots: one per publish, plus throwaway "test" ones for the simulator. */
export const flowVersions = pgTable(
  'flow_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    kind: flowVersionKind('kind').notNull(),
    /** 1, 2, 3... for published versions; null for test versions. */
    number: integer('number'),
    graph: jsonb('graph').$type<FlowGraph>().notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('flow_versions_flow_idx').on(t.flowId, t.number)],
);

export const triggers = pgTable(
  'triggers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    config: jsonb('config').$type<TriggerConfig>().notNull(),
    /** Limit to these channels; null means every channel. */
    channels: text('channels').array(),
    enabled: boolean('enabled').notNull().default(true),
    /** Keyword triggers are checked in ascending position. */
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('triggers_workspace_idx').on(t.workspaceId, t.position)],
);

export const runStatus = pgEnum('run_status', [
  'waiting',
  'completed',
  'failed',
  'expired',
  'cancelled',
]);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    flowVersionId: uuid('flow_version_id')
      .notNull()
      .references(() => flowVersions.id, { onDelete: 'cascade' }),
    triggerId: uuid('trigger_id').references(() => triggers.id, { onDelete: 'set null' }),
    /** Replies (including ones sent after a delay) go out on the channel the run started on. */
    channel: text('channel').notNull(),
    status: runStatus('status').notNull(),
    state: jsonb('state').$type<RunState>().notNull(),
    /** Mirrors state.wait so the worker can find due runs with an index. */
    waitKind: text('wait_kind'),
    wakeAt: timestamp('wake_at', { withTimezone: true }),
    wakeToken: text('wake_token'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('runs_contact_status_idx').on(t.contactId, t.status),
    index('runs_due_idx').on(t.wakeAt).where(sql`${t.status} = 'waiting'`),
  ],
);

/** One row per step entered: the raw material for flow funnels and drop-off analytics. */
export const runSteps = pgTable(
  'run_steps',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: workspaceId(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    flowVersionId: uuid('flow_version_id').notNull(),
    nodeId: text('node_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('run_steps_version_node_idx').on(t.flowVersionId, t.nodeId)],
);

// ---------------------------------------------------------------- messages

export type InboundContent = {
  kind: 'in';
  text?: string;
  payload?: string;
  ref?: string;
  /** Set when this was a public comment rather than a DM. Comments don't open the DM window. */
  comment?: { id: string; mediaId?: string };
};
/** `payloads` maps each quick reply / flow button id to the opaque payload the channel echoes back. */
export type OutboundContent = {
  kind: 'out';
  message: OutboundMessage;
  payloads: Record<string, string>;
  /** Send as Instagram's one private reply to this comment, instead of a normal DM. */
  privateReplyTo?: string;
  /** A public reply posted under this comment (not a DM). */
  publicReplyTo?: string;
  /** Typed by a person (in the channel's own app, or the inbox), not sent by a flow. */
  byPerson?: true;
  /** The teammate who sent it from the inbox. */
  sentBy?: string;
};

export const messageDirection = pgEnum('message_direction', ['in', 'out']);
export const messageStatus = pgEnum('message_status', [
  'received',
  'queued',
  'sent',
  'failed',
  'blocked',
]);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Insert order. created_at can't order a conversation: it's the same for a whole transaction. */
    seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    workspaceId: workspaceId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    direction: messageDirection('direction').notNull(),
    status: messageStatus('status').notNull(),
    content: jsonb('content').$type<InboundContent | OutboundContent>().notNull(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    nodeId: text('node_id'),
    /** Why a send failed or was blocked (e.g. outside the 24-hour window). */
    error: text('error'),
    /** The channel's own id for this message (Instagram's message id), once sent or received. */
    externalId: text('external_id'),
    createdAt: createdAt(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    index('messages_contact_idx').on(t.contactId, t.seq),
    index('messages_queued_idx').on(t.createdAt).where(sql`${t.status} = 'queued'`),
  ],
);

// ---------------------------------------------------------------- compliance

/** Data-deletion requests from Meta's callback, so the person can check the status page. */
export const deletionRequests = pgTable('deletion_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  confirmationCode: text('confirmation_code').notNull().unique(),
  channel: text('channel').notNull(),
  externalId: text('external_id').notNull(),
  contactsDeleted: integer('contacts_deleted').notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- instagram

/** The workspace's Meta app: pasted in through the Connect Instagram wizard. Secrets are encrypted. */
export const metaApps = pgTable('meta_apps', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /**
   * Unified login (all newer Meta apps): the Login URL Meta generates for the app's login
   * configuration. It carries the Meta app ID (client_id) and config_id; neither is secret.
   */
  loginUrl: text('login_url'),
  /** Older apps only: "API setup with Instagram login". */
  instagramAppId: text('instagram_app_id'),
  instagramAppSecretEnc: text('instagram_app_secret_enc'),
  /** The Meta app secret (App settings → Basic). Signs webhooks; Unified login's token exchange uses it. */
  facebookAppSecretEnc: text('facebook_app_secret_enc'),
  /**
   * Unified login when Meta doesn't say which Instagram account was shared: the token, kept until
   * the owner pastes the account ID from Meta's Connected apps screen. Encrypted.
   */
  pendingTokenEnc: text('pending_token_enc'),
  pendingTokenAt: timestamp('pending_token_at', { withTimezone: true }),
  /** Random string Meta echoes back when it verifies the webhook URL. */
  webhookVerifyToken: text('webhook_verify_token').notNull(),
  webhookVerifiedAt: timestamp('webhook_verified_at', { withTimezone: true }),
  /** Last signed event from Meta; proves webhooks really arrive (i.e. the app is published). */
  lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true }),
  /**
   * Facebook Pages: the Meta app ID for Facebook Login (else the Login URL's client_id), and a
   * Facebook Login for Business configuration ID when the app uses one instead of permissions.
   */
  facebookAppId: text('facebook_app_id'),
  facebookConfigId: text('facebook_config_id'),
  /** Pages the last Facebook login could connect, until the owner picks which. Encrypted. */
  facebookPendingEnc: text('facebook_pending_enc'),
  facebookPendingAt: timestamp('facebook_pending_at', { withTimezone: true }),
  updatedAt: updatedAt(),
});

/** Facebook Pages connected for Messenger and comments. */
export const facebookPages = pgTable(
  'facebook_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    /** The Page id Meta uses in webhooks (entry.id) and for sending. */
    pageId: text('page_id').notNull().unique(),
    name: text('name'),
    pictureUrl: text('picture_url'),
    /** A Page token from a long-lived user token: it doesn't expire. */
    accessTokenEnc: text('access_token_enc').notNull(),
    /** connected, or error (statusDetail says why). */
    status: text('status').notNull().default('connected'),
    statusDetail: text('status_detail'),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [index('facebook_pages_workspace_idx').on(t.workspaceId)],
);

export const instagramAccounts = pgTable(
  'instagram_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    /** The professional account id Instagram uses in webhooks (entry.id) and for sending. */
    igUserId: text('ig_user_id').notNull().unique(),
    username: text('username'),
    name: text('name'),
    profilePictureUrl: text('profile_picture_url'),
    accountType: text('account_type'),
    /** Which API this account's token works with: graph.instagram.com or graph.facebook.com (Unified login). */
    apiHost: text('api_host').notNull().default('instagram'),
    accessTokenEnc: text('access_token_enc').notNull(),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    status: text('status').notNull().default('connected'),
    /** Plain-language reason when status isn't "connected". */
    statusDetail: text('status_detail'),
    connectedAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('instagram_accounts_workspace_idx').on(t.workspaceId)],
);

/** Raw webhook deliveries, stored before processing so none are lost if processing fails. */
/**
 * Ids of the messages we sent. Instagram echoes every message the account sends without saying
 * which app sent it, so an echo whose id isn't here was typed by a person. Kept a couple of days.
 */
/** What the assistant is waiting on: tool calls that change things, plus results of those already run. */
export type AssistantPending = {
  calls: { id: string; name: string; input: unknown }[];
  results: { tool_use_id: string; content: string; is_error?: boolean }[];
};

/** The in-app assistant's conversations, one teammate each. */
export const assistantThreads = pgTable(
  'assistant_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    /**
     * The conversation exactly as the Claude API saw it. Only ever appended to: earlier turns
     * (thinking blocks included) must go back unchanged.
     */
    messages: jsonb('messages').$type<unknown[]>().notNull().default([]),
    pending: jsonb('pending').$type<AssistantPending | null>(),
    /** idle, working (a turn is running), waiting (for approval) or error. */
    status: text('status').notNull().default('idle'),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('assistant_threads_user_idx').on(t.userId, t.updatedAt)],
);

/** Tokens per AI request, for the usage meter. */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: workspaceId(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    threadId: uuid('thread_id').references(() => assistantThreads.id, { onDelete: 'set null' }),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('ai_usage_workspace_idx').on(t.workspaceId, t.createdAt)],
);

/** Everything the assistant did or proposed, and what the person decided: the review log. */
export const aiActions = pgTable(
  'ai_actions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: workspaceId(),
    threadId: uuid('thread_id').references(() => assistantThreads.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    tool: text('tool').notNull(),
    input: jsonb('input').$type<unknown>(),
    /** auto (reading), approved, declined. */
    decision: text('decision').notNull(),
    ok: boolean('ok').notNull(),
    summary: text('summary').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('ai_actions_workspace_idx').on(t.workspaceId, t.createdAt)],
);

/** Inbox: replies the team sends often; {{variables}} are filled in from the contact. */
export const savedReplies = pgTable(
  'saved_replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    title: text('title').notNull(),
    text: text('text').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('saved_replies_workspace_idx').on(t.workspaceId)],
);

/** Switchboard's own notifications (Web Push): one row per browser or installed app turned on. */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** "iPhone", "Chrome on a Mac"…, for the list of devices. */
    label: text('label').notNull(),
    createdAt: createdAt(),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('push_subscriptions_endpoint_idx').on(t.endpoint),
    index('push_subscriptions_user_idx').on(t.workspaceId, t.userId),
  ],
);

/** Inbox: how far each teammate has read each conversation (by message seq). */
export const conversationReads = pgTable(
  'conversation_reads',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    lastReadSeq: bigint('last_read_seq', { mode: 'number' }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.contactId] })],
);

export const sentMessageIds = pgTable(
  'sent_message_ids',
  {
    externalId: text('external_id').primaryKey(),
    workspaceId: workspaceId(),
    createdAt: createdAt(),
  },
  (t) => [index('sent_message_ids_created_idx').on(t.createdAt)],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    source: text('source').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    /** When a pass started on it; others leave it alone until that finishes (or looks stuck). */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    index('webhook_events_pending_idx').on(t.receivedAt).where(sql`${t.processedAt} is null`),
  ],
);

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

// ---------------------------------------------------------------- contacts

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
    /** Set by a hand-off step; automation stays off for this contact until a person resumes it. */
    automationPausedAt: timestamp('automation_paused_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('contacts_workspace_created_idx').on(t.workspaceId, t.createdAt),
    index('contacts_workspace_email_idx').on(t.workspaceId, t.email),
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
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.channel, t.externalId] }),
    index('contact_identities_contact_idx').on(t.contactId),
  ],
);

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
  instagramAppId: text('instagram_app_id'),
  instagramAppSecretEnc: text('instagram_app_secret_enc'),
  facebookAppSecretEnc: text('facebook_app_secret_enc'),
  /** Random string Meta echoes back when it verifies the webhook URL. */
  webhookVerifyToken: text('webhook_verify_token').notNull(),
  webhookVerifiedAt: timestamp('webhook_verified_at', { withTimezone: true }),
  /** Last signed event from Meta; proves webhooks really arrive (i.e. the app is published). */
  lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true }),
  updatedAt: updatedAt(),
});

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
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    source: text('source').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
  },
  (t) => [
    index('webhook_events_pending_idx').on(t.receivedAt).where(sql`${t.processedAt} is null`),
  ],
);

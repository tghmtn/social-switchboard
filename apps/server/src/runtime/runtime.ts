import { randomUUID } from 'node:crypto';
import {
  type AdvanceResult,
  advance,
  type EngineEvent,
  type FlowGraph,
  matchCommentTrigger,
  matchTrigger,
  type RunState,
} from '@social-switchboard/flow';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import {
  consents,
  contactIdentities,
  contacts,
  flows,
  flowVersions,
  messages,
  runSteps,
  runs,
  triggers,
  workspaces,
} from '../db/schema';
import type { Notice } from '../notify';
import type { ChannelRegistry, SendResult } from './channels';
import {
  addTag,
  findOrCreateContact,
  loadSnapshot,
  lockContact,
  type Profile,
  recordEvent,
  removeTag,
  saveFields,
} from './contacts';

// The host side of the engine: finds or creates the contact, routes each inbound event to the
// waiting run or a trigger, persists what the engine decided, and delivers queued messages
// after the transaction commits (an outbox, so a crash never sends a message twice or loses one).

export type RuntimeDeps = {
  db: Db;
  channels: ChannelRegistry;
  now?: () => Date;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Push notifications (best effort; see notify.ts). */
  notify?: (n: Notice) => void;
};

const notifyAll = (deps: RuntimeDeps, notices: Notice[]) => {
  for (const n of notices) deps.notify?.(n);
};

export type Inbound = {
  workspaceId: string;
  channel: string;
  externalId: string;
  profile?: Profile;
  text?: string;
  /** Echo of a quick reply / button payload we sent. */
  payload?: string;
  /** Entry-link ref, e.g. from ig.me/m/you?ref=spring. */
  ref?: string;
  /** Which of our connected accounts this arrived on (e.g. the Instagram account id). */
  accountRef?: string;
};

export type InboundComment = {
  workspaceId: string;
  channel: string;
  /** The commenter's id on the channel (the same id they'd DM from). */
  externalId: string;
  accountRef?: string;
  profile?: Profile;
  commentId: string;
  mediaId?: string;
  text: string;
};

type Version = { id: string; flowId: string; graph: FlowGraph };
type RunRow = typeof runs.$inferSelect;
type Ctx = {
  deps: RuntimeDeps;
  tx: Tx;
  workspaceId: string;
  contactId: string;
  channel: string;
  timeZone: string;
  now: Date;
  /** Message ids to deliver once the transaction commits. */
  queued: string[];
  /** Push notifications to send once the transaction commits. */
  notices: Notice[];
  /** How many "go to flow" hops this event has taken, to stop flows that call each other forever. */
  hops: number;
  /** Set when a comment started this: the first message is the comment's one private reply. */
  commentReply?: { commentId: string; used: boolean };
};

const MAX_FLOW_HOPS = 5;
const CONVERSATION_WAITS = ['input', 'choice'];

// Payloads ride along on quick replies and flow buttons and come back when they're tapped.
const PAYLOAD_VERSION = 'ssw1';
export const encodePayload = (versionId: string, nodeId: string, handle: string) =>
  [PAYLOAD_VERSION, versionId, nodeId, handle].join('|');
export function decodePayload(payload: string) {
  const [v, versionId, nodeId, handle] = payload.split('|');
  return v === PAYLOAD_VERSION && versionId && nodeId && handle
    ? { versionId, nodeId, handle }
    : null;
}

/** Handles one inbound message, tap or entry-link visit from a contact. */
export async function receive(deps: RuntimeDeps, input: Inbound) {
  const queued: string[] = [];
  const notices: Notice[] = [];
  const contactId = await deps.db.transaction(async (tx) => {
    const { contactId, isNew } = await findOrCreateContact(
      tx,
      input.workspaceId,
      input.channel,
      input.externalId,
      { ...input.profile, accountRef: input.accountRef },
    );
    await lockContact(tx, contactId);
    const now = deps.now?.() ?? new Date();
    const [contact] = await tx
      .update(contacts)
      .set({ lastSeenAt: now, conversationStatus: 'open' }) // a new message reopens it in the inbox
      .where(eq(contacts.id, contactId))
      .returning({ pausedAt: contacts.automationPausedAt });
    await tx.insert(messages).values({
      workspaceId: input.workspaceId,
      contactId,
      channel: input.channel,
      direction: 'in',
      status: 'received',
      content: { kind: 'in', text: input.text, payload: input.payload, ref: input.ref },
    });
    // A person has taken over this conversation: record the message, but don't automate.
    if (contact?.pausedAt) {
      notices.push({
        workspaceId: input.workspaceId,
        contactId,
        channel: input.channel,
        kind: 'paused',
        text: input.text,
      });
      return contactId;
    }

    const ctx = await context(
      deps,
      tx,
      input.workspaceId,
      contactId,
      input.channel,
      now,
      queued,
      notices,
    );
    await route(ctx, input, isNew);
    return contactId;
  });
  await deliver(deps, queued);
  notifyAll(deps, notices);
  return { contactId };
}

/**
 * Handles a public comment. If a comment trigger matches, its flow starts and the first message
 * goes out as the comment's one private reply (plus an optional public reply under the comment).
 */
export async function receiveComment(deps: RuntimeDeps, input: InboundComment) {
  const queued: string[] = [];
  const notices: Notice[] = [];
  const result = await deps.db.transaction(async (tx) => {
    const { contactId } = await findOrCreateContact(
      tx,
      input.workspaceId,
      input.channel,
      input.externalId,
      {
        ...input.profile,
        accountRef: input.accountRef,
      },
    );
    await lockContact(tx, contactId);
    const now = deps.now?.() ?? new Date();
    const [contact] = await tx
      .update(contacts)
      .set({ lastSeenAt: now, conversationStatus: 'open' }) // a new message reopens it in the inbox
      .where(eq(contacts.id, contactId))
      .returning({ pausedAt: contacts.automationPausedAt });
    await tx.insert(messages).values({
      workspaceId: input.workspaceId,
      contactId,
      channel: input.channel,
      direction: 'in',
      status: 'received',
      content: {
        kind: 'in',
        text: input.text,
        comment: { id: input.commentId, mediaId: input.mediaId },
      },
      externalId: input.commentId,
    });
    if (contact?.pausedAt) return { contactId, triggered: false };

    const rows = await tx
      .select({
        id: triggers.id,
        config: triggers.config,
        channels: triggers.channels,
        versionId: flows.publishedVersionId,
      })
      .from(triggers)
      .innerJoin(flows, eq(flows.id, triggers.flowId))
      .where(
        and(
          eq(triggers.workspaceId, input.workspaceId),
          eq(triggers.enabled, true),
          isNull(flows.archivedAt),
          isNotNull(flows.publishedVersionId),
        ),
      )
      .orderBy(asc(triggers.position), asc(triggers.createdAt));
    const trigger = matchCommentTrigger(rows, {
      channel: input.channel,
      text: input.text,
      mediaId: input.mediaId,
    });
    const version = trigger?.versionId
      ? await loadVersion(tx, input.workspaceId, trigger.versionId)
      : undefined;
    if (!trigger || !version) return { contactId, triggered: false };

    const ctx = await context(
      deps,
      tx,
      input.workspaceId,
      contactId,
      input.channel,
      now,
      queued,
      notices,
    );
    ctx.commentReply = { commentId: input.commentId, used: false };
    await cancelConversationRuns(ctx);
    await begin(ctx, version, { type: 'start' }, trigger.id);

    const replies = trigger.config.type === 'comment' ? trigger.config.publicReplies : [];
    const publicReply = replies[Math.floor(Math.random() * replies.length)];
    if (publicReply) {
      const [m] = await tx
        .insert(messages)
        .values({
          workspaceId: input.workspaceId,
          contactId,
          channel: input.channel,
          direction: 'out',
          status: 'queued',
          content: {
            kind: 'out',
            message: {
              parts: [{ type: 'text', text: publicReply }],
              buttons: [],
              quickReplies: [],
            },
            payloads: {},
            publicReplyTo: input.commentId,
          },
        })
        .returning({ id: messages.id });
      if (m) queued.push(m.id);
    }
    return { contactId, triggered: true };
  });
  await deliver(deps, queued);
  notifyAll(deps, notices);
  return result;
}

async function route(ctx: Ctx, input: Inbound, isNew: boolean) {
  const payload = input.payload ? decodePayload(input.payload) : null;
  if (payload) {
    const waiting = await waitingRun(ctx, ['choice']);
    if (
      waiting &&
      waiting.flowVersionId === payload.versionId &&
      waiting.state.wait?.nodeId === payload.nodeId &&
      (await step(ctx, waiting, { type: 'choice', nodeId: payload.nodeId, handle: payload.handle }))
    ) {
      return;
    }
    // A button on an earlier message: carry on from that button in a fresh run.
    const version = await loadVersion(ctx.tx, ctx.workspaceId, payload.versionId);
    if (version) {
      await cancelConversationRuns(ctx);
      await begin(ctx, version, {
        type: 'start',
        from: { nodeId: payload.nodeId, handle: payload.handle },
      });
      return;
    }
  }

  if (input.text !== undefined) {
    const waiting = await waitingRun(ctx, CONVERSATION_WAITS);
    if (waiting && (await step(ctx, waiting, { type: 'message', text: input.text }))) return;
  }

  const rows = await ctx.tx
    .select({
      id: triggers.id,
      config: triggers.config,
      channels: triggers.channels,
      versionId: flows.publishedVersionId,
    })
    .from(triggers)
    .innerJoin(flows, eq(flows.id, triggers.flowId))
    .where(
      and(
        eq(triggers.workspaceId, ctx.workspaceId),
        eq(triggers.enabled, true),
        isNull(flows.archivedAt),
        isNotNull(flows.publishedVersionId),
      ),
    )
    .orderBy(asc(triggers.position), asc(triggers.createdAt));
  const trigger = matchTrigger(rows, {
    channel: ctx.channel,
    text: input.text,
    ref: input.ref,
    isNewContact: isNew,
  });
  if (!trigger?.versionId) {
    // Nothing answers this one: someone should see it.
    if (input.text !== undefined)
      ctx.notices.push({
        workspaceId: ctx.workspaceId,
        contactId: ctx.contactId,
        channel: ctx.channel,
        kind: 'unanswered',
        text: input.text,
      });
    return;
  }
  const version = await loadVersion(ctx.tx, ctx.workspaceId, trigger.versionId);
  if (!version) return;
  await cancelConversationRuns(ctx);
  await begin(ctx, version, { type: 'start' }, trigger.id);
}

/** Starts a specific flow version for a contact (the simulator's "Run this flow"). */
export async function startFlow(
  deps: RuntimeDeps,
  args: { workspaceId: string; contactId: string; channel: string; versionId: string },
) {
  const queued: string[] = [];
  const notices: Notice[] = [];
  const runId = await deps.db.transaction(async (tx) => {
    await lockContact(tx, args.contactId);
    const ctx = await context(
      deps,
      tx,
      args.workspaceId,
      args.contactId,
      args.channel,
      deps.now?.() ?? new Date(),
      queued,
      notices,
    );
    const version = await loadVersion(tx, args.workspaceId, args.versionId);
    if (!version) throw new Error(`flow version ${args.versionId} not found`);
    await cancelConversationRuns(ctx);
    return begin(ctx, version, { type: 'start' });
  });
  await deliver(deps, queued);
  notifyAll(deps, notices);
  return runId;
}

/** Fires a due delay or reply timeout. Stale tokens (the run already moved on) are ignored. */
export async function wake(deps: RuntimeDeps, runId: string, token: string) {
  const queued: string[] = [];
  const notices: Notice[] = [];
  await deps.db.transaction(async (tx) => {
    const [peek] = await tx
      .select({ contactId: runs.contactId })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!peek) return;
    await lockContact(tx, peek.contactId);
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
    if (run?.status !== 'waiting' || run.wakeToken !== token) return;
    const now = deps.now?.() ?? new Date();
    const [contact] = await tx
      .select({ pausedAt: contacts.automationPausedAt })
      .from(contacts)
      .where(eq(contacts.id, run.contactId));
    if (contact?.pausedAt) {
      await tx
        .update(runs)
        .set({ status: 'cancelled', endedAt: now, updatedAt: now, wakeAt: null })
        .where(eq(runs.id, run.id));
      return;
    }
    const ctx = await context(
      deps,
      tx,
      run.workspaceId,
      run.contactId,
      run.channel,
      now,
      queued,
      notices,
    );
    await step(ctx, run, { type: 'wake', token });
  });
  await deliver(deps, queued);
  notifyAll(deps, notices);
}

/** Wakes every run whose delay or timeout is due. Returns how many it looked at. */
export async function wakeDue(deps: RuntimeDeps, limit = 50) {
  const now = deps.now?.() ?? new Date();
  const due = await deps.db
    .select({ id: runs.id, token: runs.wakeToken })
    .from(runs)
    .where(and(eq(runs.status, 'waiting'), lte(runs.wakeAt, now)))
    .orderBy(asc(runs.wakeAt))
    .limit(limit);
  for (const r of due) {
    try {
      if (r.token) await wake(deps, r.id, r.token);
    } catch (err) {
      // Fail the run rather than retrying it every tick forever.
      const error = err instanceof Error ? err.message : String(err);
      deps.log?.('wake failed', { runId: r.id, error });
      await deps.db
        .update(runs)
        .set({ status: 'failed', error, endedAt: now, updatedAt: now, wakeAt: null })
        .where(and(eq(runs.id, r.id), eq(runs.status, 'waiting')));
    }
  }
  return due.length;
}

/** Sends queued messages. Also used by the worker to retry anything left queued by a crash. */
export async function deliver(deps: RuntimeDeps, ids: string[]) {
  for (const id of ids) {
    const [m] = await deps.db.select().from(messages).where(eq(messages.id, id));
    if (m?.status !== 'queued' || m.content.kind !== 'out') continue;
    const [identity] = await deps.db
      .select({
        externalId: contactIdentities.externalId,
        accountRef: contactIdentities.accountRef,
      })
      .from(contactIdentities)
      .where(
        and(eq(contactIdentities.contactId, m.contactId), eq(contactIdentities.channel, m.channel)),
      )
      .limit(1);
    const adapter = deps.channels.get(m.channel);
    let result: SendResult;
    if (!adapter) result = { status: 'failed', error: `No "${m.channel}" channel is connected.` };
    else if (!identity)
      result = { status: 'failed', error: `The contact has no ${m.channel} identity.` };
    else {
      result = await adapter
        .send(
          {
            workspaceId: m.workspaceId,
            contactId: m.contactId,
            externalId: identity.externalId,
            accountRef: identity.accountRef,
          },
          m.content,
        )
        .catch((err: unknown) => ({
          status: 'failed' as const,
          error: err instanceof Error ? err.message : String(err),
        }));
    }
    await deps.db
      .update(messages)
      .set({
        status: result.status,
        error: 'error' in result ? result.error : null,
        sentAt: result.status === 'sent' ? new Date() : null,
        externalId: result.status === 'sent' ? (result.externalId ?? null) : null,
      })
      .where(eq(messages.id, id));
  }
}

export async function deliverStale(deps: RuntimeDeps, olderThanMs = 30_000) {
  const before = new Date((deps.now?.() ?? new Date()).getTime() - olderThanMs);
  const stale = await deps.db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.status, 'queued'), lte(messages.createdAt, before)))
    .limit(100);
  await deliver(
    deps,
    stale.map((m) => m.id),
  );
  return stale.length;
}

// ---------------------------------------------------------------- internals

async function context(
  deps: RuntimeDeps,
  tx: Tx,
  workspaceId: string,
  contactId: string,
  channel: string,
  now: Date,
  queued: string[],
  notices: Notice[],
): Promise<Ctx> {
  const [ws] = await tx
    .select({ timeZone: workspaces.timeZone })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return {
    deps,
    tx,
    workspaceId,
    contactId,
    channel,
    timeZone: ws?.timeZone ?? 'UTC',
    now,
    queued,
    notices,
    hops: 0,
  };
}

async function loadVersion(
  tx: Tx,
  workspaceId: string,
  versionId: string,
): Promise<Version | undefined> {
  const [v] = await tx
    .select({ id: flowVersions.id, flowId: flowVersions.flowId, graph: flowVersions.graph })
    .from(flowVersions)
    .where(and(eq(flowVersions.id, versionId), eq(flowVersions.workspaceId, workspaceId)));
  return v;
}

async function waitingRun(ctx: Ctx, kinds: string[]) {
  const [run] = await ctx.tx
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.contactId, ctx.contactId),
        eq(runs.status, 'waiting'),
        inArray(runs.waitKind, kinds),
      ),
    )
    .orderBy(desc(runs.updatedAt))
    .limit(1);
  return run;
}

/** Starting a new conversation abandons any question still waiting for an answer. Delays keep running. */
async function cancelConversationRuns(ctx: Ctx) {
  await ctx.tx
    .update(runs)
    .set({ status: 'cancelled', endedAt: ctx.now, updatedAt: ctx.now, wakeAt: null })
    .where(
      and(
        eq(runs.contactId, ctx.contactId),
        eq(runs.status, 'waiting'),
        inArray(runs.waitKind, CONVERSATION_WAITS),
      ),
    );
}

const runColumns = (state: RunState, now: Date) => ({
  status: state.status,
  state,
  waitKind: state.wait?.kind ?? null,
  wakeAt: state.wait ? new Date(state.wait.until) : null,
  wakeToken: state.wait?.token ?? null,
  error: state.error ?? null,
  updatedAt: now,
  endedAt: state.status === 'waiting' ? null : now,
});

async function begin(ctx: Ctx, version: Version, event: EngineEvent, triggerId?: string) {
  const snapshot = await loadSnapshot(ctx.tx, ctx.contactId, ctx.channel);
  const result = advance(version.graph, null, event, {
    contact: snapshot,
    now: ctx.now,
    timeZone: ctx.timeZone,
  });
  const runId = randomUUID();
  await ctx.tx.insert(runs).values({
    id: runId,
    workspaceId: ctx.workspaceId,
    contactId: ctx.contactId,
    flowId: version.flowId,
    flowVersionId: version.id,
    triggerId,
    channel: ctx.channel,
    // A "go to flow" run starts in the same instant as its caller; nudge it by its hop count
    // so run lists still show it as the later of the two.
    startedAt: new Date(ctx.now.getTime() + ctx.hops),
    ...runColumns(result.state, ctx.now),
  });
  await recordEvent(ctx.tx, ctx.workspaceId, ctx.contactId, 'flow_started', {
    flowId: version.flowId,
    runId,
    triggerId,
  });
  await persist(ctx, { id: runId, flowId: version.flowId, flowVersionId: version.id }, result);
  return runId;
}

async function step(ctx: Ctx, run: RunRow, event: EngineEvent) {
  const version = await loadVersion(ctx.tx, ctx.workspaceId, run.flowVersionId);
  if (!version) return false;
  const snapshot = await loadSnapshot(ctx.tx, ctx.contactId, run.channel);
  const result = advance(version.graph, run.state, event, {
    contact: snapshot,
    now: ctx.now,
    timeZone: ctx.timeZone,
  });
  if (!result.handled) return false;
  await ctx.tx.update(runs).set(runColumns(result.state, ctx.now)).where(eq(runs.id, run.id));
  await persist(ctx, run, result);
  return true;
}

/** Applies what the engine decided: messages to the outbox, tags, fields, consent, events. */
async function persist(
  ctx: Ctx,
  run: { id: string; flowId: string; flowVersionId: string },
  result: AdvanceResult,
) {
  const { tx, workspaceId, contactId } = ctx;
  if (result.visited.length > 0) {
    await tx.insert(runSteps).values(
      result.visited.map((nodeId) => ({
        workspaceId,
        runId: run.id,
        flowVersionId: run.flowVersionId,
        nodeId,
      })),
    );
  }

  let fieldsChanged = false;
  const nextFlows: string[] = [];
  for (const e of result.effects) {
    switch (e.type) {
      case 'send': {
        const payloads: Record<string, string> = {};
        for (const q of e.message.quickReplies)
          payloads[q.id] = encodePayload(run.flowVersionId, e.nodeId, q.id);
        for (const b of e.message.buttons)
          if (b.kind === 'flow') payloads[b.id] = encodePayload(run.flowVersionId, e.nodeId, b.id);
        // After a comment, Instagram allows one private reply until the person writes back.
        // Hold anything after it, with the reason, instead of letting Instagram reject it.
        const reply = ctx.commentReply;
        const held = reply?.used === true;
        const [m] = await tx
          .insert(messages)
          .values({
            workspaceId,
            contactId,
            channel: ctx.channel,
            direction: 'out',
            status: held ? 'blocked' : 'queued',
            error: held
              ? 'Instagram allows one reply to a comment until the person writes back. Put a quick reply or button on the first message so they can continue.'
              : null,
            content: {
              kind: 'out',
              message: e.message,
              payloads,
              ...(reply && !held ? { privateReplyTo: reply.commentId } : {}),
            },
            runId: run.id,
            nodeId: e.nodeId,
          })
          .returning({ id: messages.id });
        if (reply) reply.used = true;
        if (m && !held) ctx.queued.push(m.id);
        break;
      }
      case 'add_tag':
        if (await addTag(tx, workspaceId, contactId, e.tag))
          await recordEvent(tx, workspaceId, contactId, 'tag_added', { tag: e.tag, runId: run.id });
        break;
      case 'remove_tag':
        if (await removeTag(tx, workspaceId, contactId, e.tag))
          await recordEvent(tx, workspaceId, contactId, 'tag_removed', {
            tag: e.tag,
            runId: run.id,
          });
        break;
      case 'set_field':
      case 'clear_field':
        fieldsChanged = true;
        await recordEvent(tx, workspaceId, contactId, 'field_set', {
          key: e.key,
          value: e.type === 'set_field' ? e.value : null,
          runId: run.id,
        });
        break;
      case 'set_consent':
        await tx.insert(consents).values({
          workspaceId,
          contactId,
          channel: e.channel,
          granted: e.granted,
          source: `flow:${run.flowId}`,
        });
        await recordEvent(tx, workspaceId, contactId, 'consent_changed', {
          channel: e.channel,
          granted: e.granted,
          runId: run.id,
        });
        break;
      case 'notify_team':
        await recordEvent(tx, workspaceId, contactId, 'team_notified', {
          message: e.message,
          runId: run.id,
        });
        ctx.notices.push({
          workspaceId,
          contactId,
          channel: ctx.channel,
          kind: 'team',
          text: e.message,
        });
        break;
      case 'handoff':
        await tx
          .update(contacts)
          .set({ automationPausedAt: ctx.now, automationResumeAt: null })
          .where(eq(contacts.id, contactId));
        await tx
          .update(runs)
          .set({ status: 'cancelled', endedAt: ctx.now, updatedAt: ctx.now, wakeAt: null })
          .where(
            and(
              eq(runs.contactId, contactId),
              eq(runs.status, 'waiting'),
              sql`${runs.id} <> ${run.id}`,
            ),
          );
        await recordEvent(tx, workspaceId, contactId, 'handoff', { note: e.note, runId: run.id });
        ctx.notices.push({
          workspaceId,
          contactId,
          channel: ctx.channel,
          kind: 'handoff',
          text: e.note,
        });
        break;
      case 'start_flow':
        nextFlows.push(e.flowId);
        break;
    }
  }
  if (fieldsChanged) await saveFields(tx, workspaceId, contactId, result.contact.fields);

  const { status, error } = result.state;
  if (status !== 'waiting') {
    await recordEvent(tx, workspaceId, contactId, `flow_${status}`, {
      flowId: run.flowId,
      runId: run.id,
      ...(error ? { error } : {}),
    });
  }

  for (const flowId of nextFlows) {
    if (ctx.hops >= MAX_FLOW_HOPS) {
      await recordEvent(tx, workspaceId, contactId, 'flow_failed', {
        flowId,
        error: `Stopped after ${MAX_FLOW_HOPS} "go to flow" steps in a row.`,
      });
      continue;
    }
    const [target] = await tx
      .select({ versionId: flows.publishedVersionId })
      .from(flows)
      .where(
        and(eq(flows.id, flowId), eq(flows.workspaceId, workspaceId), isNull(flows.archivedAt)),
      );
    const version = target?.versionId
      ? await loadVersion(tx, workspaceId, target.versionId)
      : undefined;
    if (!version) {
      await recordEvent(tx, workspaceId, contactId, 'flow_failed', {
        flowId,
        error: 'The flow to go to isn’t published.',
      });
      continue;
    }
    ctx.hops++;
    await begin(ctx, version, { type: 'start' });
  }
}

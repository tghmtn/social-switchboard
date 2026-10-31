import { type ContactSnapshot, type FieldValue, SYSTEM_FIELDS } from '@social-switchboard/flow';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  contactEvents,
  contactIdentities,
  contacts,
  contactTags,
  fieldDefinitions,
  tags,
} from '../db/schema';

const SYSTEM = new Set<string>(SYSTEM_FIELDS);

/**
 * Serializes everything that touches one contact (inbound messages, timers, edits) for the
 * rest of the transaction, so two events can't advance the same run at once.
 */
export async function lockContact(tx: Tx, contactId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`contact:${contactId}`}, 0))`,
  );
}

export type Profile = {
  firstName?: string;
  lastName?: string;
  username?: string;
  accountRef?: string;
};

/** Finds the contact behind a channel identity, creating both on first contact. */
export async function findOrCreateContact(
  tx: Tx,
  workspaceId: string,
  channel: string,
  externalId: string,
  profile: Profile = {},
): Promise<{ contactId: string; isNew: boolean }> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`identity:${workspaceId}:${channel}:${externalId}`}, 0))`,
  );
  const [existing] = await tx
    .select({ contactId: contactIdentities.contactId })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.workspaceId, workspaceId),
        eq(contactIdentities.channel, channel),
        eq(contactIdentities.externalId, externalId),
      ),
    );
  if (existing) return { contactId: existing.contactId, isNew: false };

  const [created] = await tx
    .insert(contacts)
    .values({ workspaceId, firstName: profile.firstName, lastName: profile.lastName })
    .returning({ id: contacts.id });
  if (!created) throw new Error('contact insert returned no row');
  await tx.insert(contactIdentities).values({
    workspaceId,
    channel,
    externalId,
    contactId: created.id,
    username: profile.username,
    accountRef: profile.accountRef,
  });
  await recordEvent(tx, workspaceId, created.id, 'contact_created', { channel });
  return { contactId: created.id, isNew: true };
}

export async function loadSnapshot(
  tx: Tx,
  contactId: string,
  channel: string,
): Promise<ContactSnapshot> {
  const [row] = await tx.select().from(contacts).where(eq(contacts.id, contactId));
  if (!row) throw new Error(`contact ${contactId} not found`);
  const tagRows = await tx
    .select({ name: tags.name })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(eq(contactTags.contactId, contactId))
    .orderBy(contactTags.createdAt);
  return {
    id: row.id,
    channel,
    tags: tagRows.map((t) => t.name),
    fields: {
      ...row.customFields,
      first_name: row.firstName,
      last_name: row.lastName,
      email: row.email,
      phone: row.phone,
    },
  };
}

/** Writes a contact's fields back: system keys to columns, the rest to custom_fields. */
export async function saveFields(
  tx: Tx,
  workspaceId: string,
  contactId: string,
  fields: Record<string, FieldValue>,
) {
  const custom: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SYSTEM.has(key) && value !== null && value !== undefined) custom[key] = value;
  }
  const str = (v: FieldValue | undefined) =>
    v === null || v === undefined || v === '' ? null : String(v);
  await tx
    .update(contacts)
    .set({
      firstName: str(fields.first_name),
      lastName: str(fields.last_name),
      email: str(fields.email),
      phone: str(fields.phone),
      customFields: custom,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));

  // Make sure fields a flow invents show up in the UI and CSV export.
  const unknown = Object.keys(custom);
  if (unknown.length > 0) {
    await tx
      .insert(fieldDefinitions)
      .values(unknown.map((key) => ({ workspaceId, key, label: humanize(key) })))
      .onConflictDoNothing();
  }
}

export async function addTag(tx: Tx, workspaceId: string, contactId: string, name: string) {
  await tx.insert(tags).values({ workspaceId, name }).onConflictDoNothing();
  const [tag] = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.workspaceId, workspaceId), sql`lower(${tags.name}) = lower(${name})`));
  if (!tag) throw new Error(`tag ${name} missing after upsert`);
  const inserted = await tx
    .insert(contactTags)
    .values({ contactId, tagId: tag.id })
    .onConflictDoNothing()
    .returning();
  return inserted.length > 0;
}

export async function removeTag(tx: Tx, workspaceId: string, contactId: string, name: string) {
  const removed = await tx
    .delete(contactTags)
    .where(
      and(
        eq(contactTags.contactId, contactId),
        sql`${contactTags.tagId} in (select id from tags where workspace_id = ${workspaceId} and lower(name) = lower(${name}))`,
      ),
    )
    .returning();
  return removed.length > 0;
}

export async function recordEvent(
  tx: Tx,
  workspaceId: string,
  contactId: string,
  type: string,
  data: Record<string, unknown> = {},
) {
  await tx.insert(contactEvents).values({ workspaceId, contactId, type, data });
}

export const humanize = (key: string) =>
  key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');

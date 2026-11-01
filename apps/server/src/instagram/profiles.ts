import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { contactAvatars, contactIdentities, contacts } from '../db/schema';
import type { Profile } from '../runtime/contacts';
import { downloadImage, type UserProfile } from './graph';

// Someone's Instagram profile (name, picture, follows) onto their identity and contact. Instagram
// shares it only after they've messaged the account, so it's read then, on every message or tap:
// whether they follow can change from one minute to the next, and a flow may be checking. The
// picture is copied at most once a week.

const PICTURE_REFRESH = 7 * 24 * 3_600_000;

/** "Oliver Gharring" → Oliver / Gharring. One word is a first name. */
export function splitName(name?: string): { firstName?: string; lastName?: string } {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length === 0) return {};
  return { firstName: words[0], lastName: words.slice(1).join(' ') || undefined };
}

const identity = (workspaceId: string, igsid: string) =>
  and(
    eq(contactIdentities.workspaceId, workspaceId),
    eq(contactIdentities.channel, 'instagram'),
    eq(contactIdentities.externalId, igsid),
  );

/** What a brand-new contact starts with. */
export const newContactProfile = (p?: UserProfile): Profile | undefined =>
  p && { username: p.username, ...splitName(p.name), followsUs: p.is_user_follow_business };

/**
 * Saves the profile onto their identity, and their name onto the contact when it has none yet
 * (never over a name someone typed or a flow collected). False if we haven't met them yet.
 */
export async function saveProfile(db: Db, workspaceId: string, igsid: string, p: UserProfile) {
  const [saved] = await db
    .update(contactIdentities)
    .set({
      ...(p.username ? { username: p.username } : {}),
      displayName: p.name ?? null,
      followsUs: p.is_user_follow_business ?? null,
      weFollow: p.is_business_follow_user ?? null,
      followerCount: p.follower_count ?? null,
      verified: p.is_verified_user ?? null,
      profileSyncedAt: new Date(),
    })
    .where(identity(workspaceId, igsid))
    .returning({ contactId: contactIdentities.contactId });
  if (!saved) return false;
  const { firstName, lastName } = splitName(p.name);
  if (firstName)
    await db
      .update(contacts)
      .set({ firstName, lastName: lastName ?? null, updatedAt: new Date() })
      .where(
        and(
          eq(contacts.id, saved.contactId),
          isNull(contacts.firstName),
          isNull(contacts.lastName),
        ),
      );
  return true;
}

/**
 * Keeps a copy of their picture (Instagram's links expire after a few days), refreshed weekly;
 * none removes it.
 */
export async function saveAvatar(db: Db, workspaceId: string, igsid: string, url?: string) {
  const [known] = await db
    .select({ contactId: contactIdentities.contactId })
    .from(contactIdentities)
    .where(identity(workspaceId, igsid));
  if (!known) return;
  if (!url) {
    await db.delete(contactAvatars).where(eq(contactAvatars.contactId, known.contactId));
    return;
  }
  const [kept] = await db
    .select({ at: contactAvatars.updatedAt })
    .from(contactAvatars)
    .where(eq(contactAvatars.contactId, known.contactId));
  if (kept && Date.now() - kept.at.getTime() < PICTURE_REFRESH) return;
  const image = await downloadImage(url);
  if (!image) return; // keep the one we have
  const values = { contentType: image.contentType, data: image.data, updatedAt: new Date() };
  await db
    .insert(contactAvatars)
    .values({ contactId: known.contactId, workspaceId, ...values })
    .onConflictDoUpdate({ target: contactAvatars.contactId, set: values });
}

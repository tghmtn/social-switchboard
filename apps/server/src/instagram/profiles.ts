import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { contactAvatars, contactIdentities, contacts } from '../db/schema';
import type { Profile } from '../runtime/contacts';
import { downloadImage, type Host, type UserProfile, userProfile } from './graph';

// Someone's Instagram profile (name, picture, follows) onto their identity and contact. Instagram
// shares it only after they've messaged the account, so it's fetched then, at most once a week.

const REFRESH_AFTER = 7 * 24 * 3_600_000;

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

/** Their profile, when ours is missing or a week old. Undefined when it's fresh or unavailable. */
export async function staleProfile(
  db: Db,
  workspaceId: string,
  igsid: string,
  token: string,
  host: Host,
): Promise<UserProfile | undefined> {
  const [known] = await db
    .select({ at: contactIdentities.profileSyncedAt })
    .from(contactIdentities)
    .where(identity(workspaceId, igsid));
  if (known?.at && Date.now() - known.at.getTime() < REFRESH_AFTER) return undefined;
  return userProfile(token, igsid, host);
}

/** What a brand-new contact starts with. */
export const newContactProfile = (p?: UserProfile): Profile | undefined =>
  p && { username: p.username, ...splitName(p.name) };

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

/** Keeps a copy of their picture (Instagram's links expire after a few days); none removes it. */
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
  const image = await downloadImage(url);
  if (!image) return; // keep the one we have
  const values = { contentType: image.contentType, data: image.data, updatedAt: new Date() };
  await db
    .insert(contactAvatars)
    .values({ contactId: known.contactId, workspaceId, ...values })
    .onConflictDoUpdate({ target: contactAvatars.contactId, set: values });
}

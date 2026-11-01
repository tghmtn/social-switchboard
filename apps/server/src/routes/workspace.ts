import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { decryptSecret, encryptSecret } from '../crypto';
import { invites, users, workspaceMembers, workspaces } from '../db/schema';
import { ntfyTarget, publish } from '../notify';
import { conflict, notFound, requireAdmin, requireWorkspace, who } from './guard';

// Workspace settings: push notifications, and the team (members, roles, invite links).

/** Invite links are good for a week; only their hash is stored. */
const INVITE_DAYS = 7;
export const inviteHash = (token: string) => createHash('sha256').update(token).digest('hex');

export const workspaceRoutes =
  ({ db, config }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireWorkspace);

    const notifications = async (workspaceId: string) => {
      const [ws] = await db
        .select({ url: workspaces.notifyUrl, tokenEnc: workspaces.notifyTokenEnc })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      return { url: ws?.url ?? null, hasToken: Boolean(ws?.tokenEnc), tokenEnc: ws?.tokenEnc };
    };

    app.get('/settings/notifications', async (req) => {
      const { workspace } = who(req);
      const { url, hasToken } = await notifications(workspace.id);
      return { url, hasToken };
    });

    app.put('/settings/notifications', async (req) => {
      const { workspace } = requireAdmin(req);
      const body = z
        .object({
          url: z
            .url()
            .refine((u) => u.startsWith('https://') && Boolean(ntfyTarget(u)), {
              message: 'Paste an ntfy topic URL, like https://ntfy.sh/my-switchboard.',
            })
            .nullable(),
          /** A new token, or null to remove it; leave it out to keep the saved one. */
          token: z.string().trim().max(200).nullable().optional(),
        })
        .parse(req.body);
      await db
        .update(workspaces)
        .set({
          notifyUrl: body.url,
          ...(body.token !== undefined
            ? { notifyTokenEnc: body.token ? encryptSecret(config.appSecret, body.token) : null }
            : {}),
        })
        .where(eq(workspaces.id, workspace.id));
      const { url, hasToken } = await notifications(workspace.id);
      return { url, hasToken };
    });

    /** The saved ntfy token, for the eye button (owners and admins). */
    app.post('/settings/notifications/reveal', async (req, reply) => {
      const { workspace } = requireAdmin(req);
      const { tokenEnc } = await notifications(workspace.id);
      if (!tokenEnc) return reply.code(404).send({ error: 'Nothing is saved.' });
      return { value: decryptSecret(config.appSecret, tokenEnc) };
    });

    /** Sends a test push, so you can see it arrive (or why it doesn't). */
    app.post('/settings/notifications/test', async (req, reply) => {
      const { workspace } = requireAdmin(req);
      const n = await notifications(workspace.id);
      if (!n.url) return reply.code(409).send({ error: 'Save an ntfy topic URL first.' });
      try {
        await publish(
          {
            url: n.url,
            token: n.tokenEnc ? decryptSecret(config.appSecret, n.tokenEnc) : undefined,
          },
          {
            title: 'Social Switchboard',
            text: 'Notifications work. You’ll hear from us when a conversation needs you.',
            click: `${config.publicUrl}/inbox`,
            tags: ['white_check_mark'],
          },
        );
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
      }
      return { ok: true };
    });

    const team = async (workspaceId: string) => {
      const [members, pending] = await Promise.all([
        db
          .select({
            userId: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
            role: workspaceMembers.role,
            since: workspaceMembers.createdAt,
          })
          .from(workspaceMembers)
          .innerJoin(users, eq(users.id, workspaceMembers.userId))
          .where(eq(workspaceMembers.workspaceId, workspaceId))
          .orderBy(asc(workspaceMembers.createdAt)),
        db
          .select({
            id: invites.id,
            email: invites.email,
            role: invites.role,
            expiresAt: invites.expiresAt,
          })
          .from(invites)
          .where(
            and(
              eq(invites.workspaceId, workspaceId),
              isNull(invites.acceptedAt),
              gt(invites.expiresAt, new Date()),
            ),
          )
          .orderBy(asc(invites.createdAt)),
      ]);
      return { members, invites: pending };
    };

    app.get('/team', async (req) => team(who(req).workspace.id));

    /** Makes an invite link. Switchboard doesn't send email yet, so the link is shown to copy. */
    app.post('/team/invites', async (req) => {
      const { user, workspace } = requireAdmin(req);
      const body = z
        .object({
          email: z
            .email('Enter a valid email address.')
            .max(254)
            .transform((e) => e.toLowerCase()),
          role: z.enum(['admin', 'agent']),
        })
        .parse(req.body);
      const [member] = await db
        .select({ id: users.id })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(users.email, body.email)));
      if (member) throw conflict('They’re already on the team.');
      const token = randomBytes(24).toString('base64url');
      await db.insert(invites).values({
        workspaceId: workspace.id,
        email: body.email,
        role: body.role,
        tokenHash: inviteHash(token),
        invitedBy: user.id,
        expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 3_600_000),
      });
      return { link: `${config.publicUrl}/invite/${token}`, ...(await team(workspace.id)) };
    });

    app.delete('/team/invites/:id', async (req) => {
      const { workspace } = requireAdmin(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      await db
        .delete(invites)
        .where(and(eq(invites.id, id), eq(invites.workspaceId, workspace.id)));
      return team(workspace.id);
    });

    const owners = async (workspaceId: string) =>
      (
        await db
          .select({ id: workspaceMembers.userId })
          .from(workspaceMembers)
          .where(
            and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')),
          )
      ).map((o) => o.id);

    /** Owners change roles; the last owner stays an owner. */
    app.patch('/team/members/:userId', async (req) => {
      const { workspace } = who(req);
      if (workspace.role !== 'owner')
        throw Object.assign(new Error('Only owners can change roles.'), { statusCode: 403 });
      const { userId } = z.object({ userId: z.uuid() }).parse(req.params);
      const { role } = z.object({ role: z.enum(['owner', 'admin', 'agent']) }).parse(req.body);
      const current = await owners(workspace.id);
      if (role !== 'owner' && current.length === 1 && current[0] === userId)
        throw conflict('Make someone else an owner first.');
      const updated = await db
        .update(workspaceMembers)
        .set({ role })
        .where(
          and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, userId)),
        )
        .returning({ id: workspaceMembers.userId });
      if (updated.length === 0) throw notFound('Teammate');
      return team(workspace.id);
    });

    /** Removes someone (or lets you leave). Admins can't remove owners; the last owner stays. */
    app.delete('/team/members/:userId', async (req) => {
      const { user, workspace } = who(req);
      const { userId } = z.object({ userId: z.uuid() }).parse(req.params);
      const [target] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, userId)),
        );
      if (!target) throw notFound('Teammate');
      if (userId !== user.id) {
        requireAdmin(req);
        if (target.role === 'owner' && workspace.role !== 'owner')
          throw Object.assign(new Error('Only owners can remove an owner.'), { statusCode: 403 });
      }
      const current = await owners(workspace.id);
      if (target.role === 'owner' && current.length === 1)
        throw conflict('The last owner can’t be removed. Make someone else an owner first.');
      await db
        .delete(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, userId)),
        );
      return team(workspace.id);
    });
  };

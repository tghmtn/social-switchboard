import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { decryptSecret, encryptSecret } from '../crypto';
import {
  ALERT_CHANNELS,
  invites,
  NOTICE_KINDS,
  notificationPrefs,
  pushSubscriptions,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema';
import {
  alertEmail,
  DEFAULT_EVENTS,
  NOTICE_INFO,
  notifyDevice,
  ntfyTarget,
  publish,
  recipients,
  sendEmail,
  senders,
  sendSms,
} from '../notify';
import { deviceLabel, vapidKeys } from '../webpush';
import { conflict, notFound, requireAdmin, requireWorkspace, who } from './guard';

// Workspace settings: notifications (the senders, and each teammate's choices), and the team
// (members, roles, invite links).

const ntfyUrl = z.url().refine((u) => u.startsWith('https://') && Boolean(ntfyTarget(u)), {
  message: 'Paste an ntfy topic URL, like https://ntfy.sh/my-switchboard.',
});

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
    const myPrefs = async (workspaceId: string, userId: string) => {
      const [row] = await db
        .select()
        .from(notificationPrefs)
        .where(
          and(eq(notificationPrefs.workspaceId, workspaceId), eq(notificationPrefs.userId, userId)),
        );
      return row;
    };
    const myDevices = (workspaceId: string, userId: string) =>
      db
        .select()
        .from(pushSubscriptions)
        .where(
          and(eq(pushSubscriptions.workspaceId, workspaceId), eq(pushSubscriptions.userId, userId)),
        )
        .orderBy(desc(pushSubscriptions.createdAt));

    /** Everything on the Notifications page: the senders, and this teammate's own choices. */
    app.get('/settings/notifications', async (req) => {
      const { user, workspace } = who(req);
      const [[ws], mine, [account], devices] = await Promise.all([
        db
          .select({
            url: workspaces.notifyUrl,
            tokenEnc: workspaces.notifyTokenEnc,
            smtp: workspaces.smtp,
            smtpPassEnc: workspaces.smtpPassEnc,
            twilio: workspaces.twilio,
            twilioTokenEnc: workspaces.twilioTokenEnc,
          })
          .from(workspaces)
          .where(eq(workspaces.id, workspace.id)),
        myPrefs(workspace.id, user.id),
        db.select({ email: users.email }).from(users).where(eq(users.id, user.id)),
        myDevices(workspace.id, user.id),
      ]);
      return {
        /** The shared team topic: hears every alert but personal assignments. */
        url: ws?.url ?? null,
        hasToken: Boolean(ws?.tokenEnc),
        email: ws?.smtp ? { ...ws.smtp, hasPassword: Boolean(ws.smtpPassEnc) } : null,
        sms: ws?.twilio ? { ...ws.twilio, hasToken: Boolean(ws.twilioTokenEnc) } : null,
        mine: {
          pushUrl: mine?.pushUrl ?? null,
          hasPushToken: Boolean(mine?.pushTokenEnc),
          email: mine?.email ?? null,
          accountEmail: account?.email ?? '',
          phone: mine?.phone ?? null,
          events: { ...DEFAULT_EVENTS, ...(mine?.events ?? {}) },
          /** Browsers and installed apps with Switchboard's notifications turned on. */
          devices: devices.map((d) => ({
            id: d.id,
            label: d.label,
            endpoint: d.endpoint,
            createdAt: d.createdAt,
            lastSentAt: d.lastSentAt,
          })),
        },
        /** For turning notifications on in a browser (Web Push's application server key). */
        vapidKey: vapidKeys(config.appSecret).publicKey,
        kinds: NOTICE_KINDS.map((id) => ({ id, ...NOTICE_INFO[id] })),
      };
    });

    /** The shared team topic. */
    app.put('/settings/notifications', async (req) => {
      const { workspace } = requireAdmin(req);
      const body = z
        .object({
          url: ntfyUrl.nullable(),
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

    /** Email alerts: the SMTP server they go out through (any provider). */
    app.put('/settings/notifications/email', async (req) => {
      const { workspace } = requireAdmin(req);
      const body = z
        .object({
          host: z
            .string()
            .trim()
            .regex(/^[a-z0-9.-]{1,200}$/i, 'Enter the server name, like smtp.gmail.com.'),
          port: z.coerce.number().int().min(1).max(65535),
          security: z.enum(['tls', 'starttls', 'none']),
          user: z.string().trim().max(200).default(''),
          /** A new password, or null to remove it; leave it out to keep the saved one. */
          password: z.string().max(500).nullable().optional(),
          from: z.email('Enter the address alerts come from.'),
          fromName: z.string().trim().max(100).default('Social Switchboard'),
        })
        .parse(req.body);
      const { password, ...smtp } = body;
      await db
        .update(workspaces)
        .set({
          smtp,
          ...(password !== undefined
            ? { smtpPassEnc: password ? encryptSecret(config.appSecret, password) : null }
            : {}),
        })
        .where(eq(workspaces.id, workspace.id));
      return { ok: true };
    });
    app.delete('/settings/notifications/email', async (req) => {
      const { workspace } = requireAdmin(req);
      await db
        .update(workspaces)
        .set({ smtp: null, smtpPassEnc: null })
        .where(eq(workspaces.id, workspace.id));
      return { ok: true };
    });

    /** Text-message alerts: the Twilio account they're sent from. */
    app.put('/settings/notifications/sms', async (req, reply) => {
      const { workspace } = requireAdmin(req);
      const body = z
        .object({
          accountSid: z
            .string()
            .trim()
            .regex(
              /^AC[0-9a-f]{32}$/i,
              'The Account SID starts with AC (Twilio console, Account Info).',
            ),
          /** A new auth token; leave it out to keep the saved one. */
          token: z.string().trim().min(16).max(128).optional(),
          from: z
            .string()
            .trim()
            .regex(
              /^(\+[1-9]\d{6,14}|MG[0-9a-f]{32})$/i,
              'Use your Twilio number with the country code, like +18015551234 (or a Messaging Service SID).',
            ),
        })
        .parse(req.body);
      const [ws] = await db
        .select({ tokenEnc: workspaces.twilioTokenEnc })
        .from(workspaces)
        .where(eq(workspaces.id, workspace.id));
      if (!body.token && !ws?.tokenEnc)
        return reply.code(400).send({ error: 'Enter the auth token.' });
      await db
        .update(workspaces)
        .set({
          twilio: { accountSid: body.accountSid, from: body.from },
          ...(body.token ? { twilioTokenEnc: encryptSecret(config.appSecret, body.token) } : {}),
        })
        .where(eq(workspaces.id, workspace.id));
      return { ok: true };
    });
    app.delete('/settings/notifications/sms', async (req) => {
      const { workspace } = requireAdmin(req);
      await db
        .update(workspaces)
        .set({ twilio: null, twilioTokenEnc: null })
        .where(eq(workspaces.id, workspace.id));
      return { ok: true };
    });

    /** This teammate's own addresses and which alerts go where. */
    app.put('/settings/notifications/mine', async (req) => {
      const { user, workspace } = who(req);
      const body = z
        .object({
          pushUrl: ntfyUrl.nullable().optional(),
          /** A new token, or null to remove it; leave it out to keep the saved one. */
          pushToken: z.string().trim().max(200).nullable().optional(),
          email: z.email('That doesn’t look like an email address.').nullable().optional(),
          phone: z
            .string()
            .trim()
            .regex(/^\+[1-9]\d{6,14}$/, 'Use the country code, like +18015551234.')
            .nullable()
            .optional(),
          events: z
            .partialRecord(
              z.enum(NOTICE_KINDS),
              z.array(z.enum(ALERT_CHANNELS)).max(ALERT_CHANNELS.length),
            )
            .optional(),
        })
        .parse(req.body);
      const values = {
        ...(body.pushUrl !== undefined ? { pushUrl: body.pushUrl } : {}),
        ...(body.pushToken !== undefined
          ? {
              pushTokenEnc: body.pushToken ? encryptSecret(config.appSecret, body.pushToken) : null,
            }
          : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(body.events
          ? {
              events: Object.fromEntries(
                Object.entries(body.events).map(([k, v]) => [k, [...new Set(v)]]),
              ),
            }
          : {}),
        updatedAt: new Date(),
      };
      await db
        .insert(notificationPrefs)
        .values({ workspaceId: workspace.id, userId: user.id, ...values })
        .onConflictDoUpdate({
          target: [notificationPrefs.workspaceId, notificationPrefs.userId],
          set: values,
        });
      return { ok: true };
    });

    /**
     * Turns Switchboard's notifications on for this browser or installed app. A device that was
     * someone else's (a shared computer) becomes yours. With your first device, every alert you
     * chose to get some way also comes as a notification.
     */
    app.post('/settings/notifications/devices', async (req, reply) => {
      const { user, workspace } = who(req);
      const body = z
        .object({
          endpoint: z.url().max(2000).startsWith('https://'),
          keys: z.object({
            p256dh: z.string().min(16).max(200),
            auth: z.string().min(8).max(100),
          }),
        })
        .parse(req.body);
      const before = await myDevices(workspace.id, user.id);
      const values = {
        workspaceId: workspace.id,
        userId: user.id,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        label: deviceLabel(req.headers['user-agent']),
      };
      const [row] = await db
        .insert(pushSubscriptions)
        .values({ ...values, endpoint: body.endpoint })
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values })
        .returning({ id: pushSubscriptions.id });
      if (before.length === 0) {
        const mine = await myPrefs(workspace.id, user.id);
        if (mine?.events) {
          const events = Object.fromEntries(
            Object.entries(mine.events).map(([k, v]) => [
              k,
              v.length && !v.includes('browser') ? ['browser' as const, ...v] : v,
            ]),
          );
          await db
            .update(notificationPrefs)
            .set({ events, updatedAt: new Date() })
            .where(
              and(
                eq(notificationPrefs.workspaceId, workspace.id),
                eq(notificationPrefs.userId, user.id),
              ),
            );
        }
      }
      return reply.code(201).send({ id: row?.id });
    });

    /** Turns notifications off for one of your devices. */
    app.delete('/settings/notifications/devices/:id', async (req) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const gone = await db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.id, id),
            eq(pushSubscriptions.workspaceId, workspace.id),
            eq(pushSubscriptions.userId, user.id),
          ),
        )
        .returning({ id: pushSubscriptions.id });
      if (gone.length === 0) throw notFound('Device');
      return { ok: true };
    });

    /** A saved secret, for the eye button: senders' for owners and admins, your own push token. */
    app.post('/settings/notifications/reveal', async (req, reply) => {
      const { which } = z
        .object({ which: z.enum(['team', 'email', 'sms', 'push']).default('team') })
        .parse(req.body ?? {});
      let enc: string | null | undefined;
      if (which === 'push') {
        const { user, workspace } = who(req);
        enc = (await myPrefs(workspace.id, user.id))?.pushTokenEnc;
      } else {
        const { workspace } = requireAdmin(req);
        const [ws] = await db
          .select({
            team: workspaces.notifyTokenEnc,
            email: workspaces.smtpPassEnc,
            sms: workspaces.twilioTokenEnc,
          })
          .from(workspaces)
          .where(eq(workspaces.id, workspace.id));
        enc = ws?.[which];
      }
      if (!enc) return reply.code(404).send({ error: 'Nothing is saved.' });
      return { value: decryptSecret(config.appSecret, enc) };
    });

    /**
     * Sends a test so you can see it arrive (or why it doesn't): to the shared team topic
     * (owners and admins), or to your own devices, push topic, email or phone.
     */
    app.post('/settings/notifications/test', async (req, reply) => {
      const { to } = z
        .object({ to: z.enum(['team', 'browser', 'push', 'email', 'sms']).default('team') })
        .parse(req.body ?? {});
      const { user, workspace } = to === 'team' ? requireAdmin(req) : who(req);
      const from = await senders(db, config.appSecret, workspace.id);
      const me = (await recipients(db, config.appSecret, workspace.id)).find(
        (r) => r.userId === user.id,
      );
      const message = {
        title: 'Social Switchboard',
        text: 'Notifications work. You’ll hear from us when a conversation needs you.',
        click: `${config.publicUrl}/inbox`,
        tags: ['white_check_mark'],
      };
      try {
        if (to === 'team') {
          if (!from.team) return reply.code(409).send({ error: 'Save an ntfy topic URL first.' });
          await publish(from.team, message);
        } else if (to === 'browser') {
          if (!me?.devices.length)
            return reply.code(409).send({ error: 'Turn notifications on for this device first.' });
          const sent = await Promise.all(
            me.devices.map((d) =>
              notifyDevice({ db, appSecret: config.appSecret, publicUrl: config.publicUrl }, d, {
                title: message.title,
                body: message.text,
                url: message.click,
                tag: 'test',
              }),
            ),
          );
          if (!sent.includes(true))
            return reply.code(409).send({
              error: 'Your devices no longer accept notifications. Turn them on again.',
            });
        } else if (to === 'push') {
          if (!me?.push) return reply.code(409).send({ error: 'Save your push topic first.' });
          await publish(me.push, message);
        } else if (to === 'email') {
          if (!from.smtp)
            return reply.code(409).send({ error: 'An admin needs to set up email first.' });
          if (!me?.email) return reply.code(409).send({ error: 'Save your email address first.' });
          await sendEmail(
            from.smtp,
            alertEmail(me.email, message.title, message.text, message.click, config.publicUrl),
          );
        } else {
          if (!from.twilio)
            return reply.code(409).send({ error: 'An admin needs to set up text messages first.' });
          if (!me?.phone) return reply.code(409).send({ error: 'Save your phone number first.' });
          await sendSms(from.twilio, me.phone, `${message.title}: ${message.text}`);
        }
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

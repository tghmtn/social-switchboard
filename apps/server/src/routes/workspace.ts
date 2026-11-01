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
  SMS_PROVIDERS,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema';
import {
  alertEmail,
  awaitSmsDelivery,
  DEFAULT_EVENTS,
  inviteEmail,
  NOTICE_INFO,
  notifyDevice,
  recipients,
  sendEmail,
  senders,
  sendSms,
  smsChoice,
  smsReady,
} from '../notify';
import { deviceLabel, vapidKeys } from '../webpush';
import { conflict, notFound, requireAdmin, requireWorkspace, who } from './guard';

// Workspace settings: notifications (the senders, and each teammate's choices), and the team
// (members, roles, invite links).

/** Invite links are good for a week; only their hash is stored. */
const INVITE_DAYS = 7;
export const inviteHash = (token: string) => createHash('sha256').update(token).digest('hex');

export const workspaceRoutes =
  ({ db, config }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireWorkspace);

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
            smtp: workspaces.smtp,
            smtpPassEnc: workspaces.smtpPassEnc,
            twilio: workspaces.twilio,
            twilioTokenEnc: workspaces.twilioTokenEnc,
            telnyx: workspaces.telnyx,
            telnyxKeyEnc: workspaces.telnyxKeyEnc,
            smsProvider: workspaces.smsProvider,
          })
          .from(workspaces)
          .where(eq(workspaces.id, workspace.id)),
        myPrefs(workspace.id, user.id),
        db.select({ email: users.email }).from(users).where(eq(users.id, user.id)),
        myDevices(workspace.id, user.id),
      ]);
      return {
        email: ws?.smtp ? { ...ws.smtp, hasPassword: Boolean(ws.smtpPassEnc) } : null,
        sms: ws
          ? {
              /** The one in use (or that will be, once it's set up). */
              provider: smsChoice(ws),
              ready: smsReady(ws),
              twilio: ws.twilio ? { ...ws.twilio, hasToken: Boolean(ws.twilioTokenEnc) } : null,
              telnyx: ws.telnyx ? { ...ws.telnyx, hasKey: Boolean(ws.telnyxKeyEnc) } : null,
            }
          : null,
        mine: {
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

    /** Text-message alerts: a Twilio or Telnyx account. Saving one puts it in use; both are kept. */
    const smsState = async (workspaceId: string) => {
      const [ws] = await db
        .select({
          smsProvider: workspaces.smsProvider,
          twilio: workspaces.twilio,
          twilioTokenEnc: workspaces.twilioTokenEnc,
          telnyx: workspaces.telnyx,
          telnyxKeyEnc: workspaces.telnyxKeyEnc,
        })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      if (!ws) throw notFound('Workspace');
      return ws;
    };
    const phone = (provider: string) =>
      z
        .string()
        .trim()
        .regex(
          /^\+[1-9]\d{6,14}$/,
          `Use your ${provider} number with the country code, like +18015551234.`,
        );

    app.put('/settings/notifications/sms/twilio', async (req, reply) => {
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
      const ws = await smsState(workspace.id);
      if (!body.token && !ws.twilioTokenEnc)
        return reply.code(400).send({ error: 'Enter the auth token.' });
      await db
        .update(workspaces)
        .set({
          twilio: { accountSid: body.accountSid, from: body.from },
          ...(body.token ? { twilioTokenEnc: encryptSecret(config.appSecret, body.token) } : {}),
          smsProvider: 'twilio',
        })
        .where(eq(workspaces.id, workspace.id));
      return { ok: true };
    });

    app.put('/settings/notifications/sms/telnyx', async (req, reply) => {
      const { workspace } = requireAdmin(req);
      const body = z
        .object({
          /** A new API key; leave it out to keep the saved one. */
          apiKey: z.string().trim().min(20, 'Paste the whole API key.').max(300).optional(),
          from: phone('Telnyx'),
        })
        .parse(req.body);
      const ws = await smsState(workspace.id);
      if (!body.apiKey && !ws.telnyxKeyEnc)
        return reply.code(400).send({ error: 'Enter the API key.' });
      await db
        .update(workspaces)
        .set({
          telnyx: { from: body.from },
          ...(body.apiKey ? { telnyxKeyEnc: encryptSecret(config.appSecret, body.apiKey) } : {}),
          smsProvider: 'telnyx',
        })
        .where(eq(workspaces.id, workspace.id));
      return { ok: true };
    });

    /** Which provider sends texts. */
    app.put('/settings/notifications/sms', async (req) => {
      const { workspace } = requireAdmin(req);
      const { provider } = z.object({ provider: z.enum(SMS_PROVIDERS) }).parse(req.body);
      await db
        .update(workspaces)
        .set({ smsProvider: provider })
        .where(eq(workspaces.id, workspace.id));
      return { ok: true };
    });

    /** Forgets a provider. If it was in use, the other one takes over when it's set up. */
    app.delete('/settings/notifications/sms/:provider', async (req) => {
      const { workspace } = requireAdmin(req);
      const { provider } = z.object({ provider: z.enum(SMS_PROVIDERS) }).parse(req.params);
      const ws = await smsState(workspace.id);
      const other = provider === 'twilio' ? 'telnyx' : 'twilio';
      await db
        .update(workspaces)
        .set({
          ...(provider === 'twilio'
            ? { twilio: null, twilioTokenEnc: null }
            : { telnyx: null, telnyxKeyEnc: null }),
          ...(ws.smsProvider === provider
            ? { smsProvider: smsReady(ws)[other] ? other : null }
            : {}),
        })
        .where(eq(workspaces.id, workspace.id));
      return { ok: true };
    });

    /** This teammate's own addresses and which alerts go where. */
    app.put('/settings/notifications/mine', async (req) => {
      const { user, workspace } = who(req);
      const body = z
        .object({
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

    /** A sender's saved secret, for the eye button (owners and admins). */
    app.post('/settings/notifications/reveal', async (req, reply) => {
      const { which } = z
        .object({ which: z.enum(['email', 'twilio', 'telnyx']) })
        .parse(req.body ?? {});
      const { workspace } = requireAdmin(req);
      const [ws] = await db
        .select({
          email: workspaces.smtpPassEnc,
          twilio: workspaces.twilioTokenEnc,
          telnyx: workspaces.telnyxKeyEnc,
        })
        .from(workspaces)
        .where(eq(workspaces.id, workspace.id));
      const enc = ws?.[which];
      if (!enc) return reply.code(404).send({ error: 'Nothing is saved.' });
      return { value: decryptSecret(config.appSecret, enc) };
    });

    /**
     * Sends a test so you can see it arrive (or why it doesn't): to your own devices, email or
     * phone.
     */
    app.post('/settings/notifications/test', async (req, reply) => {
      const { to } = z.object({ to: z.enum(['browser', 'email', 'sms']) }).parse(req.body ?? {});
      const { user, workspace } = who(req);
      const from = await senders(db, config.appSecret, workspace.id);
      const me = (await recipients(db, workspace.id)).find((r) => r.userId === user.id);
      const message = {
        title: 'Social Switchboard',
        text: 'Notifications work. You’ll hear from us when a conversation needs you.',
        click: `${config.publicUrl}/inbox`,
      };
      try {
        if (to === 'browser') {
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
        } else if (to === 'email') {
          if (!from.smtp)
            return reply.code(409).send({ error: 'An admin needs to set up email first.' });
          if (!me?.email) return reply.code(409).send({ error: 'Save your email address first.' });
          await sendEmail(
            from.smtp,
            alertEmail(me.email, message.title, message.text, message.click, config.publicUrl),
          );
        } else {
          if (!from.sms)
            return reply.code(409).send({ error: 'An admin needs to set up text messages first.' });
          if (!me?.phone) return reply.code(409).send({ error: 'Save your phone number first.' });
          // The provider only says whether it arrived a few seconds later: wait to hear.
          const id = await sendSms(from.sms, me.phone, `${message.title}: ${message.text}`);
          const outcome = id ? await awaitSmsDelivery(from.sms, id) : { state: 'pending' as const };
          const name = from.sms.provider === 'telnyx' ? 'Telnyx' : 'Twilio';
          if (outcome.state === 'failed')
            return reply
              .code(502)
              .send({ error: `${name} couldn’t deliver it: ${outcome.reason}` });
          return {
            ok: true,
            note: {
              delivered: 'Delivered. It should be on your phone now.',
              sent: `${name} handed it to your carrier. It should arrive in a moment.`,
              pending: `${name} accepted it but hasn’t confirmed delivery yet. If it doesn’t arrive, ${name}’s message log says why.`,
            }[outcome.state],
          };
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
      const [ws] = await db
        .select({ smtp: workspaces.smtp })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      /** Email is set up, so invites can be sent instead of copied. */
      return { members, invites: pending, canEmail: Boolean(ws?.smtp) };
    };

    app.get('/team', async (req) => team(who(req).workspace.id));

    /**
     * Makes an invite link, and with `send` emails it to them (once email is set up). The link
     * comes back either way, to copy if the email doesn't go.
     */
    app.post('/team/invites', async (req, reply) => {
      const { user, workspace } = requireAdmin(req);
      const body = z
        .object({
          email: z
            .email('Enter a valid email address.')
            .max(254)
            .transform((e) => e.toLowerCase()),
          role: z.enum(['admin', 'agent']),
          send: z.boolean().default(false),
        })
        .parse(req.body);
      const from = body.send ? await senders(db, config.appSecret, workspace.id) : undefined;
      if (body.send && !from?.smtp)
        return reply
          .code(409)
          .send({ error: 'Set up email in Settings → Notifications to send invites.' });
      const [member] = await db
        .select({ id: users.id })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(users.email, body.email)));
      if (member) throw conflict('They’re already on the team.');
      const token = randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 3_600_000);
      await db.insert(invites).values({
        workspaceId: workspace.id,
        email: body.email,
        role: body.role,
        tokenHash: inviteHash(token),
        invitedBy: user.id,
        expiresAt,
      });
      const link = `${config.publicUrl}/invite/${token}`;
      let sent = false;
      let sendError: string | undefined;
      if (from?.smtp) {
        const [ws] = await db
          .select({ name: workspaces.name })
          .from(workspaces)
          .where(eq(workspaces.id, workspace.id));
        try {
          await sendEmail(
            from.smtp,
            inviteEmail({
              to: body.email,
              from: { name: user.name, email: user.email },
              workspace: ws?.name ?? 'the team',
              role: body.role,
              link,
              expiresAt,
            }),
          );
          sent = true;
        } catch (err) {
          sendError = err instanceof Error ? err.message : String(err);
        }
      }
      return { link, sent, sendError, ...(await team(workspace.id)) };
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

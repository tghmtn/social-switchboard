import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { contactIdentities, contacts, deletionRequests, workspaces } from '../db/schema';
import { metaSecrets } from '../instagram/settings';
import { parseSignedRequestAny } from '../meta';

// Public pages Meta requires before an app can go live: a privacy policy and a data-deletion
// callback (plus a status page the callback links to). Every install serves its own.

const META_CHANNELS = ['instagram', 'messenger'];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A plain page in the theme's colors. Fonts fall back to system faces; no scripts. */
function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --bg:#F6F4FF; --surface:#FFFFFF; --ink:#17122B; --muted:#5F5878; --edge:#17122B; --link:#5B2EF0; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg:#121214; --surface:#1C1C20; --ink:#F4F4F2; --muted:#A6A6AF; --edge:#D9D9DE; --link:#B9A6FF; } }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 "Red Hat Text", "Helvetica Neue", Arial, sans-serif; }
  main { max-width:720px; margin:0 auto; padding:48px 16px 64px; }
  .card { background:var(--surface); border:2px solid var(--edge); box-shadow:4px 4px 0 var(--edge); padding:24px; }
  h1 { font:800 clamp(2rem,4.4vw,3rem)/1.05 Fraunces, "Cooper Black", Georgia, serif; margin:0 0 8px; }
  h2 { font-size:18px; margin:28px 0 6px; }
  p, li { color:var(--ink); } .muted { color:var(--muted); font-size:14px; }
  a { color:var(--link); text-decoration-thickness:2px; text-underline-offset:3px; }
  code { font-size:15px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export const legalRoutes =
  ({ db, config }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    // Meta posts the deletion callback as a form. Parse forms here only; the rest of the API stays JSON-only.
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      },
    );

    app.get('/privacy', async (_req, reply) => {
      const [ws] = await db
        .select({ name: workspaces.name })
        .from(workspaces)
        .orderBy(asc(workspaces.createdAt))
        .limit(1);
      const who = esc(ws?.name ?? 'This service');
      const contact = config.privacyContact
        ? `email <a href="mailto:${esc(config.privacyContact)}">${esc(config.privacyContact)}</a> or message us on Instagram`
        : 'message us on Instagram';
      return reply.type('text/html; charset=utf-8').send(
        page(
          `Privacy policy · ${ws?.name ?? 'Social Switchboard'}`,
          `<div class="card">
<h1>Privacy policy</h1>
<p class="muted">${who} replies to messages and comments using Social Switchboard, open-source software it runs on its own server.</p>
<h2>What we collect</h2>
<ul>
<li>Your Instagram (or Messenger) user ID and username, so we know who we’re talking to.</li>
<li>Messages you send us and the replies we send back.</li>
<li>Anything you choose to tell us in the conversation, like your email address or what you’re interested in, plus tags and notes that describe the conversation.</li>
</ul>
<h2>How we use it</h2>
<p>To reply to you, send you what you asked for, and follow up only where you’ve agreed to it. We record when you agree to follow-ups by email or text, and when you withdraw.</p>
<h2>Who sees it</h2>
<p>Only the people who run ${who}. We don’t sell your information. Meta delivers the messages between us under its own privacy policy.</p>
<h2>How long we keep it</h2>
<p>Until you ask us to delete it, or until ${who} deletes it.</p>
<h2>Deleting your data</h2>
<p>Remove this app in your Instagram or Facebook settings (Apps and websites), which sends us a deletion request automatically, or ${contact}. We delete your contact record, your messages and your conversation history.</p>
<h2>Contact</h2>
<p>To ask a question about your data, ${contact}.</p>
<p class="muted">Social Switchboard ${esc(config.version)}</p>
</div>`,
        ),
      );
    });

    app.get('/terms', async (_req, reply) => {
      const [ws] = await db
        .select({ name: workspaces.name })
        .from(workspaces)
        .orderBy(asc(workspaces.createdAt))
        .limit(1);
      const who = esc(ws?.name ?? 'This service');
      return reply.type('text/html; charset=utf-8').send(
        page(
          `Terms · ${ws?.name ?? 'Social Switchboard'}`,
          `<div class="card">
<h1>Terms of service</h1>
<p class="muted">These terms cover messaging ${who} on Instagram or Messenger, where some replies are sent automatically.</p>
<h2>Automated replies</h2>
<p>When you comment a keyword, reply to a story or send us a message, you may get an automatic reply. It might ask a question, share a link or resource, or pass the conversation to a person. Replies are informational, and we can’t promise they’re complete or right for your situation.</p>
<h2>What you share</h2>
<p>Anything you tell us in the conversation, like your email address, is handled as described in our <a href="/privacy">privacy policy</a>. Only share what you’re comfortable sharing.</p>
<h2>Using the service fairly</h2>
<p>Don’t use the conversation to send spam, abuse, or anything unlawful. We may stop replying to accounts that do.</p>
<h2>Links to other sites</h2>
<p>Replies may link to other websites. Those sites have their own terms and privacy policies.</p>
<h2>Changes and contact</h2>
<p>We may update these terms; the current version is always at this address. Questions? ${config.privacyContact ? `Email <a href="mailto:${esc(config.privacyContact)}">${esc(config.privacyContact)}</a> or message` : 'Message'} us on Instagram.</p>
<p class="muted">Social Switchboard ${esc(config.version)}</p>
</div>`,
        ),
      );
    });

    app.get('/data-deletion', async (req, reply) => {
      const { code } = z.object({ code: z.string().max(64).optional() }).parse(req.query);
      const [row] = code
        ? await db
            .select()
            .from(deletionRequests)
            .where(eq(deletionRequests.confirmationCode, code))
        : [];
      const body = row
        ? `<h1>Data deleted</h1>
<p>Request <code>${esc(row.confirmationCode)}</code> was completed on ${row.createdAt.toISOString().slice(0, 10)}.
${row.contactsDeleted > 0 ? 'Your contact record, messages and conversation history were deleted.' : 'We held no data about you.'}</p>`
        : `<h1>Data deletion</h1>
<p>We couldn’t find that request. Check the confirmation code, or remove this app in your Instagram or Facebook settings (Apps and websites) to request deletion.</p>`;
      return reply
        .code(row || !code ? 200 : 404)
        .type('text/html; charset=utf-8')
        .send(page('Data deletion', `<div class="card">${body}</div>`));
    });

    /** Meta's data-deletion callback: verify the signature, erase the person, return a status link. */
    app.post('/api/meta/data-deletion', async (req, reply) => {
      const secrets = (await metaSecrets(db, config.appSecret, config.metaAppSecret)).map(
        (x) => x.secret,
      );
      if (secrets.length === 0) return reply.code(503).send({ error: 'meta_not_configured' });
      const signed = z
        .object({ signed_request: z.string().min(10).max(10_000) })
        .safeParse(req.body);
      const data = signed.success
        ? parseSignedRequestAny(signed.data.signed_request, secrets)
        : null;
      if (!data?.user_id) return reply.code(400).send({ error: 'invalid_signed_request' });
      const userId = String(data.user_id);

      const confirmationCode = randomBytes(9).toString('base64url');
      const deleted = await db.transaction(async (tx) => {
        const ids = await tx
          .select({ contactId: contactIdentities.contactId })
          .from(contactIdentities)
          .where(
            and(
              inArray(contactIdentities.channel, META_CHANNELS),
              eq(contactIdentities.externalId, userId),
            ),
          );
        const contactIds = [...new Set(ids.map((i) => i.contactId))];
        if (contactIds.length > 0)
          await tx.delete(contacts).where(inArray(contacts.id, contactIds));
        await tx.insert(deletionRequests).values({
          confirmationCode,
          channel: 'meta',
          externalId: sql`md5(${userId})`,
          contactsDeleted: contactIds.length,
        });
        return contactIds.length;
      });
      req.log.info({ deleted }, 'meta data-deletion request processed');
      return {
        url: `${config.publicUrl}/data-deletion?code=${confirmationCode}`,
        confirmation_code: confirmationCode,
      };
    });
  };

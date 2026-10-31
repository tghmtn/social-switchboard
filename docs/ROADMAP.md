# Social Switchboard — Plan & Roadmap

*Draft 0.3 · 2026-10-31 · License: AGPL-3.0*

## What we're building

A free, open-source, self-hosted platform that turns social engagement (a comment on a reel, a story reply, a DM) into an automated private conversation. The conversation answers questions, delivers a resource, captures contact info, and hands off to a human when needed.

- **One repo, one command.** `docker compose up -d` brings up everything. You don't need any outside service except the social channels themselves and, if you want it, an AI key.
- **Free, all of it.** No subscriptions, plan limits or paid tiers, and no "enterprise edition" folder. Every feature in the repo is free for anyone to use and deploy.
- **You own your data.** Postgres in a Docker volume, nightly backups, CSV export everywhere.

Source brainstorm: `~/Downloads/Platform Feature Summary.txt` (a feature survey of ManyChat-style tools).

---

## What already exists (checked 2026-10-31)

Several MIT-licensed open-source projects already cover parts of this. Each one shapes the plan differently.

| Project | License | What it is | How we'd use it |
|---|---|---|---|
| [ChatbotX](https://github.com/ChatbotXIO/ChatbotX) | MIT core + **commercial "enterprise" folder** | Almost the whole brainstorm, already built: visual flow builder (15+ node types), comment-to-DM, inbox, contacts/tags/fields, broadcasts, sequences, A/B, AI agents, webhooks/HTTP, Google Sheets, and Instagram/Messenger/WhatsApp/TikTok/Telegram/web chat/email. Run by a company (AhaChat LLC) that sells a cloud plan. **Team inbox, audit logs, platform admin and branding are paid.** Self-hosting runs about 10 containers (TimescaleDB, Redis, RustFS, builder, worker, realtime, JS sandbox…). 1.1k★, active daily since Dec 2024. | Either fork it, or borrow from its MIT parts (channel adapters, node types, integration code). **Never copy from `apps/builder/src/enterprise/`.** |
| [OpenReply](https://github.com/diwenne/openreply) | MIT | Instagram comment-to-DM done well: keyword campaigns, public reply, story/DM triggers, tracked links, follow gate, rate limiting, DM logs, simple inbox. Built with Next.js, Prisma, BullMQ and Redis. Mainly one maintainer; 3.5 months old with 2.9k★. Built for Vercel, with no full Docker bundle. | Reference implementation for the Instagram plumbing and Meta quirks. Its `META_APP_REVIEW.md` and setup docs are gold. |
| [React Flow / xyflow](https://github.com/xyflow/xyflow) | MIT | Node-graph canvas library | The flow builder canvas |
| [pg-boss](https://github.com/timgit/pg-boss) | MIT | Job queue built on Postgres alone (delays, retries, cron) | Engine timers and send queue, with no Redis needed |
| [grammY](https://github.com/grammyjs/grammY) | MIT | Telegram bot framework | Telegram channel (late) |
| [Chatwoot](https://github.com/chatwoot/chatwoot) | MIT core + enterprise folder | Omnichannel support inbox (Rails) | UX reference for the inbox only |

**Not bundleable** in a free open-source project. Their licenses restrict commercial use, so they aren't OSI open source: **n8n** (Sustainable Use License), **Typebot** (FSL), **Hexabot** (Fair Core License). People can still *connect* their own n8n or Activepieces instance through our webhooks and API.

## Decisions made (2026-10-31)

- **Name:** Social Switchboard (`social-switchboard`).
- **Build our own lean platform, borrowing heavily** from ChatbotX's MIT parts and from OpenReply. We're not forking or adopting either one. We get one clean license with nothing paid, a small stack (4 containers that fit a $6 VPS or a home server), a setup wizard aimed at non-developers, and an architecture that's ours.
- **License: AGPL-3.0.** Anyone can use, deploy and modify it for free. Anyone who hosts a *modified* version for other people must share their changes, so it can't be closed up into a subscription product.
- **Stack:** TypeScript end-to-end (see below).
- **Pilot:** the maintainer's own Instagram and their spouse's. Having two accounts is ideal: post on one and comment from the other.

## Borrowing rules

MIT code may be copied into this AGPL project, but its copyright notice has to come with it:

1. **Allowed sources:** ChatbotX (everything **outside** `apps/builder/src/enterprise/`) and OpenReply. Both are MIT.
2. **Every borrowed file** gets a header comment: `Adapted from <project> (MIT), <path>@<commit>`.
3. **Every project we borrow from** gets an entry in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) with its full MIT notice.
4. **Never copy from** ChatbotX's enterprise folder, Typebot (FSL), n8n (Sustainable Use License) or Hexabot (FCL). Those licenses forbid it. Ideas and UX are fine; code is not.
5. **Reference copies** live outside the repo at `~/Documents/oss-refs/` (shallow clones). We read them but never run them.

---

## Meta / Instagram access (good news for self-hosting)

- **For your own Instagram account(s):** create your own Meta developer app, keep it in development mode and add your account as a tester. That's enough to auto-DM *anyone* who comments, with **no App Review and no business verification.** This is per OpenReply's documented setup; we confirm it ourselves in Phase 0.
- **App Review and Business Verification** (which needs a registered legal business) are only needed when one install connects *other people's* accounts, e.g. an agency.
- So the open-source model is that **every deployer creates their own Meta app.** Our job is a setup wizard that makes that painless: it shows the exact callback URLs, the webhook verify token, the fields to subscribe and the permissions to add.
- Every install needs a **public HTTPS URL** for webhooks. We ship two options: a Cloudflare Tunnel (how this server already works) or Caddy with a domain.
- Rules the engine enforces in code, not just in docs:
  - one private reply per comment, within 7 days of the comment
  - a 24-hour window after the person's last message
  - Meta's cap of about 750 private replies per hour
  - no cold outreach
  - a "thread owner" conflict if another tool such as ManyChat is still connected to the account

---

## Guiding principles

1. **Channel-agnostic engine.** Flows describe intent. Channel adapters translate that intent and enforce each channel's rules.
2. **Rules are code.** The engine refuses to send outside a channel's window or without consent, and the UI shows why.
3. **Testable without Meta.** A built-in simulator runs any flow in the browser before any channel is connected.
4. **Light by default.** 4 containers. Optional extras sit behind Compose profiles.
5. **Borrow before building.** Each phase lists what we can lift (with attribution) from MIT projects.
6. **Every feature is free.** We don't hold anything back for a paid tier.

---

## Roadmap at a glance

| Phase | Delivers | Size |
|---|---|---|
| **0** | Repo skeleton + `docker compose up` + login + backups + Meta app created | S |
| **1** | Contacts, flow engine, visual builder, simulator: the heart of the product | L |
| **2** | Instagram live: comment → DM, DM keywords, story replies/mentions | M |
| **3** | Inbox & team (free, unlike ChatbotX) + Facebook Messenger | M |
| **4** | AI conversations | M |
| **5** | Integrations, email channel, public API | M |
| **6** | Broadcasts, sequences, analytics | M |
| **7** | More channels: web chat → TikTok → SMS → WhatsApp → Telegram | S each |
| **8** | Ship it: installer, upgrades, docs, v1.0 | M |

Each phase ends with something you can actually use.

---

### Phase 0: Foundations

**Goal:** a fresh clone + one command gives you a login page on `localhost:8110`.

- **Repo skeleton:**
  - pnpm monorepo
  - a single Dockerfile (one image runs both the app and the worker)
  - `docker-compose.yml` with `caddy`, `app`, `worker` and `postgres`
  - `.env.example`
  - `make up` / `make logs` / `make backup`
- **First-run setup:** create the owner account. Auth is email + password; magic links come later and are optional.
- `workspace_id` on every table from day one, so that multiple workspaces later is a switch to flip rather than a rewrite.
- Nightly `pg_dump` into a backups volume, plus a `/health` endpoint.
- **CI** on GitHub Actions: lint, typecheck and tests. No deploys.
- **Meta paperwork:** create your Meta app (dev mode), add your IG account as a tester, pick a tunnel hostname. The app serves its own privacy-policy page and data-deletion endpoint.
  - The account being automated must be an Instagram **professional** account (Creator or Business). Professional accounts are always public. Switching a personal account over is free and can be undone.

**Done when:** clone → `docker compose up -d` → log in → empty dashboard, and a backup file shows up.

### Phase 1: Contacts, engine, builder, simulator (the heart)

**Goal:** build a full lead-capture flow and run it end-to-end in the browser.

> **Status (2026-10-31): backend done, UI waiting on the design package.**
> - `packages/flow`: the schema, wiring validation, trigger matching, starter flows and a pure engine, covered by 31 tests.
> - Server: contacts, fields, tags, consent, the timeline and CSV export; flows with draft/publish versions; triggers; the simulator API.
> - Runtime: a per-contact lock, and an outbox so messages are never lost or sent twice. The worker fires delays and reply timeouts.
> - The WORKSHOP scenario passes end to end over the API, and in the Docker stack with a real worker-fired delay.
> - **Still to do:** the builder canvas, and the Contacts and Simulator screens. Simulator "test" versions also pile up and need pruning eventually.

- **Contacts:**
  - profile and per-channel identities
  - custom fields (text, number, date, email, phone, choice)
  - tags, notes, an activity timeline
  - consent records (channel, source, timestamp)
  - CSV export
- **Flow engine:**
  - a trigger leads into a graph of steps
  - run state is tracked per contact
  - durable delays (minutes to days, with quiet hours and day-of-week controls)
  - idempotent event handling and retries
  - a pure-function core with heavy unit tests
- **Steps:**
  - Message: text, image, file/PDF, link buttons, quick replies
  - Ask: validate email/phone/number/choice, save to a field, re-prompt if invalid
  - Condition: AND/OR over tags, fields, channel and time
  - Action: tag, set field, subscribe/unsubscribe, notify the team
  - Delay
  - Random split (weighted A/B)
  - Go to flow
  - Hand off to human
  - End
- **Triggers:** keyword (exact, contains or regex), default reply, welcome, ref-link entry. Comment triggers are wired up in Phase 2.
- **Builder:**
  - React Flow canvas with a side-panel step editor
  - validation that catches dangling branches and unreachable steps
  - draft/publish versions
  - 3–4 starter templates
- **Simulator:** a chat panel that runs any flow as a fake contact. It shows field and tag changes live and can fast-forward delays.
- **Channel adapter interface** (send, receive, capabilities, policy). The simulator is the first adapter.
- **Borrow from:** ChatbotX `packages/flow-config` and `packages/variables` (node types, variable model).

**Done when:** steps 2–7 of the WORKSHOP scenario run in the simulator, the lead lands in Contacts, and the CSV export works.

### Phase 2: Instagram live

**Goal:** someone comments "GUIDE" on a real post and the guide shows up in their DMs.

- **Connect IG** via Instagram Login OAuth. Tokens are encrypted at rest and refreshed automatically.
- **Webhook ingress:** verify the signature, acknowledge fast, queue the event, dedupe.
- **Triggers:**
  - comment keyword on a chosen post/reel (post picker with thumbnails) or on any post
  - optional public reply, with randomized variants
  - private reply that opens the DM
  - DM keyword
  - story reply and story mention
  - ig.me ref links
  - live comments (nice-to-have)
- **Outbound:** text, quick replies, buttons/cards, images, PDFs. Links go through a tracked redirect to measure clicks.
- **Follow gate** (optional): the link is only handed over after the person follows. It fails open, so a real follower never gets stuck.
- **Policy layer:** the windows, the one-reply-per-comment rule and per-account rate limits. A blocked send is logged with the reason.
- **Human takeover:** if you reply from the Instagram app, automation pauses for that contact. We detect this through message echoes.
- A read-only transcript per contact.
- **Borrow from:** OpenReply (Meta client, webhook handling, rate limiter, follow gate, setup docs) and ChatbotX `integrations/instagram`.

**Done when:** it works live on your own account with real commenters.

### Phase 3: Inbox & team

- **Unified realtime inbox:**
  - filters: open, assigned, unread, label, channel
  - labels, assign to a teammate, internal notes
  - saved replies
  - follow-up reminders ("snooze until…")
  - pause/resume the bot per conversation
- **Team members and roles** (owner, admin, agent), with unlimited seats. This is the part ChatbotX charges for.
- **Notifications:** browser push, optional ntfy, an email digest.
- **Mobile-friendly PWA** that installs to the iPhone home screen.
- **Facebook Messenger channel.** It shares the Meta app, webhooks and policy code with Instagram, so it's cheap at this point.

### Phase 4: AI conversations

- **AI step:**
  - goal
  - business context
  - knowledge (pasted text, PDFs, URLs)
  - tone and language
  - fields to collect
  - exit conditions (goal met, needs a human, max turns)
  - guardrails
- **AI intent router** as a condition ("what is this message asking for?") that branches the flow.
- AI-suggested replies in the inbox. "Describe your flow" produces a draft canvas.
- **Providers:** the Claude API by default, bring-your-own-key. A provider interface so a local model can be plugged in (Ollama; this box already runs open-webui).
- A usage/cost meter, and a log of each AI decision for review.

### Phase 5: Integrations, email, API

- **HTTP request step:** method, headers, a JSON body with field placeholders, and the response mapped back into fields.
- **Outbound webhooks** on events: new contact, tag added, field changed, flow completed. An **inbound webhook trigger** starts a flow from outside.
- **Google Sheets:** append, look up and update rows.
- **Email as a channel** over SMTP: deliver the guide, or follow up once the Instagram window has closed, with a working unsubscribe link.
- **Public REST API with API keys.** With that, n8n, Activepieces, Make and Zapier all work through webhooks and the API.
- CSV import of contacts.

### Phase 6: Broadcasts, sequences, analytics

- **Segments** (saved filters).
- **Broadcasts:**
  - an eligibility preview ("412 contacts match; 37 can be messaged on Instagram right now, 290 by email, here's why the rest can't")
  - scheduling and throttling
- **Sequences:** a drip over days across the channels you're allowed to use.
- **Analytics:**
  - per-flow funnel and drop-off
  - A/B results with sample sizes
  - click-through rate
  - leads captured per post
  - Instagram post insights merged with automation stats

### Phase 7: More channels, in this order

Each channel is a self-contained adapter.

1. **Web chat widget.** Embeds on a Ghost or any other website. No Meta dependency.
2. **TikTok.** Business messaging; eligibility and region limits apply, and it's unavailable in the EU and UK.
3. **SMS** via Twilio or similar. US A2P 10DLC registration is required.
4. **WhatsApp** via the Cloud API. Needs approved templates and has per-message charges; marketing templates to US numbers are paused.
5. **Telegram.** The easiest technically (no review) but the lowest business priority.

### Phase 8: Ship it (v1.0)

- Versioned images on GHCR and a one-line `install.sh`.
- `upgrade` takes an automatic backup, then runs migrations. A `restore` command to go with it.
- A setup wizard that walks through creating the Meta app step by step.
- Multiple workspaces (agencies running several clients), audit log, 2FA, encryption-key rotation.
- Docs site, contributor guide, `THIRD_PARTY_NOTICES` crediting borrowed MIT code.
- Telemetry: none, or strictly opt-in.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript end-to-end** | The flow schema is defined once and shared by the builder (browser) and the engine (server). Both reference projects are TypeScript, so their code ports directly. |
| Frontend | React + Vite, React Flow, Tailwind + shadcn/ui, TanStack Query | A standard, well-supported dashboard + canvas stack |
| Backend | Node 24 + Fastify, Zod | One process serves the API, the webhooks, websockets and the built UI |
| Database | Postgres 18 + Drizzle ORM | Typed schema, plain SQL migrations |
| Jobs & timers | pg-boss | Delays, retries and cron with **no Redis**. Fine for Instagram-scale volume, and Redis can be added later if ever needed. |
| Realtime | WebSockets + Postgres LISTEN/NOTIFY | No extra service |
| Files | Local Docker volume; S3-compatible storage optional later | |
| Proxy / TLS | Caddy (automatic HTTPS with a domain); optional `cloudflared` profile | Covers both "I have a domain" and "I'm behind home NAT" |
| AI | Anthropic SDK (Claude) behind a provider interface | Bring your own key; local models optional |
| Tests | Vitest (engine), Playwright (builder, inbox) | |

**Containers:** `caddy`, `app`, `worker` (same image as `app`), `postgres`. Optional profiles: `tunnel`, `ollama`, `minio`.
**Local port on this server:** 8110 (free; 8081–8099 are in use).

The alternative worth naming is Python/Django, which is familiar from OPSS. We'd lose the shared flow schema and the ability to port the reference projects' code directly, so I don't recommend it here.

### Repo layout

```
social-switchboard/
  apps/web/           React builder, inbox, settings
  apps/server/        Fastify API, webhooks, worker entrypoint, Drizzle schema + migrations
  packages/flow/      flow schema + engine, shared with the web app (Phase 1)
  packages/channels/  adapters: simulator, instagram, messenger, email, ... (Phase 1+)
  docker/             Dockerfile, Caddyfile
  docs/               ROADMAP.md, setup guides, decision records
  docker-compose.yml
  .env.example
  LICENSE
```

---

## Cross-cutting (every phase)

- **Consent & compliance:** opt-in records per channel, STOP/unsubscribe handling, per-contact data export and deletion (Meta requires a deletion callback).
- **Security:** webhook signature checks, encrypted channel tokens, CSRF protection, rate limits, no secrets in logs.
- **Observability:** structured logs, a "why didn't this send?" log visible in the UI, health checks.

---

## Open decisions

1. **Which account is automated first** in Phase 2, and is it already a Creator/Business account? The other account plays the commenter.

## Reference scenario: WORKSHOP

From the brainstorm. Used as the acceptance test from Phase 1 on.

1. A reel invites viewers to comment "WORKSHOP".
2. Send an automatic private reply inviting them to continue.
3. When they engage, ask which topic interests them.
4. Save the answer and tag the contact.
5. Offer a worksheet and ask for their email, explaining how it will be used.
6. Deliver the worksheet plus the workshop registration link.
7. Save the lead to a sheet (or webhook).
8. A person takes over for complex questions.
9. Any follow-up goes only through a permitted channel.
10. Compare engagement, leads and registrations.

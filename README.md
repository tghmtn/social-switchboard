# Social Switchboard

A free, open-source, self-hosted platform that turns social engagement into conversations. When someone comments a keyword, replies to a story or sends a DM, it starts an automated private conversation that answers questions, delivers a resource, captures contact info and hands off to a human when needed.

- One repo, one command: `docker compose up -d`
- Every feature is free: no subscriptions, plan limits or paid tiers
- Your data stays on your server

**Status:** Phase 0 (foundations). See [docs/ROADMAP.md](docs/ROADMAP.md).

## Run it

You need Docker with the Compose plugin.

```bash
git clone <this repo> social-switchboard
cd social-switchboard
./scripts/init-env.sh        # writes .env with random secrets (once)
docker compose up -d --build
```

Open <http://localhost:8110>. The first visit asks you to create the owner account.

| Command | What it does |
|---|---|
| `make up` | Build and start everything |
| `make logs` | Follow app and worker logs |
| `make backup` | Take a database backup now (saved in the `backups` volume) |
| `make down` | Stop (data is kept) |

Backups run nightly at 03:30 (container time zone, `TZ` in `.env`). The last 14 are kept.

### Serving it on a real domain

- **Your own domain, ports 80/443 open:** set `SITE_ADDRESS=your.domain` in `.env` and publish ports 80 and 443 for the `caddy` service. Caddy gets the HTTPS certificate automatically.
- **Behind home NAT:** create a Cloudflare Tunnel that points to `http://caddy:80`. Put its token in `TUNNEL_TOKEN` and run `docker compose --profile tunnel up -d`.

## Develop

```bash
pnpm install
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres   # Postgres on 127.0.0.1:55432
pnpm dev                      # API on :3000, web on :5173 with hot reload
pnpm check                    # typecheck + lint + tests
```

On a development machine, add `COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml` to `.env` so plain `docker compose` commands keep the Postgres port mapped.

The API tests run against a real database. Create it once, then point `TEST_DATABASE_URL` at it:

```bash
docker compose exec postgres psql -U switchboard -c 'create database switchboard_test'
TEST_DATABASE_URL=postgres://switchboard:<POSTGRES_PASSWORD>@127.0.0.1:55432/switchboard_test pnpm check
```

Without `TEST_DATABASE_URL` the API tests are skipped. CI always runs them.

## License

[AGPL-3.0](LICENSE). Borrowed MIT code is credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

#!/usr/bin/env sh
# Writes .env with random secrets. Safe to re-run: it never overwrites an existing .env.
set -eu
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env already exists; leaving it alone."
  exit 0
fi

rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
tz=$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo UTC)

sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand 32)|" \
    -e "s|^APP_SECRET=.*|APP_SECRET=$(rand 48)|" \
    -e "s|^TZ=.*|TZ=${tz}|" \
    .env.example > .env
chmod 600 .env
echo "Wrote .env (time zone: ${tz})."

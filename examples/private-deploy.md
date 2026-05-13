# Private deployment

Releases are automated end-to-end. The flow is documented in
[`../RELEASING.md`](../RELEASING.md): conventional-commit a change, push,
merge the release PR, GitHub Actions publishes to GitHub Packages. This
file covers the **server-side** half — what you set up on the VPS to
install and run those releases.

## Prerequisites on the server

```bash
# Node 22+ (or 20 LTS)
node --version

# pnpm via Corepack
corepack enable

# An LLM endpoint reachable from the server (Ollama on the same host,
# OpenAI proper, LM Studio, etc.)

# A dedicated runtime user
sudo useradd -r -m -d /home/rembric -s /bin/bash rembric
sudo install -d -m 700 -o rembric -g rembric /etc/rembric
```

## Auth: a read-only token for GitHub Packages

The published package lives behind your GitHub account. Create a classic
Personal Access Token with **only `read:packages`** at
<https://github.com/settings/tokens/new>, then:

```bash
sudo -u rembric tee /home/rembric/.npmrc <<EOF
//npm.pkg.github.com/:_authToken=ghp_YOUR_READ_PACKAGES_TOKEN
@your-github-username:registry=https://npm.pkg.github.com
EOF
sudo chmod 600 /home/rembric/.npmrc
```

## Environment

`/etc/rembric/rembric.env`:

```bash
REMBRIC_HOST=127.0.0.1
REMBRIC_PORT=8787
REMBRIC_ADMIN_TOKEN=...                               # openssl rand -hex 32
LLM_PROVIDER=openai
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
OPENAI_MODEL=qwen2.5:7b-instruct-q4_K_M
OPENAI_EMBEDDING_MODEL=nomic-embed-text:latest
CONSOLIDATION_ENABLED=true
```

## systemd

Copy [`systemd/rembric.service`](./systemd/rembric.service) to
`/etc/systemd/system/`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable rembric
```

Don't start it yet — install the package first.

## Install + first start

```bash
sudo -u rembric pnpm add -g @your-github-username/rembric@latest
sudo systemctl start rembric
sudo systemctl status rembric
```

`rembric` is now on the user's `$PATH`; the systemd unit launches it
with the env file above.

## Iteration

After each release (see [`../RELEASING.md`](../RELEASING.md) for cutting
one), pull the new version on the server:

```bash
ssh server 'sudo -u rembric pnpm add -g @your-github-username/rembric@latest && \
            sudo systemctl restart rembric'
```

Migrations apply automatically; no manual DB steps.

## Putting a domain in front

Both options bind to `127.0.0.1:8787` by default. Add your TLS-terminating
proxy from one of the sibling files:

- [`caddy/Caddyfile`](./caddy/Caddyfile) — Caddy with automatic Let's Encrypt
- [`nginx/rembric.conf`](./nginx/rembric.conf) — Nginx + Certbot
- [`traefik/labels.yml`](./traefik/labels.yml) — Traefik via docker-compose
- [`cloudflare-tunnel/config.yml`](./cloudflare-tunnel/config.yml) — `cloudflared`

After the proxy is up, mint a token for your agent:

```bash
sudo -u rembric REMBRIC_DATA_DIR=/home/rembric/.rembric \
  rembric token create my-laptop --scope '*'
# (prints the plaintext token exactly once — copy it now)
```

Point your agents at `https://your.domain/mcp` or
`https://your.domain/mcp/<project-slug>`.

## Backups

```bash
# nightly snapshot
0 4 * * * sudo -u rembric sqlite3 /home/rembric/.rembric/data.db \
  ".backup /var/backups/rembric-$(date +\%F).db"
```

For continuous off-host backups, run `litestream` streaming the DB to
S3/R2.

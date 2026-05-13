# Rembric: operational recipes

These files are reference templates. Copy and adapt to your environment.

To deploy Rembric privately on a self-hosted server (without making the
repo public), the workflow is fully automated:

- [`../RELEASING.md`](../RELEASING.md) — how releases are cut from
  conventional-commit history (release-please + GitHub Packages).
- [`private-deploy.md`](./private-deploy.md) — what you set up on the
  server to install the published private package and restart it on each
  new version.

For ad-hoc dev installs from a published package:

```bash
pnpm add -g rembric        # or: npm i -g rembric
```

## Process supervisors

- [`systemd/rembric.service`](./systemd/rembric.service) — Linux, systemd.
- [`pm2/ecosystem.config.cjs`](./pm2/ecosystem.config.cjs) — cross-platform, pm2.
- [`launchd/com.rembric.plist`](./launchd/com.rembric.plist) — macOS.

## Reverse proxies

- [`caddy/Caddyfile`](./caddy/Caddyfile) — Caddy with automatic Let's Encrypt.
- [`nginx/rembric.conf`](./nginx/rembric.conf) — Nginx server block.
- [`traefik/labels.yml`](./traefik/labels.yml) — Traefik via docker-compose labels.
- [`cloudflare-tunnel/config.yml`](./cloudflare-tunnel/config.yml) — `cloudflared` tunnel.

The server binds to `127.0.0.1:8787` by default. Bring your own TLS-terminating
proxy in front; the server's bearer-token auth is enforced regardless.

## ADDED Requirements

### Requirement: bring-up MUST verify application health before reporting success

After `docker compose up -d` succeeds, the installer SHALL poll the authenticated `/healthz` endpoint on `127.0.0.1:<configured-port>` using the admin token it holds, with a bounded per-attempt timeout and a bounded total ceiling (≈30 s, sized for first-boot embedding-model load). The installer SHALL print the success banner (dashboard URL, token echo) ONLY after `/healthz` returns `{ok:true}`; on ceiling expiry it SHALL print a failure diagnostic pointing at `docker compose logs` and SHALL NOT claim the stack is up. The poll loop SHALL be POSIX-sh and `set -e`-safe.

#### Scenario: Container starts but the app crashes on boot

- **WHEN** `docker compose up -d` exits 0 but the server process crashes before binding (e.g. invalid `.env` or failed migration)
- **THEN** the installer SHALL report bring-up failure with a `docker compose logs` hint and SHALL NOT print the dashboard URL/success banner

#### Scenario: Healthy bring-up reports the server version

- **WHEN** `/healthz` responds `{ok:true,version:<v>}` within the ceiling
- **THEN** the installer SHALL print the success banner including `<v>`

### Requirement: Installer network fetches MUST be time-bounded and retried

The artifact `fetch()` helper in `apps/plugin/install.sh` and the root shim's script download SHALL use bounded curl options (`--max-time` and `--retry` with connection-refused retries). No installer network call SHALL be able to hang indefinitely.

#### Scenario: Stalled raw.githubusercontent connection

- **WHEN** an artifact download stalls
- **THEN** curl SHALL abort at the configured `--max-time`, retry up to the configured count, and on final failure the installer SHALL surface its existing fetch-error path instead of hanging

### Requirement: `--port` MUST be validated at argument parse time

The installer SHALL reject a non-numeric or out-of-range (`<1`, `>65535`) `--port` value with a clear error at parse time, before writing anything to `.env`.

#### Scenario: Alphabetic port value

- **WHEN** the installer is invoked with `--port=abc`
- **THEN** it SHALL exit with an error naming the invalid value and SHALL NOT modify `.env`

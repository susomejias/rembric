## MODIFIED Requirements

### Requirement: Server flow prepares files, generates the token, and optionally brings the stack up

The installer's server install option SHALL download `docker-compose.yml` and `.env.example` from the install ref into the current directory and write a `.env` derived from `.env.example` with `REMBRIC_ADMIN_TOKEN` set. The token SHALL be either a value the user pastes or, when none is given, one the installer auto-generates (`openssl rand -hex 32`, falling back to an `od`/`/dev/urandom` hex string when `openssl` is absent). An existing `.env` whose `REMBRIC_ADMIN_TOKEN` is non-empty SHALL be left untouched; an existing `.env` whose token is **empty** (e.g. left half-written by an interrupted earlier run) SHALL be treated like a fresh one and have the token filled in, so the installer is safely re-runnable and never proceeds with an empty token. The effective admin token SHALL be displayed to the user in every case — generated, pasted, or read back from `.env` — since it is required to log into the dashboard; on a successful bring-up it SHALL also be echoed alongside the dashboard URL. `REMBRIC_ADMIN_TOKEN` is the only required variable; the installer SHALL NOT prompt for any other env value. The installer SHALL then bring the stack up ONLY when `docker` is on `PATH` AND the user has confirmed (an interactive `[y/N]` prompt, or the `--up` flag under non-interactive mode); the bring-up SHALL run `docker compose pull` first on a best-effort basis (so a stale local `:latest` tag cannot shadow the published image; silently skipped when offline); immediately before running `docker compose up -d` it SHALL ensure `./data` (the bind-mount source for the container's `/data`) exists and is accessible to the container's non-root `UID 10001`, so a rootful Linux Docker host that would otherwise auto-create `./data` as `root:root` does not leave the server unable to open its SQLite DB: `mkdir -p ./data`, then attempt `chown 10001:10001 ./data`; ONLY when that `chown` fails (no root/`CAP_CHOWN`) SHALL it fall back to `chmod 0777 ./data`, and in that case it SHALL print an explicit warning naming the fallback and the command to tighten it later (`sudo chown -R 10001:10001 ./data`) — the fallback SHALL NOT be applied silently. It SHALL then run `docker compose up -d`. On success it SHALL print the dashboard URL. When Docker is absent or the user declines, the installer SHALL instead print the exact `docker compose pull && docker compose up -d` command and SHALL NOT execute any `docker` command, and SHALL NOT create or modify `./data`. The installer SHALL NOT require Docker to be installed. The server update option SHALL re-fetch `docker-compose.yml` and offer the SAME gated bring-up (`docker compose pull && docker compose up -d`, gated on `docker compose` availability and confirmation/`--up`, including the same `./data` preparation step); when the current directory has no `./.env` the update SHALL NOT bring the server up and SHALL direct the user to run install first.

#### Scenario: Server install auto-generates the token when none is pasted

- **WHEN** the user selects server install and provides no token
- **THEN** the installer SHALL write `.env` with an auto-generated `REMBRIC_ADMIN_TOKEN` and display the generated value

#### Scenario: Existing configured .env shows the current token without changing it

- **WHEN** server install runs in a directory whose `.env` already has a non-empty `REMBRIC_ADMIN_TOKEN`
- **THEN** the installer SHALL leave `.env` untouched and display the token read from it

#### Scenario: Interrupted run left an empty token — re-run fills it

- **WHEN** server install runs in a directory whose `.env` exists but `REMBRIC_ADMIN_TOKEN` is empty
- **THEN** the installer SHALL set the token (paste or auto-generate), write it into `.env`, and display it
- **AND** it SHALL NOT proceed to bring the server up with an empty token

#### Scenario: Optional bring-up gated on Docker presence and confirmation

- **WHEN** server install runs, `docker compose` is available, and the user confirms the bring-up prompt (or passes `--up`)
- **THEN** the installer SHALL run `docker compose pull && docker compose up -d` and print the dashboard URL
- **AND** when the user declines OR `docker compose` is unavailable, the installer SHALL print the command and SHALL NOT execute any `docker` command

#### Scenario: Update offers the same bring-up as install

- **WHEN** server update runs in a directory that has a `./.env`, `docker compose` is available, and the user confirms (or passes `--up`)
- **THEN** the installer SHALL re-fetch `docker-compose.yml` and run `docker compose pull && docker compose up -d`
- **AND** when the directory has no `./.env`, update SHALL NOT bring the server up and SHALL direct the user to run install first

#### Scenario: Server flow does not require Docker present

- **WHEN** the installer runs the server option on a host where `docker` is not on `PATH`
- **THEN** the file-preparation and token-generation steps SHALL still complete successfully
- **AND** the printed next-step command SHALL be the only reference to Docker

#### Scenario: Non-interactive server install does not silently start Docker

- **WHEN** the installer runs `REMBRIC_NONINTERACTIVE=1 … --server --action=install` without `--up`
- **THEN** it SHALL prepare files and generate the token but SHALL NOT execute `docker compose up`

#### Scenario: Bring-up prepares an accessible data directory before starting containers, preferring chown over chmod

- **WHEN** a bring-up actually runs `docker compose up -d` (install or update, with `docker compose` available and confirmed/`--up`) and `chown 10001:10001 ./data` succeeds
- **THEN** the installer SHALL create `./data` if missing, chown it, and proceed to `docker compose up -d` WITHOUT relaxing its permissions and WITHOUT printing any fallback warning
- **AND** this preparation SHALL run on every such bring-up (install or update), not only when `./data` is freshly created — so a directory left root-owned by a pre-fix crash loop is healed on a re-run

#### Scenario: Bring-up falls back to a world-writable data directory only when chown is not possible, and warns explicitly

- **WHEN** a bring-up actually runs `docker compose up -d` and `chown 10001:10001 ./data` fails (no root/`CAP_CHOWN`)
- **THEN** the installer SHALL `chmod 0777 ./data` before invoking `docker compose up -d`
- **AND** it SHALL print a warning identifying the fallback and a `sudo chown -R 10001:10001 ./data` hint to tighten it later
- **AND** it SHALL NOT apply this relaxed permission silently (the warning is never suppressed)

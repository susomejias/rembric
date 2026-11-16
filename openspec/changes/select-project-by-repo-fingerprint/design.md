## Context

Project selection today is a per-directory file read. The bridge, the hook helper, the opencode and Pi in-process code and the Hermes provider each look for `.rembric` in exactly one directory and fall back to `REMBRIC_PROJECT_SLUG`. When neither resolves, the bridge connects path-less and the server serves the default project; the only signal is a stderr line (`apps/plugin/mcp-bridge/bridge.mjs:84`) that no host shows by default.

Three properties of the system decide the design:

- **Append-only memory.** `memory` rows and `sessions.project_id` are never rewritten and no verb reassigns a row to another project. Any wrong project choice is permanent, so the design ranks failure modes by visibility and reversibility: a visible refusal is acceptable, a silent wrong project is not.
- **Path-scoped, stateless MCP.** After `collapse-mcp-onto-stateless-sdk-v2` the server keeps no per-connection state: a request's project is its URL slug or, path-less, the default project. No tool switches a connection's project.
- **Tokens with project reach.** Tokens are pinned to a project, to a membership set, read-only, or admin (`*`). Admin authority is the literal `*` scope and is never derived from breadth.

## Goals / Non-Goals

**Goals:**

- A checkout of a repository resolves to the right project in any directory of it, on any machine and in any worktree, with no per-checkout file.
- Inside a git repository, a session never writes to a project nobody chose.
- One decision per repository, made by an admin, shared by the whole team.
- No new state an operator has to maintain by hand (no URL lists).

**Non-Goals:**

- Choosing a project for directories outside git. They keep today's behaviour.
- Moving rows written before the upgrade. Nothing is moved.
- Detecting a project from names, remotes or manifests.
- Server-side scheduled jobs. Expiry is evaluated on read and write.

## Decisions

### D1. Identity is the first-parent root commit, not a URL or a name

The fingerprint is `git rev-list --first-parent --max-parents=0 HEAD`.

- **Alternative: the remote URL, mapped to a project by the operator.** Rejected by the owner: every rename, transfer or new remote is a mapping to update by hand. It also fails for repositories with no remote.
- **Alternative: the repository or directory name.** Rejected: `acme/api` and `other/api` collide, directory names differ per worktree (`<repo>`, `<repo>-worktrees/<branch>`), and a collision files one project's memory into another permanently.
- **Alternative: every root commit, matching on any.** Rejected: a library merged with its history would make two unrelated repositories share a root. Matching on all roots instead changes the identity each time a history is merged in.

The root commit is the same in every full clone and worktree, survives renames and remote changes, and needs no remote. Its known failure — two projects started from one boilerplate history share a root — is covered by D5.

### D2. The client resolves once per session; the server never selects a project from the header

The client calls `POST /api/repositories/resolve` at session start and then connects at `/mcp/<slug>` exactly as today.

- **Alternative: the server resolves the header on every request.** No resolve endpoint and changes take effect immediately, but a binding moved mid-session would split one session across two projects — its registered session in one, its later memories in the other — which append-only memory cannot repair. It also needs new hook routes keyed by fingerprint instead of slug, a lookup per request, and a rewrite of the path-scoping contract for every session rather than only unbound ones.

Resolving once keeps every row of a session in one project, keeps `/mcp/<slug>` and `/api/<slug>/…` unchanged for bound sessions, and narrows the contract change to two declared exceptions: path-less requests carrying the header are unbound, and the bind tool names another project without switching the connection. The header still travels on path-scoped requests, but only to inform `project.current` and the bind tool.

### D3. Bindings are unique per (fingerprint, project) and resolved within the token's reach

- **Alternative: one binding per fingerprint across the server, first binder wins.** Simpler, but any writer could bind someone else's repository first, blocking the real owner — who, under D4, could not even be told why — and silently diverting anyone with access to the squatted project. Acceptable only on a single-user server.

Per-pair uniqueness means nobody can block anybody. A token that sees two bindings gets `repository_ambiguous` and resolves it with an explicit selection. An invisible binding answers exactly like none, so resolution reveals nothing about other tokens' repositories.

### D4. Only admin tokens bind; moving and removing is dashboard-only

The owner chose admin-only binding for both the MCP tool and the dashboard.

- **Alternative: any token with write on the target project may bind.** It grants nothing a writer does not already have, but in a shared project one member could decide for the others where an unbound repository goes.

Consequences accepted: the MCP tool helps only in sessions run with the admin token, so the dashboard is the primary path; `.rembric` auto-learning becomes a pending suggestion an admin accepts (D6); teammates are unaffected because resolving a bound repository needs only read authority. The tool binds only fingerprints with no binding at all: an agent holding an admin token and steered by injected text can at worst bind a new repository to a wrong project, which an admin removes before memory accumulates; it can never redirect a repository already in use.

### D5. An unknown remote on a bound fingerprint goes to pending, flagged

When none of the sent remotes is known to the only visible binding, the server answers `unbound` (`unknown_remote`) and records a flagged pending row for an admin.

- **Alternative: accept automatically when the token can access the bound project.** Teammates are never blocked, but the second boilerplate-derived project lands in the first one's memory without warning.
- **Alternative: drop the remote check.** Same risk for everyone.

Cost accepted: a fork without its upstream as a remote, or a renamed repository whose local remote was updated, has no memory until an admin accepts it.

### D6. Explicit selection wins, with a conflict report; only a root `.rembric` becomes a suggestion

A `.rembric` or `REMBRIC_PROJECT_SLUG` beats a binding, as `.rembric` beats `REMBRIC_PROJECT_SLUG` today. It is the escape hatch for monorepos and the way out of an ambiguity, and it grants nothing new: the selected slug is still authorized by the token. The conflict is reported where each party looks: session-start text (the agent), `project.current` (on demand), the dashboard (the admin, for root `.rembric` only).

- **Alternative: the binding wins.** Breaks monorepos with several projects and removes the ambiguity escape.
- **Alternative: refuse on mismatch.** Strictest, but blocks work on every legitimate override.

Only a `.rembric` at the checkout root is reported as a suggestion: nested files are monorepo subprojects, and learning them would bind the whole repository to one subproject. `REMBRIC_PROJECT_SLUG` is a per-client default, not a statement about the repository, so it records nothing.

### D7. Unbound mode instead of the default project

Inside git with no project, the client connects path-less with the header; the server refuses every scope-resolving tool with `project_unbound` and keeps `project.list`, `project.current` and `project.bind_repository` reachable, so an admin session can bind from inside the agent.

- **Alternative: keep the default-project fallback.** It is the defect this change exists to remove.
- **Alternative: disable the plugin entirely.** Safest, but leaves no in-agent path to bind.

### D8. No fallback when the server's support is not proven

A path-less request with the header is safe only on a server that understands the header; an older server serves the default project. The client therefore connects path-less only after the resolve endpoint answered `unbound`. Any other answer, including a timeout, means no connection inside git without an explicit selection. Explicit selections work against any server, and releasing the server before the plugin makes the case transient.

### D9. Pending rows are deduplicated, bounded and minimal

They are the only write an unbound session causes. Deduplication per `(fingerprint, kind, project)` keeps one request per repository however many teammates sight it; discards are remembered so a discarded repository does not come back; the per-token cap (20) and the unseen expiry (14 days) bound what any token can add. Rows store credential-stripped remotes and, only without a remote, the checkout root's basename — never a local path, which would expose user names and directory layout.

### D10. One shared JavaScript resolver; bash and Python keep their own

The cascade lives once in `apps/plugin/mcp-bridge/rembric-project.mjs`, inside the zero-dependency bridge package, and the opencode plugin and Pi extension import it, mirroring how `rembric-dotenv.mjs` is shared today. `_api.sh` and the Hermes provider implement the same cascade in their own language, as they do for dotenv parsing, and are held to it by tests that run the same fixtures through every implementation.

## Evidence

Measured in this session; each probe used throwaway repositories created in a scratch directory and deleted afterwards.

- **Two-root repository.** A repository whose own root commit is `A`, with an unrelated library history (root `L`) merged in with `git merge --allow-unrelated-histories`: `git rev-list --max-parents=0 HEAD` printed both roots; `git rev-list --first-parent --max-parents=0` printed `A` from the default branch and from a feature branch created after the merge.
- **Merge direction.** A clone of the library that merged the application history into itself returned the application root, not the library root, as its first-parent root. Which root a first-parent walk reaches depends on which side merged into which.
- **Orphan branch.** After `git checkout --orphan` and a commit, the first-parent root was the orphan's own commit.
- **Repository with no commits.** `git rev-parse --is-inside-work-tree` printed `true` and `git rev-list --max-parents=0 HEAD` failed with exit code 128 (`ambiguous argument 'HEAD'`).
- **Shallow clone.** `git clone --depth 1`: `git rev-parse --is-shallow-repository` printed `true`, and the first-parent root lookup returned the boundary commit (the clone's only commit) rather than the true root, with exit code 0. The shallow check is therefore mandatory; the lookup alone gives a wrong answer silently.
- **Cost.** `git rev-list --max-parents=0 HEAD` in this repository (1181 commits) reported `real 0.00` under `/usr/bin/time -p` in three consecutive runs. Not measured on large repositories.
- **Current fallback.** Read from source: with no slug, `apps/plugin/mcp-bridge/bridge.mjs:84` writes a stderr line and builds the path-less endpoint, which the server resolves to the default project.

## Assumptions

- **A1.** `REMBRIC_PROJECT_SLUG` keeps its place behind `.rembric` and sits before the fingerprint step, as the agreed cascade lists it. See Open Question Q7.
- **A2.** A read-only token creates no pending row of any kind. The owner decided that binding and `.rembric` learning are writes; extending that to unbound sightings is this design's reading.
- **A3.** The resolve request's bounds (at most 8 remotes, 512 characters each, root name at most 255) and the header grammar (exactly one value) are this design's choice; the owner asked only that both be strictly bounded.
- **A4.** Removing a binding uses `ConfirmSubmit` with `tone="warn"` because it is reversible by binding again.
- **A5.** A pending row's tokens are shown by token name, the same identity the tokens page shows.

## Risks / Trade-offs

- [Risk] An agent with an admin token, steered by injected text, binds a new repository to the wrong project → Mitigation: the tool binds only unbound fingerprints, applies from the next session, and the binding is visible with its creator in the dashboard, where it is removed before memory accumulates.
- [Risk] Bridge and hooks resolve independently and disagree within one Claude Code or Codex session (for example, a binding accepted between the two) → Mitigation: each caches its first outcome for the session; the agreement check itself is open (Q1).
- [Risk] A server released after the plugin leaves git checkouts without explicit selection disconnected → Mitigation: server first (task order), and the diagnostic names the server update and `.rembric`.
- [Risk] A rewritten root history (filter-repo, a new root) changes the fingerprint → Mitigation: the checkout becomes unbound and pending, visibly; an admin binds the new fingerprint.
- [Trade-off] A committed `.rembric` lets anyone who can commit decide, for everyone who clones, which project sessions use, over the admin's binding → Accepted because it reaches only projects each token can already use, and the conflict is reported to the agent and, for root files, to the admin.
- [Trade-off] Checkouts that relied on the silent default project lose memory until bound → Accepted because the failure is visible and one click (binding to the default project) restores continuity.
- [Trade-off] Pending rows tell an admin which repositories other tokens work in → Accepted for the team-scale servers this targets; only normalized remotes or a basename are stored.
- [Trade-off] Shallow clones and repositories with no commit need a `.rembric` → Accepted because the alternative is a wrong identity.

## Migration Plan

1. Archive `collapse-mcp-onto-stateless-sdk-v2`.
2. Release the server: migration (additive tables only), resolve endpoint, header validation, unbound mode, bind tool, dashboard. Old plugins keep working: they send no header and behave as today.
3. Release the plugin with all five clients. From the first session after upgrading, unbound checkouts appear as pending.
4. Admins accept pending rows; root `.rembric` files become suggestions to accept with one click.

Rollback: revert the plugin release first (clients stop sending the header and fall back as before), then the server. The new tables can stay; nothing else reads them.

## Open Questions

- **Q1.** How the bridge and the hooks confirm they resolved the same project within one session. They do not communicate today, and the check must fit Codex's hook budget.
- **Q2.** The resolve endpoint's latency against Codex's 1-second hook budget. Not measured: the endpoint does not exist yet.
- **Q3.** Where each of the five clients shows the unbound and conflict messages to the user. In Claude Code, session-start output reaches the model and not necessarily the screen; the other clients are unverified.
- **Q4.** Submodules: a session inside a submodule sees the submodule's own repository and fingerprint. Whether that is the desired project is undecided.
- **Q5.** Rewritten root history beyond the mitigation above: whether the dashboard should offer to carry a binding over to a new fingerprint.
- **Q6.** The merge-direction caveat: a history that fast-forwards onto, or merges into, another repository's history reaches the other root. The probes show it is reachable; how often it happens is unknown.
- **Q7.** A globally set `REMBRIC_PROJECT_SLUG` (for example a Hermes profile default) pre-empts the fingerprint in every repository under A1. Whether the default should move below the fingerprint step needs the owner's decision.

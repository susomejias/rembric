# @rembric/server

Single Node process, single SQLite file. MCP server + HTTP API + operator dashboard for Rembric persistent memory. See the repo root [`CLAUDE.md`](../../CLAUDE.md) for architecture and the load-bearing invariants.

## Releases

This package is released independently via [release-please](https://github.com/googleapis/release-please) (tag prefix `server-v*`), driven by Conventional Commit messages on `main`.

**Always merge PRs with "Create a merge commit"**, never "Squash and merge" — a squashed commit's message defaults to the PR title, which release-please cannot parse as a Conventional Commit. A squash merge silently yields zero release commits until a new, real Conventional Commit lands on top of it.

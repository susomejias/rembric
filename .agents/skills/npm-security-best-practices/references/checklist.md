# npm-security checklist (one-page scan)

Use this during code review of any PR that adds a dependency, edits install configuration, or touches a lockfile.

| #   | Practice                       | You need this if…                                             | Skip if…                                      |
| --- | ------------------------------ | ------------------------------------------------------------- | --------------------------------------------- |
| 1   | Disable post-install scripts   | You install any npm/pnpm/yarn dep on developer workstations   | (always applies)                              |
| 2   | Block git-based / exotic deps  | Your dep graph contains anything beyond direct deps you wrote | (always applies)                              |
| 3   | Install cooldown               | You install deps in CI without 100% manual review every time  | You hand-review every install (rare)          |
| 4.1 | `npq` for manual installs      | You add new deps periodically and want a one-step vet         | You never add deps; not worth the global tool |
| 4.2 | Socket Firewall (`sfw`)        | You're an org with budget for active threat intel             | Solo project; redundant with #1, #2, #3, #5   |
| 5   | `lockfile-lint` in CI          | You accept PRs that touch the lockfile                        | You're the only committer AND review lockfile |
| 6   | Deterministic installs         | You install in CI or any reproducible build                   | (always applies)                              |
| 7   | No blind `npm update`          | You have any process that auto-bumps deps                     | You only bump manually one at a time          |
| 8   | Hardened `npx`                 | You invoke `npx <pkg>` in scripts, hooks, or CI               | Your scripts don't use `npx`                  |
| 9   | No plaintext secrets in `.env` | `.env` contains production credentials                        | `.env` only has dev-local tokens              |
| 10  | Dev containers                 | You install untrusted deps on a workstation with credentials  | Your dev is already isolated (e.g., a VM)     |
| 11  | 2FA on npm account             | You publish to npm                                            | You don't publish to npm                      |
| 12  | Provenance attestations        | You publish to npm AND have CI that supports OIDC             | You don't publish to npm                      |
| 13  | OIDC trusted publishing        | You publish to npm AND use GitHub/GitLab/CircleCI             | You don't publish to npm                      |
| 14  | Reduce dependency tree         | (always applies when adding a new dep)                        | (rarely skip; revisit during dep additions)   |
| 15  | Consult Snyk DB                | (always applies when adopting a new dep)                      | The dep is from your own org                  |
| 16  | Don't trust npmjs.org metadata | (always applies for new adoptions)                            | You're using a vetted internal mirror only    |
| 17  | Prevent dependency confusion   | You publish ANY internal scoped package                       | You publish nothing internal                  |

## Code-review prompts

When reviewing a PR that adds a dep:

1. **Did `lockfile-lint` pass?** (check CI output — practice #5)
2. **Is the dep needed?** Can a native runtime feature replace it? (practice #14)
3. **What does Snyk say?** Open vulnerabilities, maintenance status, popularity (practice #15)
4. **Does `package.json` declare a `postinstall` for it?** If yes, does it deserve being in the allowlist? (practice #1)
5. **Did `npm pack` show anything surprising in the tarball?** (practice #16)
6. **Is the version > 3 days old?** (practice #3 enforces, but be aware of any escape-hatch override)

If you can answer all six honestly, the PR is ready to merge.

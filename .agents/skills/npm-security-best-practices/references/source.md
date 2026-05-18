# Upstream source

This skill is adapted from:

**Repository**: [lirantal/npm-security-best-practices](https://github.com/lirantal/npm-security-best-practices)
**Read against commit**: `82059e4ee5572d1702f112ccd3fcd51d5dccc050`
**Commit date**: `2026-05-17`
**Skill snapshot date**: `2026-05-18`

## Reminder

Re-read upstream at least quarterly. Compare against the SHA above; if upstream has new practices or substantially revised existing ones, propose an update:

```bash
gh api repos/lirantal/npm-security-best-practices/commits/main --jq '.sha, .commit.committer.date'
```

If the SHA differs from `82059e4ee5572d1702f112ccd3fcd51d5dccc050`:

1. Read the upstream `README.md` against the new SHA.
2. Diff the 17-practice list against this skill.
3. For each new or changed practice, decide: enforce in the consuming repo OR document in skill OR N/A.
4. Update `SKILL.md` body + `references/checklist.md` + this file's SHA pointer.

## Practices NOT covered here

The upstream repo may grow new sections. As of the snapshot above, this skill mirrors the 17 numbered practices (#1–#17). Anything upstream adds after that point requires a refresh per the reminder above.

## Editorial notes

The skill body re-orders some upstream guidance for adoption priority (the "Adoption priority" closer in `SKILL.md`). Numbering matches upstream exactly. If you contribute back to upstream, do so via the canonical repo, not this skill.

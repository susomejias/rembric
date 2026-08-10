# SDD Archiver

You run the **archive** phase. Invoke the `openspec-archive-change` skill via the Skill tool and follow it; everything below is the repo-specific context it needs.

## You must be given the change name

You run non-interactively and cannot prompt for a selection, and the skill's default is to ask. Run `openspec list --json` to see the active changes; if the prompt did not name one and more than one is active, say so and stop. Archiving the wrong change is disruptive to undo.

## Check completion honestly, then report rather than block

```bash
openspec status --change "<name>" --json
```

Read `tasks.md` and count `- [ ]` against `- [x]`. Incomplete artifacts or tasks do **not** block the archive — but you must **report them explicitly** in your summary, and you must not tick anything to make the numbers look better. If a task is marked `[x]` but you can see the code does not deliver it, say so plainly; that specific failure has happened here before and is worth catching at the gate.

## The spec merge is the real work

Moving the directory is trivial. Merging `openspec/changes/<name>/specs/**` into `openspec/specs/<capability>/spec.md` is where the value and the risk are, because **`openspec/specs/` is this repo's authoritative contract** — whatever lands there is what future readers and future agents treat as true.

Follow the convention already visible in `openspec/changes/archive/`: delta requirements are merged **adds-only** into the corresponding capability file, keeping the existing `### Requirement:` / `#### Scenario:` structure and voice.

Before you finish, do the check that matters most:

1. **Grep the whole target spec for the terms the new requirements use**, and read the surrounding requirements in full. The characteristic defect in this repo is a contradiction _between_ requirements, not within one — a change that inverts a long-standing behaviour leaves older requirements still describing the old one. A batch here shipped having fixed two such statements and missed a third, in a different file.
2. **Verify the merged requirements match the code that actually shipped.** If a delta spec claims behaviour the implementation does not have, do not merge it as-is: report the mismatch and either narrow the requirement to what shipped or flag it for a follow-up change. A spec that overclaims is worse than a missing one.
3. **Check the tool descriptions.** Where a change altered an MCP tool, the `description` strings in `apps/server/src/mcp/*.ts` are the _runtime_ contract an agent reads every turn. If they disagree with the merged spec, say so — that is higher severity than stale prose.
4. **Check the docs.** `README.md`, `docs/backup.md`, `docs/docker.md`, `docs/embeddings.md`, `.env.example` may now contain statements the change made false. `docs/backup.md` matters most: an operator restores from it.

## The move

```bash
mkdir -p openspec/changes/archive
mv openspec/changes/<name> openspec/changes/archive/YYYY-MM-DD-<name>
```

Use today's real date. If the target already exists, stop and report rather than overwriting — the existing archive is history. `.openspec.yaml` travels with the directory.

## Commit

Conventional Commits, scoped `docs(openspec):`. Never bypass hooks. Keep the archive commit separate from any code commit — the code landed in the apply phase, and mixing them makes the history harder to read. If you had to correct a spec contradiction as part of the merge, that belongs in the same commit as the merge, and the message should say what was contradictory and which statement won.

## Report

Change name, archive path, spec sync status, and — not optional — the list of contradictions, overclaims, stale tool descriptions or stale docs you found, whether you fixed them or are flagging them, plus any incomplete artifacts or tasks you archived over. If the merge was clean, say so explicitly.

# Deliberately not done

Task group 9. Each item is a decision with its reason, not a TODO — the point is
that a later reader can tell "considered and rejected" from "forgotten".

## 9.1 — A CI regression gate running reduced-size measurements

**Deferred, not rejected.** It needs two things this change does not settle: the
harness (now present) and an agreed answer to "what is a tolerable regression".
Without the second, the gate is either so loose it never fires or so tight that
it reds on scheduler noise, and both teach a contributor to ignore it.

Concrete blocker, now measurable: §5 puts a 50k build at minutes, so a CI gate
would have to run a reduced size, and nothing here establishes that a plan shape
observed at (say) 5k predicts the one at 50k. Establishing that is the first task
of whichever change picks this up.

## 9.2 — Expressing `seed-dev.ts`'s demo corpus in terms of this harness

**Rejected for now.** It couples a stable operator-facing fixture to a
measurement tool for no measured benefit. `seed-dev` exists so a fresh dev boot
shows a dashboard with recognisable, hand-authored content; this harness exists to
make a planner misbehave. They share no requirement, and the delta spec for
`development-environment` says so normatively ("neither SHALL be expressed in
terms of the other"), so reversing this needs a spec change rather than a
refactor.

The two also have **opposite safety properties** — `seed-dev` is allow-listed to
issue `DELETE FROM memory`, this harness asserts it never can — which is the
strongest argument against sharing an implementation.

## 9.3 — Design open question 1: should the harness emit a manifest?

**Answered: no.** Resolved in `design.md`; the reasoning is there rather than
duplicated here. In short: the harness prints its own rebuild invocation, which
is the same information without a second artifact whose staleness rules would
need stating, and the `data-access` requirement puts the obligation on the
claim's record rather than on the corpus directory.

## 9.4 — Design open question 2, carried forward as a named follow-up

**Follow-up name: `couple-volumetric-harness-to-schema-inventory`.**

The idea: `apps/server/src/test/schema-inventory.ts` already enumerates every
table and partitions them into source and derived, and is itself asserted. The
harness could read that inventory and fail when a **source** table it does not
know how to populate appears, so a schema addition cannot silently produce a
corpus with a hole in it.

Carried rather than done, for the reason design.md already gives: it couples a
dev tool to an invariant module, and that coupling deserves its own argument.
What this change contributes toward it: the derived-state assertion in
`seed-volumetric.test.ts` (`derivedStateProblems`) is the hand-maintained list
that the follow-up would replace with a generated one, so the follow-up has a
concrete before-state to point at.

## 9.5 — The limitation the harness ships with

**Its embedding vectors are synthetic**, so no question about retrieval quality
can be answered on a corpus it built: not recall, not ranking, not the fusion
weighting, not the abstention floor, not `RELATIVE_LEVEL_RATIO`. `pnpm run eval`
and its 40-item labelled corpus remain the instrument for those — a different
instrument for a different question, not a lesser version of this one.

This is not only written down. It is printed twice in the harness's own output
(before and after the build), it is a named export
(`SYNTHETIC_VECTOR_CAVEAT`), and the `data-access` delta makes citing a harness
corpus for a retrieval claim a rejectable move. The point of that redundancy: a
figure gets copied out of a terminal, and the caveat has to travel with it.

Second-order limitation, recorded here because it follows from the first: the
harness deliberately does **not** write the `EMBEDDING_INPUT_VERSION` state
marker, so a server booted against a harness corpus will schedule a re-embed of
every row. That is correct — the vectors are not the model's — but it means a
harness corpus is not a shortcut to a populated dev stack.

Third, from §5's own measurement: the corpus's timestamps are anchored to a fixed
epoch, so the **decay and review axes are read against the wall clock**. A
review- or decay-axis measurement must pass an explicit `nowMs` (the repository
reads already accept one) rather than rely on the ambient clock, or it will
report a different answer next month against the same corpus.

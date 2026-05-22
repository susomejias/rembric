---
name: zero-tech-debt
description: Rework a change as if the intended UX and architecture had existed from day one — deleting compatibility cruft, dead branches, and accidental complexity instead of patching around them. Use when refactoring, cleaning up after a feature lands, removing flags, collapsing legacy paths, or when the user says the code "should look like X from scratch".
user-invocable: true
---

# Zero Tech Debt

Reshape the change from the **intended end state**, not from the historical path that produced the current patch. The goal is the code that _should_ exist now, not the smallest diff from what's there.

## Steps

1. **Name the end state.** In one or two sentences, describe the product surface and architecture as if you were building it today.

2. **Find real callers before preserving anything.** Grep for actual usage of each mode, prop, wrapper, route alias, or fallback. If nothing references it, delete it — do not "improve" it.

3. **Reshape around the final surface.** Prefer one clear component or flow over mode flags. Split only when there is an obvious boundary: state, layout, controls, or domain commands.

4. **Move shared rules to one place.** Feature flags, permissions, route gating, URL state, and command naming must not be duplicated across pages or buried inside view components.

5. **Verify the intended flow.** Test the new behavior _and_ the assumptions you deleted — anything that touched navigation, permissions, or persisted state.

## Rules

- Optimize for the code that should exist, not the smallest diff from the old shape.
- Delete dead compatibility paths instead of polishing them.
- Do not invent a generic framework for a single feature.
- Keep the refactor scoped to what makes the final shape coherent — no opportunistic cleanup.
- Prefer names that describe product intent over implementation history.

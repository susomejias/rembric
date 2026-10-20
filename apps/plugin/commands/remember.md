---
description: Save text as a project memory in Rembric.
---

Call `memory.save({type: 'project', title: <concise ≤100-char headline of the text>, content: '$ARGUMENTS', tags: <labels derived from the text>})` and report the new memory id.
Tags are required: 1–64 strings, normally 1–5 useful reusable lowercase Unicode kebab-case labels (dashboard, sqlite, bug-fix).

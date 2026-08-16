---
description: Persist an end-of-session summary to Rembric (summary ≤10000 chars).
---

Call `memory.session_summary({title, summary})` to capture the session. The `##` sections you send REPLACE their stored counterparts; sections you omit keep their stored text — send the current state, current first. Keep `summary` concise; hard limit is ≤10000 chars and the server rejects longer with `invalid_input`. Body: Use exactly these six Markdown level-2 headings, in this order, each on its own line (never one flat paragraph):

## Goal

## Accomplished

## Decisions+why

## Verified+how

## Unfinished+why

## Files

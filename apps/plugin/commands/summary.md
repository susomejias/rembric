---
description: Persist an end-of-session summary to Rembric (summary ≤10000 chars).
---

Call `memory.session_summary({title, summary})` to capture the session. Keep `summary` concise; hard limit is ≤10000 chars and the server rejects longer with `invalid_input`. Body: Goal · Accomplished · Decisions+why · Verified+how · Unfinished+why · Files.

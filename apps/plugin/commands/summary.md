---
description: Persist an end-of-session summary to Rembric (summary ≤2000 chars).
---

Call `memory.session_summary({title, summary})` to capture the session. Keep `summary` ≤2000 chars (the server rejects longer with `invalid_input`). Body: Goal · Discoveries · Accomplished · Next Steps · Files.

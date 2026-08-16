## REMOVED Requirements

### Requirement: The `memory.session_get` description MUST disambiguate `limit` and mark the read exceptional

**Reason**: The requirement exists entirely to keep one argument from being misread. Its two obligations — say what `limit` bounds (the count of past summary VERSIONS, not the summary's length), and say that supplying it is EXCEPTIONAL — have no subject once `limit` is removed with the `session_summary_versions` table it paged (`sessions`, "`memory.session_get` returns a session's full summary by id"). A description cannot disambiguate an argument the tool does not declare.

The disambiguation risk it was written against disappears with the argument rather than merely going unmonitored: `memory.session_get` now declares exactly one property, `sessionId`, so there is no `limit` for a caller to read as `memory.search`'s `limit`. The remaining published obligation on this tool's description — that it explain the tool returns the full untruncated summary in contrast to `memory.context`'s snippet — belongs to `sessions` and is unaffected.

**Migration**: The `memory.session_get` description drops the `limit` sentences and shortens; no cap moves, and the `DESCRIPTION_MAX_LENGTH` measurement is taken from a real `tools/list` response as it is for every other tool. A caller that still sends `limit` is refused by input validation under "Every MCP tool input schema MUST refuse an unknown property rather than ignore it", naming the tool and the property — the designed outcome of strictness, not a regression, and the reason no compatibility shim is added. The published integration assertion on `SESSION_GET_VERSIONS_MAX + 1` being rejected goes with the constant.

# Local smoke: real server, real MCP transport

**Setup:** host dev server (`pnpm run dev`) with the compiled-in embedder loaded, a fresh scratch `REMBRIC_DATA_DIR` for each arm, and the unscoped `/mcp` endpoint, which uses the default project.

**Probe:** a JSON-RPC client with a full `initialize` handshake, then `tools/call`. It saves 20 heterogeneous project facts, then makes two saves:

- an **unrelated** save: "Design review moved to Thursdays…";
- a **near-duplicate** save, restating "The production image is distroless".

**Arms:** the control arm rebuilt `@rembric/core` with `LEXICAL_CANDIDATE_FLOOR = 0` (rank-only lexical admission, the pre-change behaviour). The change arm uses the shipped `0.6`. The source file was restored with `git checkout` afterwards.

| Case                                        | Control, floor 0                                         | Change, floor 0.6              |
| ------------------------------------------- | -------------------------------------------------------- | ------------------------------ |
| Pending rows written while seeding 20 facts | 84                                                       | 0                              |
| Unrelated save: `candidates[]`              | 5, all `fts`, similarity 0.22–0.28                       | 0                              |
| Unrelated save: `candidatesDetected`        | 20                                                       | 0                              |
| Near-duplicate: `candidates[]`              | 5: the real match (`vec` 0.97) plus 4 `fts` at 0.14–0.23 | 1: the real match (`vec` 0.97) |
| Near-duplicate: expected target surfaced    | yes                                                      | yes                            |

The control arm reproduces issue #453 on the real server, and the change arm removes the noise without losing the real match.

**Why the change arm's zeros are real:** in the change arm, the near-duplicate still surfaces its target, so detection is live and the probe reached it.

**Why the target came through `vec`:** with the embedder loaded, the target scores higher on the vector channel, and deduplication keeps the higher-similarity entry. The lexical-only path for a near-duplicate is covered by the unit test `a lightly edited near-duplicate is still surfaced lexically at or above the floor`.

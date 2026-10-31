## Context

Hermes' memory-provider guide at commit `c419cf7c864ac0ee511dbd9f7091a8bba0b567ee` requires initialization-time `get_secret` resolution, instance-owned profile bindings and `spawn_context_thread` workers. The current provider instead reads process environment on health, initialization and every POST.

## Goals / Non-Goals

Goals: prevent cross-profile routing, retain credentials after scope exit, fail closed visibly without leaking secrets or interrupting Hermes.

Non-goals: installer/dependency/version changes, server protocol changes, credential storage or legacy Hermes compatibility.

## Decisions

- Read scoped settings in availability checks and again at initialization, binding initialized values on `self`. Later hooks never re-resolve credentials. Reject process-environment fallback even for absent APIs: availability is less important than profile isolation.
- Pass tokens explicitly through HTTP helpers and capture server/token/slug/session before worker dispatch. Reject a global slug cache: identical slugs can belong to different tokens and servers.
- Use Hermes' context-preserving thread factory, returning an unstarted thread, then start it. Missing or failing APIs produce fixed diagnostics, not raw exceptions. No bare-thread compatibility path.
- Keep the existing `.rembric` parser, validation, health request, routes, bodies, suppression and lifecycle state. Sanitize HTTP errors too so remote response bodies and exception strings cannot expose credentials.

## Risks / Trade-offs

[Trade-off] Old Hermes hosts lose provider functionality → Accepted because fallback can silently mix profiles; show an update-Hermes diagnostic.

[Risk] Mocked host tests cannot prove real gateway dispatch → Parent independently verifies HTTP; live multiplexed gateway validation remains explicit.

## Migration Plan

Update Hermes to a release exposing scoped secrets and context-preserving threads, configure each profile's REMBRIC settings through Hermes, update the plugin and restart the gateway. Do not restore environment fallback as a compatibility measure.

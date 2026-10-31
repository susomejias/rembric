## Why

A multiplexed Hermes gateway can serve several profiles in one process. Reading process environment credentials can send a profile's sessions to another profile's server or project.

## What Changes

- **BREAKING**: resolve REMBRIC settings exclusively through `agent.secret_scope.get_secret`; never fall back to process environment, including when the API is absent or raises.
- Bind server, token and resolved slug on each provider during initialization. Preserve `.rembric` precedence and slug validation; no shared slug cache.
- Capture authentication and routing before dispatching workers through Hermes `spawn_context_thread`.
- Fail closed with safe visible diagnostics and no exceptions into the host when secrets or required host APIs are unavailable.
- Preserve health path, HTTP routes/bodies and session lifecycle. Update scoped tests and provider documentation; release-please owns version carriers.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hermes-agent-plugin`: exclusive profile-scoped credential resolution and instance binding.
- `plugin-session-protocol`: Hermes workers retain initialized authentication and routing after scope exit.

## Impact

Only the Hermes provider, its tests and README, and this change's artifacts are modified. No dependencies, installers, server changes or other clients. Older Hermes without the scoped secret/thread APIs must be updated; default-profile fallback is intentionally unsupported.

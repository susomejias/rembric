## ADDED Requirements

### Requirement: The plugin MUST NOT implement migration or coexistence behaviors with other agent memory systems

This capability SHALL NOT specify migration prompts, import flows, side-by-side coexistence rules, or compatibility shims with other agent memory systems. Rembric is positioned as the sole memory layer for any agent it is enabled on; the plugin's hook scripts, MCP bridge, skill content, and command catalogue SHALL be authored under the assumption that no second memory system is active on the same agent. Operators with another memory tool installed SHALL be guided (via the plugin's README) to uninstall it before enabling this plugin, but the plugin itself SHALL NOT attempt detection, warning, or graceful coexistence with such tools.

This requirement formalises a previously informal scope statement under `## Out-of-scope behaviors` of this spec. As a side effect of accepting this delta, the apply step SHALL delete the bullet item beginning `Migration prompts or coexistence behavior with engram, agentmemory, or other memory tools` from the `## Out-of-scope behaviors` section, since the same intent is now expressed as a normative requirement and naming specific third-party tools is no longer necessary.

#### Scenario: Plugin hook scripts do not check for or interoperate with other memory systems

- **WHEN** the plugin's hook scripts (`session-start.sh`, `pre-compact.sh`, `session-stop.sh`) and the bundled MCP bridge (`bin/rembric-bridge.mjs`) are inspected
- **THEN** none SHALL contain logic that detects, warns about, defers to, or imports state from any agent memory tool other than Rembric
- **AND** none SHALL name a specific third-party memory tool in their output, comments, or stderr diagnostics

#### Scenario: Skill content does not instruct the agent to migrate from or compare with other memory systems

- **WHEN** the plugin's skill content (markdown files under `plugin/skills/`) is read
- **THEN** the skill SHALL NOT direct the agent to import from, deduplicate against, prefer Rembric over, or otherwise reason about parallel memory tools
- **AND** the skill SHALL describe Rembric's memory protocol on its own terms, without comparison to other agent memory systems

#### Scenario: README warns about parallel installations without naming alternatives

- **WHEN** the plugin README is rendered (e.g. on GitHub)
- **THEN** the operator guidance about parallel-tool drift SHALL state that this plugin is the sole memory layer and SHALL warn against having another memory tool installed
- **AND** the guidance SHALL NOT name any specific third-party memory tool by name

## ADDED Requirements

### Requirement: Shell-client transcript fallbacks MUST NOT replace the first-prompt title

`session-end.sh` (`POST /end`) and `pre-compact.sh` (`POST /summary`) send `final: false` transcript writes under the same precedence as the provisional title `stop-report.sh` delivers on `POST /turn`, so any title they carry replaces that one. Both SHALL take their title from ONE helper, `rembric_fallback_title` in `apps/plugin/scripts/_transcript.sh`, which SHALL return:

1. the first prompt `prompt-nudge.sh` recorded, when no turn report has delivered it yet — consuming it, so `/turn` does not send it again;
2. nothing, when a turn report already delivered it — the write then carries no `title` key at all;
3. the first assistant message only when no prompt was ever recorded, as happens when every prompt so far was an image.

Before this requirement both scripts always sent the first assistant message, which is often mid-turn narration cut at 100 characters, and every compaction and the session end replaced the first-prompt title with it whenever the model never wrote a curated title (issue #439). A curated `final: true` title is unaffected: precedence already keeps it.

#### Scenario: The delivered first-prompt title survives the session end

- **GIVEN** `prompt-nudge.sh` recorded the prompt `Fix the timeouts` and `stop-report.sh` delivered it on `/turn`
- **WHEN** `session-end.sh` runs on a transcript whose first assistant message is narration
- **THEN** its `/end` body SHALL carry the summary and SHALL NOT carry a `title` key

#### Scenario: A compaction leaves the delivered title alone

- **GIVEN** the same delivered first prompt
- **WHEN** `pre-compact.sh` runs
- **THEN** its `/summary` body SHALL NOT carry a `title` key

#### Scenario: An undelivered first prompt is sent by the fallback

- **GIVEN** `prompt-nudge.sh` recorded the first prompt and no turn report ran
- **WHEN** `session-end.sh` runs
- **THEN** its `/end` body SHALL carry that prompt as `title`

#### Scenario: Assistant narration is the title only when no prompt was recorded

- **GIVEN** no prompt was ever recorded for the session
- **WHEN** `session-end.sh` runs
- **THEN** its `/end` body SHALL carry the first assistant message as `title`

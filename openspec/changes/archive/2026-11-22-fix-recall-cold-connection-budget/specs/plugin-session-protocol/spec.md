## ADDED Requirements

### Requirement: JavaScript recall hints accommodate cold transport within a bounded total deadline

The shared JavaScript session core SHALL use a 500 ms default end-to-end deadline for `recallHints`. Connection establishment, response headers and body consumption SHALL share that deadline. A caller-supplied deadline SHALL remain authoritative. The core SHALL retain an empty-array failure result and SHALL NOT retry, preflight, or add periodic keepalive traffic. The background POST deadline SHALL remain unchanged.

#### Scenario: A healthy response survives connection setup

- **GIVEN** a known session and a trusted HTTPS server requiring 170 ms TLS negotiation and returning hints 65 ms after receiving the POST
- **WHEN** `recallHints` uses its default deadline on a fresh connection
- **THEN** it SHALL return the hints with exactly one hints POST and no timeout diagnostic
- **AND** the equivalent warm-connection request SHALL succeed with an explicit 200 ms deadline
- **AND** the explicit 200 ms cold-connection control SHALL return no hints with a timeout diagnostic

#### Scenario: An unresponsive endpoint still abandons one request

- **GIVEN** a known session and an endpoint which does not return headers
- **WHEN** `recallHints` uses its default deadline
- **THEN** it SHALL abandon the request at its bounded deadline, return an empty array and report that deadline
- **AND** it SHALL NOT issue a second hints POST

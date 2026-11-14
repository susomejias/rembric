## MODIFIED Requirements

### Requirement: The authenticated HTTP surface MUST bound request body size

Endpoints that read a request body — `/mcp` (POST) and every `/api` route that reads a JSON body (`/api/<slug>/sessions*` and `/api/<slug>/memory/recall`) — SHALL enforce a maximum raw body size and reject an over-large body with `413` (payload too large) instead of buffering it unboundedly in memory. A declared `Content-Length` over the maximum SHALL be refused before the body is read, and a body without one SHALL stop being read once it passes the maximum. The bound SHALL apply even to authenticated callers, so a valid token cannot exhaust process memory with a single large POST. The limit SHALL be generous enough for legitimate MCP payloads and SHALL be configurable with `MAX_BODY_BYTES`, which defaults to 4 MiB (`4194304`); a value that is not a positive integer SHALL fall back to the default. An `/api` route SHALL answer the refusal in the `/api` error shape, `{ ok: false, code: "payload_too_large", message }`.

#### Scenario: Oversized MCP body is rejected

- **GIVEN** an authenticated client posting a body larger than the configured maximum to `/mcp`
- **WHEN** the server reads the request
- **THEN** the server SHALL stop reading and respond `413` without buffering the entire body

#### Scenario: Normal-sized body is accepted

- **GIVEN** an authenticated client posting a body within the configured maximum
- **WHEN** the server reads the request
- **THEN** the request SHALL be processed normally

#### Scenario: Oversized `/api` body is rejected in the `/api` error shape

- **GIVEN** `MAX_BODY_BYTES=1024` and an authenticated client streaming a body without `Content-Length` that grows past 1024 bytes to `POST /api/<slug>/sessions/<id>/summary`
- **WHEN** the server reads the request
- **THEN** the server SHALL stop reading, cancel the request body, and respond `413` with body `{ ok: false, code: "payload_too_large", message: "request body exceeds 1024 bytes" }`

#### Scenario: A declared oversized `Content-Length` is refused before reading

- **GIVEN** `MAX_BODY_BYTES=1024` and an authenticated client posting to `POST /api/<slug>/sessions` with `Content-Length: 2048`
- **WHEN** the server handles the request
- **THEN** the server SHALL respond `413` with `code: "payload_too_large"` without reading the body
- **AND** no session row SHALL be created

## ADDED Requirements

### Requirement: Every MCP tool MUST advertise an output schema and return conforming structured content

Every tool registered on the MCP server SHALL declare an `outputSchema` describing the shape of its **successful** result, and on success SHALL return a `structuredContent` object that conforms to that schema. The `structuredContent` SHALL be the JSON-normalized form of the response (timestamps as ISO strings), equal in meaning to the existing `text` content block.

This requirement is additive and SHALL NOT change:
- the `text` content block returned by any tool (clients that read only `text` are unaffected), or
- error results — results returned via `mcpError` carry `isError: true`, for which output-schema validation is not performed.

#### Scenario: A successful tool call returns structured content

- **WHEN** any registered tool is invoked and succeeds
- **THEN** the result SHALL include a `structuredContent` object conforming to the tool's declared `outputSchema`
- **AND** the result SHALL still include the equivalent `text` content block

#### Scenario: Every tool advertises an output schema

- **WHEN** a client calls `tools/list`
- **THEN** every tool entry SHALL include an `outputSchema`

#### Scenario: Error results are exempt from output-schema validation

- **WHEN** a tool returns an error via `mcpError` (e.g. `not_found`, `scope_locked`, `forbidden`, `invalid_input`)
- **THEN** the result SHALL carry `isError: true` and SHALL NOT be required to include `structuredContent`

#### Scenario: Structured content matches the text payload

- **WHEN** a tool succeeds and returns both `text` and `structuredContent`
- **THEN** parsing the `text` JSON SHALL yield the same object as `structuredContent`

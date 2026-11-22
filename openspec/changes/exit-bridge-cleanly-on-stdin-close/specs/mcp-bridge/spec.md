## ADDED Requirements

### Requirement: Closing stdin ends the bridge cleanly; only genuine transport failures exit non-zero

When the host closes the bridge's stdin, the bridge SHALL abort its in-flight HTTP requests and SHALL exit `0`. A request that fails because of that abort SHALL NOT be reported as a transport failure and SHALL NOT be answered on stdout, whether or not its JSON-RPC message carries an `id`: the host closed the channel, so nothing it is still waiting on is owed an error.

Any other failure SHALL keep its handling. A failed request with an `id` SHALL be answered with a correlated JSON-RPC error of code `-32000`. A failed notification SHALL end the bridge with a `transport failure` stderr line and a non-zero exit, and the requests that shutdown aborts SHALL each be answered with a correlated `-32000` error.

#### Scenario: Stdin closes while a notification's response is outstanding

- **GIVEN** the bridge has forwarded `notifications/initialized` and the server has not yet answered it
- **WHEN** the host closes the bridge's stdin
- **THEN** the bridge SHALL exit `0`
- **AND** stderr SHALL NOT contain `transport failure`

#### Scenario: Stdin closes while a request's response is outstanding

- **GIVEN** the bridge has forwarded a `tools/call` with an `id` and its response is still open
- **WHEN** the host closes the bridge's stdin
- **THEN** the bridge SHALL write nothing further to stdout
- **AND** it SHALL exit `0`

#### Scenario: A notification fails on the transport while a request is open

- **GIVEN** a `tools/call` with `id` `2` is held open by the server
- **WHEN** the server drops the connection for a notification the bridge forwards
- **THEN** the bridge SHALL answer `id` `2` with a `-32000` error
- **AND** stderr SHALL contain `transport failure`
- **AND** the bridge SHALL exit non-zero

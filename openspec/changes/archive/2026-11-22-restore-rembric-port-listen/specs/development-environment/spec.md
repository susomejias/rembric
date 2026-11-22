## ADDED Requirements

### Requirement: The standalone image MUST listen on the port `REMBRIC_PORT` names

The container entrypoint SHALL derive its effective listen port as `REMBRIC_PORT`, then `PORT`, then `8787`. Because the Next-generated standalone server reads only `PORT`, a launcher SHALL publish the resolved value as `PORT` before the generated server loads. The image HEALTHCHECK SHALL probe `/healthz` on that same resolved port rather than a hard-coded `8787`, and `/healthz` SHALL keep its existing semantics on the effective port.

A non-empty `REMBRIC_PORT` that is not an integer between `1` and `65535` SHALL refuse startup with an error naming the variable and the received value, not fall back to the default. An empty or whitespace-only value SHALL count as unset.

The `ENTRYPOINT` path (`apps/web/server.js`) SHALL remain the value the publish smoke test asserts.

#### Scenario: An existing installation sets a custom port

- **GIVEN** an operator's `.env` sets `REMBRIC_PORT=8799` and their Compose file maps `${REMBRIC_PORT}:${REMBRIC_PORT}`
- **WHEN** the container starts
- **THEN** the server SHALL listen on `8799`
- **AND** `/healthz` SHALL respond `200` on `8799`
- **AND** the operator SHALL NOT need to edit the Compose file

#### Scenario: Neither variable is set

- **GIVEN** neither `REMBRIC_PORT` nor `PORT` is set
- **WHEN** the container starts
- **THEN** the server SHALL listen on `8787`

#### Scenario: An invalid REMBRIC_PORT fails fast

- **GIVEN** `REMBRIC_PORT` is set to a non-integer or out-of-range value
- **WHEN** the container starts
- **THEN** startup SHALL fail with an error naming `REMBRIC_PORT` and the received value
- **AND** the server SHALL NOT silently listen on `8787`

#### Scenario: The healthcheck probes the effective port

- **GIVEN** the container runs with `REMBRIC_PORT=8799`
- **WHEN** the image HEALTHCHECK runs
- **THEN** it SHALL probe `http://127.0.0.1:8799/healthz`
- **AND** the container SHALL report healthy

# Wrapped visibility

The overview card appears from **December 1 through January 31, inclusive (UTC)**. January opens the previous year's recap; other months default to the current year.

## Show the card outside the season

Set this environment variable on the **server process**:

```dotenv
REMBRIC_WRAPPED_FORCE=true
```

Restart the server with the updated environment. For the repository's Docker Compose deployment, add the variable to its existing `.env` and recreate the service:

```sh
docker compose up -d --force-recreate rembric
```

The Compose service already forwards that file through `env_file`; no image rebuild is needed for subsequent flag changes once this feature is deployed. A plain container restart does not reload changed environment settings.

Only the exact value `true` forces the card. Remove the variable or set `false`, then restart/recreate with the updated environment, to restore the seasonal schedule. `false` does not hide the card during December or January.

## Validate real data at any time

Log in as an instance admin and visit `/dashboard/wrapped?year=2026` (replace the year as needed). Direct access works year-round, regardless of the flag. An explicit valid year overrides the seasonal default.

The flag only changes the card's visibility. It does not bypass login, change data, alter date boundaries or enable a public sharing URL. It is instance-wide, so every dashboard admin sees the card while forced.

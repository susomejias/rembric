## Context

The authenticated viewer currently anonymizes projects even though its owner needs to recognize them. PNGs only render the total number of active projects.

## Goals / Non-Goals

**Goals:** Show display names with slug fallback in the four ranked cards; preserve counts, ties, remainder, and anonymous PNGs.

**Non-Goals:** Public project access, names in exports, project links, migrations, or entity values.

## Decisions

- Replace bare ranked counts with name/count records. Keep aggregation by project ID, not name: display names need not be unique. Resolve names after aggregation with the existing projects table, rather than another request or a parallel names array.
- Use display name when present, otherwise slug, matching project identity conventions. Do not add aliases or expose internal IDs.
- Render names as React text and constrain long labels within the existing cards. Use positional list keys because ranks are static and names can duplicate or equal Other.
- Leave the PNG renderer unchanged and test both formats against name leakage, rather than adding a redundant privacy mode.

## Risks / Trade-offs

[Risk] Names expose project identity to the browser → Only the existing instance-admin route receives them; PNGs remain aggregate-only.

[Risk] Long or duplicate names → Bounded wrapping and rank keys; test duplicate names and narrow-screen layout.

[Trade-off] Internal payload shape changes → Deploy server and viewer together; restart local dev services if their singleton retains the old repository.

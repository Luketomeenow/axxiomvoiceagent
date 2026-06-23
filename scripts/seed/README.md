# Compliance knowledge base (seed)

`ca_elevator_compliance.csv` seeds the `outbound.code_reference` table that the
outbound agent's `lookupViolationCode` tool reads from. The agent speaks **only**
from these entries — it never invents code meanings — so the content here must be
accurate.

> ⚠️ **DRAFT — Axxiom must review/verify before live calls.** These entries were
> drafted from public California sources (CCR Title 8 *Elevator Safety Orders*,
> §3000s, and ASME A17.1) for plain-English use on the phone. Confirm wording,
> section references, and remedies with your team / counsel before relying on
> them with real prospects.

## Format

CSV columns (header row required; topic keys and code numbers both allowed in `code`):

| column | meaning |
|--------|---------|
| `code` | Topic key (e.g. `OVERDUE_INSPECTION`, `EXPIRED_PERMIT`) or a code/section (e.g. `2.7.6`). Normalized on import (uppercased, spaces/punctuation → `_`, dots kept) so it matches how the agent queries. |
| `jurisdiction` | e.g. `CA Title 8`, `ASME A17.1`. |
| `title` | Short official title. |
| `plain_summary` | One-line, plain-English meaning the agent can say. |
| `severity` | `informational` \| `minor` \| `major` \| `critical`. |
| `typical_remedy` | What it usually takes to clear it (no prices, no firm timelines). |
| `source_url` | Reference link. |

## Seed it

```bash
bun run import-codes scripts/seed/ca_elevator_compliance.csv
# or, without Bun:
npm run import-codes:node -- scripts/seed/ca_elevator_compliance.csv
```

Upserts on `code`, so editing a row and re-running safely updates it. Add rows as
your team confirms more topics/codes.

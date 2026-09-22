# Restore main dashboard parity

## Contract

Replicate main's existing structure and functionality in Next.js with existing shadcn/Spectrum primitives, reducing maintained custom code. Preserve library defaults: accept minor visual differences rather than heavily tuning components or reproducing legacy CSS with overrides. User screenshots of login, overview and memories are the visual reference. No redesign, backend/auth changes, dependencies, database mutations, push or commits in this correction pass. Preserve existing functional contracts. Branch: feat/monorepo-nextjs-redesign.

## Execution

Parallel read-only investigation with one bounded writer; no concurrent writes in the shared worktree. Parent owns this document. RDD off. Strict TDD not activated in the prior task; browser regression evidence is required and must not be substituted with build success. Verification commands are delegated and serialized. Approximate initial scope: 300–700 authored changed lines, revised after mapping; no delivery/PR requested.

## Tasks

- [ ] P1 Restore login composition from main and supplied screenshot. Implementation returned by mubc27xw-5-mgre; comment cleanup mubcb0bk-9-qvqm complete. Only login/page.tsx changed. GET login/error/next checks and scoped lint passed per writer; independent browser verification pending (configured browser missing). Not closed.
- [ ] P2 Reproduce and correct overview overflow and structural mismatch. Explorer mubbwsog-4-8qjp returned source-only evidence (no browser tools). Sole writer mubccamk-a-tl0v now restores main's stat strip and descriptive judgment/session rows, with shared containment/heading fixes. User explicitly selected Spectrum NumberTicker (https://ui.spectrumhq.in/docs/number-ticker) for numeric counters; preserve official component defaults, accessibility and reduced-motion. Independent runtime verification remains required.
- [ ] P3 Map and restore memories/shared view structure against main. Read-only mapper first; shared components changed serially after P1.
- [ ] P4 Independently verify authenticated populated views at desktop/mobile widths, login presentation, interactions, page scrollWidth <= clientWidth, typecheck/lint/format and build. Browser verifier: mubc3ycr-7-ymor. Record exact results and remaining failures.
- [ ] P5 Audit functional parity with actual main. Static audit COMPLETE (mutation layer, updater, OAuth consent, metadata gaps all enumerated; verifier mubc4xmx-8-26wv).
- [ ] P8 Demolish apps/server after cutover (owner confirmed end-state: NO apps/server in final tree). Sequence: (1) web image published under existing channel; (2) mutations + OAuth AS implemented as Next route handlers (/authorize,/token,/register) with existing consent page + session CSRF — no Hono dependency in the SDK auth pieces; (3) version anchor relocated out of apps/server (release-please reanchor or neutral package) so lib/version.ts keeps resolving; (4) retire Hono test oracle once web suite covers the contract; (5) git rm apps/server, final spec deltas, installer/docs/MCP client repoint.

## Lote 7-8 items E — decisiones del owner-delegado (medidas inline, HEAD a3780dd5)

1. **seed-dev/seed-volumetric** → `apps/web/src/scripts/` (dev-only). docker-publish solo lo grep-ea como señal NEGATIVA (que NO esté en la imagen publicada — satisfecho estructuralmente); docs/docker.md documenta el dev compose que muere con P8.3c. Repoint allow-list de invariants.
2. **config.ts → retirar** con apps/server. La web lee 13 REMBRIC*\* inline con validación propia donde importa (oauth.ts valida PUBLIC_URL); REMBRIC_HOST/PORT/MCP_ALLOWED*\* no existen en web (no hay http server propio).
3. **logger.ts → retirar** (cero consumers fuera de server, medido).
4. **retrieval harness** → `packages/core/src/test-support/retrieval/` (4 suites co-localizadas + baselines); `CANDIDATES_PER_SAVE_MAX_DEFAULT` se inlinea en el harness (test-only); scripts raíz eval/corpus:build → `--filter @rembric/core`.
5. **plugin tests** → corren bajo el vitest de apps/web (include extendido) con un fixture de boot `next start` en puerto temporal — el MISMO harness del Lote 6 (mcp-integration web split). plugin.test.ts usa createServer real para驱动 el bridge contra HTTP vivo; la web es ese endpoint.
6. **upgrade-helper + test → retirar** (solo lo ejecutaba el upgrader efímero de la imagen server retirada; el web app eliminó self-update).
7. **properties.test.ts → retirar** (modelo self-contained, sin código de producción). **transcript-parser.test.ts → apps/plugin** (es un test del plugin).
8. **Lote 6 consolidado**: construir UNA vez el harness de boot (next start + temp REMBRIC_DATA_DIR) usado por el split de mcp-integration Y los tests del plugin. NOTA transitoria medida (HEAD a3780dd5): plugin.test.ts ya acumula 33 fallos conforme el árbol server encoge (importa server/index + fixtures que mueren) — estado conocido, se arregla con el harness, NO parchear antes.

## Evidence

User screenshots: login 2026-09-21 16.18.48; overview 16.19.20; memories 16.19.40. Previous sidebar change 4f770345 was not verified in an authenticated browser. Prior completion claims do not establish parity.

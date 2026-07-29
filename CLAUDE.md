# Contributing to cortextOS

## Development Setup

```bash
git clone https://github.com/grandamenium/cortextos.git
cd cortextos
npm install
npm run build
npm test
```

## Before Submitting Changes

1. `npm run build` — TypeScript must compile cleanly
2. `npm test` — all tests must pass. Exception: tests asserting OS permission-bit enforcement (e.g. `atomicWriteSync` throwing on a 0555 dir) are unsatisfiable when run as uid 0, since root ignores permission bits. Such tests must skip loudly under root, not silently — see `tests/integration/phase5-failure-modes.test.ts`'s `it.skipIf(isRoot)(...)` pattern, which bakes the skip reason into the test name so it's visible in the reporter output. This is the only exclusion; every other test must still pass.
3. Match existing patterns in `src/` for new features
4. Add unit tests in `tests/` for any new code

## Project Structure

- `src/` — TypeScript source (bus, cli, daemon, hooks, types, utils)
- `bus/` — Shell wrapper scripts (delegate to `dist/cli.js bus`)
- `dashboard/` — Next.js 14 web dashboard
- `templates/` — Agent templates (agent, orchestrator, analyst)
- `community/` — Community skills and agent catalog
- `tests/` — Unit, integration, and E2E tests

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- File operations use atomic writes (see `src/utils/atomic.ts`)
- All bus operations go through `src/bus/` modules

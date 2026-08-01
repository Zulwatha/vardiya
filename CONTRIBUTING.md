# Contributing

Thanks for poking at the code. Keep changes small and match the ownership map in `AGENTS.md`.

## Setup

```bash
npm ci
npm run build
npm test
npm run lint
```

Node 20+ is required (`better-sqlite3` needs a working native build toolchain).

## Where to put work

| Area | Path |
| --- | --- |
| Types / public signatures | frozen (`src/types.ts`, method signatures on `Vardiya` / `Worker`) |
| Storage | `src/storage/` |
| Worker | `src/worker/` |
| Scheduler / cron | `src/scheduler/` |
| Tests / benches / root docs | `test/`, `bench/`, `README.md` |

If the frozen contract is wrong, do not edit it in a drive-by PR. Add a `PROPOSED-CHANGE` comment (see `AGENTS.md`) and open an issue.

## Style

`biome` formats and lints. Writing rules in `AGENTS.md` apply to comments, docs, and commit messages: no em dashes, no hype, plain sentences.

## Tests

`npm test` should stay green. Prefer adding coverage next to the behavior you change. Suites that open storage or start workers must close them in `afterEach`.

## Pull requests

One concern per PR when you can. Say why the change exists. Link an issue if there is one. Do not commit secrets or local `*.db` files.

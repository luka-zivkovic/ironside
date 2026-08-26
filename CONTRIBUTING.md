# Contributing to Ironside

Ironside is pre-release and its interfaces may still change. Before starting a
large change, open an issue describing the problem, proposed scope, and any
compatibility implications.

## Development setup

The repository requires Node.js 24, pnpm 10, and Docker.

```sh
pnpm install
docker compose up -d postgres clickhouse redis minio
pnpm build
pnpm typecheck
pnpm test
```

Keep changes focused, add tests for behavior changes, and update the relevant
file in [`spec/`](./spec) when a contract or invariant changes. Pull requests
should explain the user-visible outcome, migration impact, and verification
performed.

Do not commit `.env` files, credentials, real trace payloads, generated build
output, or exported customer data. Use synthetic fixtures and the documented
local-only defaults.

## License

By contributing, you confirm that you have the right to submit the work and
agree that your contribution is licensed under the
[Ironside Sustainable Use License](./LICENSE.md).

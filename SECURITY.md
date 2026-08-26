# Security policy

Ironside is pre-release. Security fixes are applied to the latest release and
the `main` branch; older pre-release versions are not supported.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Email
[lukazivkovic58@gmail.com](mailto:lukazivkovic58@gmail.com) with:

- the affected component and version or commit;
- reproduction steps or a minimal proof of concept;
- the expected impact; and
- any known mitigations.

You should receive an acknowledgement within seven days. Please allow time to
investigate and prepare a coordinated fix before publishing details.

Never include production credentials, private trace data, or customer data in
a report. Replace secrets and payloads with minimal synthetic examples.

## Deployment responsibility

The Docker Compose defaults are intended only for local development. Before a
reachable deployment, replace every default credential, configure TLS and
trusted origins, use a strong `IRONSIDE_ENCRYPTION_SECRET`, and follow the
production notes in [`docs/self-hosting.md`](./docs/self-hosting.md).

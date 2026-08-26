# SDK release runbook

The `ironside` npm package is released independently from the Ironside
container images. Container tags use `vX.Y.Z`; SDK tags use `sdk-vX.Y.Z`.

## First release

The unscoped package name `ironside` was unclaimed when v0.1.0 was prepared.
Registry availability is only definitive when npm accepts the first publish.

For the bootstrap release:

1. Confirm `npm whoami` returns the intended publishing account.
2. Run the SDK tests, build, and packed-consumer smoke test from the exact
   release commit.
3. Publish `packages/sdk` with a granular npm token that can create public
   packages and satisfies the account's 2FA policy.
4. Verify the package metadata, tarball contents, install, and `latest`
   dist-tag from an unauthenticated registry request.

Do not place npm credentials in repository files, variables, package metadata,
workflow arguments, or shell history.

## Trusted Publishing

After the package exists, configure npm Trusted Publishing for GitHub Actions:

- organization/user: `luka-zivkovic`
- repository: `ironside`
- workflow: `sdk-release.yml`
- environment: `npm`

Create a protected GitHub environment named `npm`, require reviewer approval,
and restrict deployment refs to `sdk-v*` tags. Once one OIDC release succeeds,
remove the bootstrap `NPM_TOKEN` secret and its `NODE_AUTH_TOKEN` workflow
binding. The workflow already requests `id-token: write`; the npm CLI must
remain new enough to support Trusted Publishing.

## Cut subsequent releases

1. Update `packages/sdk/package.json` to a new SemVer version in a pull request.
2. Let CI build, type-check, test, and pack the exact commit, then merge it.
3. Create and push the matching tag, for example `sdk-v0.2.0` for package
   version `0.2.0`.
4. Approve the protected `npm` environment deployment if prompted.
5. Verify the workflow and confirm the registry version and dist-tag.

The workflow refuses a tag whose version does not exactly match
`packages/sdk/package.json`. Stable versions publish under `latest`; SemVer
prereleases publish under `next`.

Never reuse a published version. Prefer deprecation plus a corrective release
over a complete unpublish.

# Releasing warp-lang packages

This documents the real, current release process for the published packages
(`@warp-lang/commerce-types` on npm and `warp-commerce-types` on PyPI). It exists
because the npm-token requirement below keeps getting rediscovered the hard way.

## How a release works

Releases are **tag-triggered**. Pushing a tag like `vX.Y.Z` runs
[`.github/workflows/release.yml`](.github/workflows/release.yml):

1. The **full conformance gate** runs first — the same jobs as CI: Rust
   (`fmt`/`clippy`/`test`), the TypeScript binding, the Python binding, the
   schema validator, the conformance runner, and the TS↔Python cross-check.
2. The publish jobs `needs:` every gate job, so **a red gate publishes nothing.**
3. **`publish-npm` runs first; `publish-pypi` `needs:` it.** The historically
   fragile npm publish gates the reliable PyPI one, so a npm failure stops PyPI
   from publishing — this prevents a *split state* where PyPI is ahead of npm.

Each publish job also guards that the **tag matches the package's declared
version** (`package.json` for npm, `pyproject.toml` for PyPI). Both packages must
therefore carry the same version as the tag, or the matching job fails fast.

## npm requires a GRANULAR token (the recurring lesson)

`NPM_TOKEN` **must be a granular access token** (Read **and** Write, scoped to the
`warp-lang` org).

The npm account enforces **2FA-on-write**. A classic or automation-classic token
does **not** bypass that policy: headless `npm publish` in CI then fails with

```
npm error code EOTP
npm error This operation requires a one-time password.
```

This is exactly how the **v1.0.0** npm publish failed (the gate was green and
PyPI published; only npm errored, and 1.0.0 was published manually with
`--otp`). A **granular** token bypasses the interactive OTP, so headless CI
publish succeeds.

There is no `--otp` in the workflow — an OTP is a short-lived interactive code and
cannot live in CI. The workflow's `Precheck` step runs `npm whoami` so an
invalid/missing token fails with a readable message instead of a cryptic mid-
publish error; if the precheck passes but `npm publish` still EOTPs, the token is
not granular.

> Updating the token is a maintainer action in **Settings → Secrets and variables
> → Actions**, not a code change. Create a granular token, replace `NPM_TOKEN`,
> and revoke the old one.

## PyPI

`PYPI_TOKEN` is a standard PyPI API token used with `twine` (`TWINE_USERNAME =
__token__`). PyPI publishing is headless and does not hit a 2FA issue.

## Pre-release checklist

- [ ] Both package versions match the intended tag:
      `packages/commerce-types/package.json` **and**
      `packages/commerce-types-py/pyproject.toml` are `X.Y.Z`.
      (`package-lock.json` must be in sync — bump with `npm version` so it is.)
- [ ] CHANGELOGs updated for the version.
- [ ] The release PR's CI gate is green (same gate the tag will re-run).
- [ ] `NPM_TOKEN` is a granular Read+Write token; `PYPI_TOKEN` is set.

## Cutting the release

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Watch the **Release** workflow: gate green → `publish-npm` green → `publish-pypi`
green.

## Manual fallback if the CI npm publish fails

If `publish-npm` ever fails (e.g. the token is not yet granular), the gate has
already passed, so the build is releasable — publish npm by hand and let PyPI
follow:

```bash
# from a logged-in terminal, in packages/commerce-types, on the tagged commit
npm publish --access public --otp=<your-6-digit-code>
```

Then, if PyPI did not run (it `needs:` publish-npm), publish it once npm is up —
re-running the failed workflow run from the Actions UI is the cleanest path, since
`publish-pypi` will then proceed. Finally, verify both registries match the tag
(below). The durable fix is still to make `NPM_TOKEN` granular so no manual step
is needed next time.

## Post-publish verification

```bash
# npm
npm info @warp-lang/commerce-types version            # → X.Y.Z

# clean-dir install resolves the expected exports
mkdir /tmp/verify && cd /tmp/verify && npm init -y >/dev/null
npm install @warp-lang/commerce-types
node --input-type=module -e "import('@warp-lang/commerce-types').then(m => console.log(typeof m.order, typeof m.auditCommerce))"
#   → "function function"

# PyPI
curl -s https://pypi.org/pypi/warp-commerce-types/json | python3 -c "import sys,json;print(json.load(sys.stdin)['info']['version'])"   # → X.Y.Z
```

Both registries should report the tagged version before the release is considered
done.

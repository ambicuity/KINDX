# Release Surface QA Checklist

Use this checklist for every tagged release (`vX.Y.Z`) to ensure all public distribution surfaces show the same version.

## 1) Preflight Version Sync

Run:

```bash
jq -r .version package.json
jq -r '."."' .release-please-manifest.json
jq -r '.plugins[0].version' .agent-plugin/marketplace.json
```

Expected: all values are identical (`X.Y.Z`).

## 2) Git Tag And GitHub Release

Run:

```bash
git tag --list | grep "^vX.Y.Z$"
gh release view vX.Y.Z
```

Expected:
- Tag `vX.Y.Z` exists.
- GitHub release exists and is published (not draft/prerelease unless intentionally set).

## 3) Package Registry Verification

Run:

```bash
npm view @ambicuity/kindx version --registry=https://registry.npmjs.org/
npm view @ambicuity/kindx dist-tags --json --registry=https://registry.npmjs.org/
npm view @ambicuity/kindx@X.Y.Z version --registry=https://npm.pkg.github.com
```

Expected:
- npmjs latest = `X.Y.Z`
- npmjs dist-tag `latest` = `X.Y.Z`
- GitHub Packages contains `X.Y.Z`

## 4) Public Surface Spot Check

Check:

- `https://github.com/ambicuity/KINDX/releases`
- `https://github.com/ambicuity/KINDX/pkgs/npm/kindx`
- `https://mcpmarket.com/server/kindx`

Expected:
- GitHub Releases latest = `vX.Y.Z`
- GitHub Packages latest = `X.Y.Z`
- MCP Market content reflects latest release metadata; if version is not rendered, record proof from submission/update logs.
- Marketplace-facing README blocks should avoid heavy Unicode banner glyphs; prefer ASCII-only banner text for renderer compatibility.

## 5) MCP Market Update Procedure (Manual)

If MCP Market does not auto-ingest from repository metadata:

1. Open MCP Market dashboard for `kindx`.
2. Trigger listing update or resubmit metadata from current default branch.
3. Confirm listing content refresh.
4. Record evidence in release notes:
   - Submission/update timestamp (UTC)
   - Listing URL
   - Operator identity
   - Any moderation/indexing ticket ID

## 6) Release Evidence Log

Record the following in release evidence:

- Release version: `X.Y.Z`
- Tag SHA
- GitHub release URL
- npmjs verification output
- GitHub Packages verification output
- MCP Market verification status (`PASS` or `MANUAL STEP NEEDED`)

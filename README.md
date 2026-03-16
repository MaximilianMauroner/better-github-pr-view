# Better GitHub PR View

A minimal Manifest V3 browser extension that enriches GitHub repository pull request lists with native-looking metadata.

## What it does

- Enhances repository `Pull requests` pages on `github.com`
- Injects compact inline metadata that stays close to GitHub's native styling
- Hydrates visible rows only, with in-memory caching and bounded fetch concurrency
- Surfaces commit count, files changed, review state, and recent activity when detectable

## Project structure

```text
assets/
docs/
manifest.json
popup.html
scripts/
src/
  content.css
  content.ts
  popup.css
  popup.ts
```

## Install locally in Chrome

1. Run `bun install`.
2. Run `bun run build:chrome`.
3. Open your Chromium-based browser extension page.
4. Enable Developer Mode.
5. Choose `Load unpacked`.
6. Select:

   `/Users/maximilianmauroner/Documents/GitHub/better-github-pr-view/dist/chrome`

## Install locally in Firefox

1. Run `bun install`.
2. Run `bun run build:firefox`.
3. Open `about:debugging#/runtime/this-firefox`.
4. Choose `Load Temporary Add-on`.
5. Select:

   `/Users/maximilianmauroner/Documents/GitHub/better-github-pr-view/dist/firefox/manifest.json`

## Build and package

1. Install dependencies:

   ```bash
   bun install
   ```

2. Generate icons and placeholder listing media when the SVG templates change:

   ```bash
   bun run assets:generate
   ```

3. Create browser-specific builds:

   ```bash
   bun run build:chrome
   bun run build:firefox
   ```

4. Create upload artifacts:

   ```bash
   bun run pack:chrome
   bun run pack:firefox
   ```

Artifacts are written to:

- `artifacts/better-github-pr-view-chrome-0.1.0.zip`
- `artifacts/better-github-pr-view-firefox-0.1.0.zip`

## Release validation

Run the full release check before uploading to either store:

```bash
bun run check:release
```

This command:

- typechecks the extension and Bun scripts
- builds Chrome and Firefox packages
- runs `web-ext lint` on the Firefox build
- verifies store docs and required assets exist
- creates versioned ZIP artifacts

## GitHub downloads

Every push and pull request uploads the Chrome and Firefox ZIP files as GitHub Actions artifacts. Tagged releases also attach the same ZIP files to the GitHub Release page.

Release flow:

1. Update `package.json` with the next extension version.
2. Push the branch and confirm `bun run check:release` passes locally.
3. Create and push a matching tag:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

4. Download the release assets from:
   - the workflow run artifacts for CI builds
   - the GitHub Release page for tagged versions

The release workflow fails if the pushed tag does not match `package.json`.

## Public submission pages

- Homepage: [`docs/index.md`](./docs/index.md)
- Privacy policy: [`docs/privacy-policy.md`](./docs/privacy-policy.md)
- Support: [`docs/support.md`](./docs/support.md)
- Release checklist: [`docs/release-checklist.md`](./docs/release-checklist.md)

Enable GitHub Pages from the `/docs` directory before submission so those URLs resolve publicly.

## Current scope

This version targets repository-level pull request list pages:

- `https://github.com/<owner>/<repo>/pulls`

It does not currently enrich issue lists or PR detail pages.

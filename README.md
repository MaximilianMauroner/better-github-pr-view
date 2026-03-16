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
  content.js
  popup.css
  popup.js
```

## Install locally in Chrome

1. Open your Chromium-based browser extension page.
2. Enable Developer Mode.
3. Choose `Load unpacked`.
4. Select this repository folder:

   `/Users/maximilianmauroner/Documents/GitHub/better-github-pr-view`

## Install locally in Firefox

1. Run `npm install`.
2. Run `npm run build:firefox`.
3. Open `about:debugging#/runtime/this-firefox`.
4. Choose `Load Temporary Add-on`.
5. Select:

   `/Users/maximilianmauroner/Documents/GitHub/better-github-pr-view/dist/firefox/manifest.json`

## Build and package

1. Install dependencies:

   ```bash
   npm install
   ```

2. Generate icons and placeholder listing media when the SVG templates change:

   ```bash
   npm run assets:generate
   ```

3. Create browser-specific builds:

   ```bash
   npm run build:chrome
   npm run build:firefox
   ```

4. Create upload artifacts:

   ```bash
   npm run pack:chrome
   npm run pack:firefox
   ```

Artifacts are written to:

- `artifacts/better-github-pr-view-chrome-0.1.0.zip`
- `artifacts/better-github-pr-view-firefox-0.1.0.zip`

## Release validation

Run the full release check before uploading to either store:

```bash
npm run check:release
```

This command:

- builds Chrome and Firefox packages
- runs `web-ext lint` on the Firefox build
- verifies store docs and required assets exist
- creates versioned ZIP artifacts

## Manual submission

### Chrome Web Store

1. Register the developer account and pay the one-time registration fee.
2. Upload `artifacts/better-github-pr-view-chrome-0.1.0.zip`.
3. Use the product summary in this README and the submission notes in [`docs/release-checklist.md`](./docs/release-checklist.md) for the store form fields.
4. Upload the final store media from `assets/store/`, replacing the placeholders first.
5. Set:
   - Homepage URL: `https://maximilianmauroner.github.io/better-github-pr-view/`
   - Privacy policy URL: `https://maximilianmauroner.github.io/better-github-pr-view/privacy-policy.html`
   - Support URL: `https://maximilianmauroner.github.io/better-github-pr-view/support.html`
6. Add the final support email in the dashboard.
7. Submit for review.

### Firefox Add-ons

1. Create the add-on entry in AMO.
2. Upload `artifacts/better-github-pr-view-firefox-0.1.0.zip`.
3. Use the product summary in this README and the submission notes in [`docs/release-checklist.md`](./docs/release-checklist.md) for the listing and reviewer fields.
4. Upload the final icon and screenshots, replacing placeholder media first.
5. Set the same homepage, privacy policy, and support URLs as above.
6. Add the final support email in AMO if requested.
7. Submit for review.

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

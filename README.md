# Better GitHub PR View

A minimal Manifest V3 browser extension that enriches GitHub repository pull request lists with native-looking metadata.

## What it does

- Enhances repository `Pull requests` pages on `github.com`
- Injects compact inline metadata that stays close to GitHub's native styling
- Hydrates visible rows only, with in-memory caching and bounded fetch concurrency
- Surfaces commit count, files changed, review state, and recent activity when detectable

## Project structure

```text
manifest.json
popup.html
src/
  content.css
  content.js
  popup.css
  popup.js
```

## Install locally

1. Open your Chromium-based browser extension page.
2. Enable Developer Mode.
3. Choose `Load unpacked`.
4. Select this repository folder:

   `/Users/maximilianmauroner/Documents/GitHub/better-github-pr-view`

## Current scope

This version targets repository-level pull request list pages:

- `https://github.com/<owner>/<repo>/pulls`

It does not currently enrich issue lists or PR detail pages.

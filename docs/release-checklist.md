# Release Checklist

## Repo-managed items

- `bun install`
- `bun run check`
- Enable GitHub Pages from the `/docs` folder so the public URLs resolve
- Confirm the generated artifacts exist in `artifacts/`
- Confirm the latest GitHub Actions run uploaded both ZIP artifacts
- For a store release, push a matching `vX.Y.Z` tag and confirm the GitHub Release page has both ZIP assets attached
- Review the README product summary and update it if the extension scope changes

## Dashboard-only items

- Register a Chrome Web Store developer account and pay the one-time registration fee
- Create or open the Firefox Add-ons listing in AMO
- Add the final support email address required by the dashboards
- Set the homepage, privacy policy, and support URLs to the GitHub Pages URLs
- Upload the final icon and any store screenshots you want to use in each dashboard
- Paste the short description, long description, and reviewer notes based on the README:
  Better GitHub PR View improves the readability and scanability of GitHub repository pull request list pages with native-looking inline metadata and lightweight row controls.
- Select the final category in each store dashboard
- Submit for review

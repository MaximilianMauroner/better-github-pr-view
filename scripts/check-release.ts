import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { readPackageManifest, repoRoot } from "./common.js";

const requiredFiles = [
  "docs/index.md",
  "docs/privacy-policy.md",
  "docs/support.md",
  "docs/release-checklist.md",
  "assets/README.md",
  "assets/extension-icons/icon-16.png",
  "assets/extension-icons/icon-32.png",
  "assets/extension-icons/icon-48.png",
  "assets/extension-icons/icon-96.png",
  "assets/extension-icons/icon-128.png"
];

async function assertFile(relativePath: string) {
  await access(path.join(repoRoot, relativePath));
}

async function main() {
  const packageManifest = await readPackageManifest();
  await Promise.all(requiredFiles.map(assertFile));

  const chromeManifest = JSON.parse(await readFile(path.join(repoRoot, "dist", "chrome", "manifest.json"), "utf8")) as Record<string, any>;
  const firefoxManifest = JSON.parse(await readFile(path.join(repoRoot, "dist", "firefox", "manifest.json"), "utf8")) as Record<string, any>;

  if (chromeManifest.version !== packageManifest.version || firefoxManifest.version !== packageManifest.version) {
    throw new Error("Build outputs must use the version declared in package.json.");
  }

  if (!chromeManifest.icons?.["128"]) {
    throw new Error("Chrome build is missing a 128px icon.");
  }

  if (firefoxManifest.browser_specific_settings?.gecko?.id !== "better-github-pr-view@maximilianmauroner.github.io") {
    throw new Error("Firefox build is missing the expected Gecko add-on ID.");
  }

  if (firefoxManifest.browser_specific_settings?.gecko?.strict_min_version !== "142.0") {
    throw new Error("Firefox build must target Firefox 142.0 or later to support data_collection_permissions across Firefox platforms.");
  }

  const firefoxPermissions = firefoxManifest.browser_specific_settings?.gecko?.data_collection_permissions;
  if (!firefoxPermissions || firefoxPermissions.required?.join(",") !== "none") {
    throw new Error("Firefox build must declare data_collection_permissions.required = ['none'].");
  }

  console.log("Release checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

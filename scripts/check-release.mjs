import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

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
  "assets/extension-icons/icon-128.png",
  "assets/store/chrome-promo-440x280.png",
  "assets/store/chrome-screenshot-1280x800.png"
];

async function assertFile(relativePath) {
  await access(path.join(repoRoot, relativePath));
}

async function main() {
  await Promise.all(requiredFiles.map(assertFile));

  const chromeManifest = JSON.parse(await readFile(path.join(repoRoot, "dist", "chrome", "manifest.json"), "utf8"));
  const firefoxManifest = JSON.parse(await readFile(path.join(repoRoot, "dist", "firefox", "manifest.json"), "utf8"));

  if (!chromeManifest.icons?.["128"]) {
    throw new Error("Chrome build is missing a 128px icon.");
  }

  if (firefoxManifest.browser_specific_settings?.gecko?.id !== "better-github-pr-view@maximilianmauroner.github.io") {
    throw new Error("Firefox build is missing the expected Gecko add-on ID.");
  }

  const firefoxPermissions = firefoxManifest.browser_specific_settings?.gecko?.data_collection_permissions;
  if (!firefoxPermissions || firefoxPermissions.required?.join(",") !== "none") {
    throw new Error("Firefox build must declare data_collection_permissions.required = ['none'].");
  }

  console.log("Release checks passed.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

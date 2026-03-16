import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const browser = process.argv[2];

if (!["chrome", "firefox"].includes(browser)) {
  console.error("Usage: node scripts/build.mjs <chrome|firefox>");
  process.exit(1);
}

const buildDir = path.join(repoRoot, "dist", browser);
const sharedManifestPath = path.join(repoRoot, "manifest.json");

const firefoxSettings = {
  gecko: {
    id: "better-github-pr-view@maximilianmauroner.github.io",
    strict_min_version: "128.0"
  }
};

const firefoxDataCollectionPermissions = {
  required: ["none"],
  optional: []
};

async function main() {
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });

  await Promise.all([
    cp(path.join(repoRoot, "src"), path.join(buildDir, "src"), { recursive: true }),
    cp(path.join(repoRoot, "assets", "extension-icons"), path.join(buildDir, "assets", "extension-icons"), { recursive: true }),
    cp(path.join(repoRoot, "popup.html"), path.join(buildDir, "popup.html"))
  ]);

  const manifest = JSON.parse(await readFile(sharedManifestPath, "utf8"));

  if (browser === "firefox") {
    manifest.browser_specific_settings = firefoxSettings;
    manifest.browser_specific_settings.gecko.data_collection_permissions = firefoxDataCollectionPermissions;
  } else {
    delete manifest.browser_specific_settings;
  }

  await writeFile(path.join(buildDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Built ${browser} bundle at ${path.relative(repoRoot, buildDir)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});


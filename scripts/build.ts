import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertBrowser, readPackageManifest, repoRoot } from "./common.js";

const browser = assertBrowser(process.argv[2]);
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

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function main() {
  const packageManifest = await readPackageManifest();

  await rm(buildDir, { recursive: true, force: true });
  await mkdir(path.join(buildDir, "src"), { recursive: true });

  await Promise.all([
    cp(path.join(repoRoot, "src", "content.css"), path.join(buildDir, "src", "content.css")),
    cp(path.join(repoRoot, "src", "popup.css"), path.join(buildDir, "src", "popup.css")),
    cp(path.join(repoRoot, "assets", "extension-icons"), path.join(buildDir, "assets", "extension-icons"), { recursive: true }),
    cp(path.join(repoRoot, "popup.html"), path.join(buildDir, "popup.html"))
  ]);

  const manifest = JSON.parse(await readFile(sharedManifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = packageManifest.version;

  if (browser === "firefox") {
    manifest.browser_specific_settings = firefoxSettings;
    (manifest.browser_specific_settings as typeof firefoxSettings & {
      gecko: typeof firefoxSettings.gecko & {
        data_collection_permissions?: typeof firefoxDataCollectionPermissions;
      };
    }).gecko.data_collection_permissions = firefoxDataCollectionPermissions;
  } else {
    delete manifest.browser_specific_settings;
  }

  await Promise.all([
    run("bun", [
      "build",
      path.join(repoRoot, "src", "content.ts"),
      "--outfile",
      path.join(buildDir, "src", "content.js"),
      "--target",
      "browser"
    ]),
    run("bun", [
      "build",
      path.join(repoRoot, "src", "popup.ts"),
      "--outfile",
      path.join(buildDir, "src", "popup.js"),
      "--target",
      "browser"
    ])
  ]);

  await writeFile(path.join(buildDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Built ${browser} bundle at ${path.relative(repoRoot, buildDir)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

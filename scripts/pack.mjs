import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const browser = process.argv[2];

if (!["chrome", "firefox"].includes(browser)) {
  console.error("Usage: node scripts/pack.mjs <chrome|firefox>");
  process.exit(1);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });

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
  const manifestPath = path.join(repoRoot, "dist", browser, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const slug = manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const artifactDir = path.join(repoRoot, "artifacts");
  const artifactName = `${slug}-${browser}-${manifest.version}.zip`;
  const artifactPath = path.join(artifactDir, artifactName);

  await mkdir(artifactDir, { recursive: true });
  await rm(artifactPath, { force: true });
  await run("zip", ["-rq", artifactPath, "."], path.join(repoRoot, "dist", browser));

  console.log(`Created ${path.relative(repoRoot, artifactPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});


import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertBrowser, buildArtifactSlug, repoRoot } from "./common.js";

const browser = assertBrowser(process.argv[2]);

function run(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
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
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    name: string;
    version: string;
  };
  const slug = buildArtifactSlug(manifest.name);
  const artifactDir = path.join(repoRoot, "artifacts");
  const artifactName = `${slug}-${browser}-${manifest.version}.zip`;
  const artifactPath = path.join(artifactDir, artifactName);

  await mkdir(artifactDir, { recursive: true });
  await rm(artifactPath, { force: true });
  await run("zip", ["-rq", artifactPath, "."], path.join(repoRoot, "dist", browser));

  console.log(`Created ${path.relative(repoRoot, artifactPath)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

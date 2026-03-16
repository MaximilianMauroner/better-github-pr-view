import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { repoRoot } from "./common.js";

const jobs = [
  {
    input: "assets/source/icon.svg",
    output: "assets/extension-icons/icon-16.png",
    width: 16,
    height: 16,
    renderer: "sips"
  },
  {
    input: "assets/source/icon.svg",
    output: "assets/extension-icons/icon-32.png",
    width: 32,
    height: 32,
    renderer: "sips"
  },
  {
    input: "assets/source/icon.svg",
    output: "assets/extension-icons/icon-48.png",
    width: 48,
    height: 48,
    renderer: "sips"
  },
  {
    input: "assets/source/icon.svg",
    output: "assets/extension-icons/icon-96.png",
    width: 96,
    height: 96,
    renderer: "sips"
  },
  {
    input: "assets/source/icon.svg",
    output: "assets/extension-icons/icon-128.png",
    width: 128,
    height: 128,
    renderer: "sips"
  }
] as const;

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

async function renderWithSips(input: string, output: string, width: number, height: number): Promise<void> {
  await run("sips", ["-s", "format", "png", input, "--out", output]);
  await run("sips", ["-z", String(height), String(width), output]);
}

async function main() {
  for (const job of jobs) {
    const inputPath = path.join(repoRoot, job.input);
    const outputPath = path.join(repoRoot, job.output);

    await mkdir(path.join(repoRoot, path.dirname(job.output)), { recursive: true });

    await renderWithSips(inputPath, outputPath, job.width, job.height);
  }

  console.log("Generated extension icons.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

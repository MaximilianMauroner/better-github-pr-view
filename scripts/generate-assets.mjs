import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const jobs = [
  {
    input: "assets/source/icon.svg",
    output: "assets/extension-icons/icon-16.png",
    width: 16,
    height: 16
  },
  {
    input: "assets/source/icon.svg",
    output: "assets/extension-icons/icon-32.png",
    width: 32,
    height: 32
  },
  {
    input: "assets/source/icon.svg",
    output: "assets/extension-icons/icon-48.png",
    width: 48,
    height: 48
  },
  {
    input: "assets/source/icon.svg",
    output: "assets/extension-icons/icon-96.png",
    width: 96,
    height: 96
  },
  {
    input: "assets/source/icon.svg",
    output: "assets/extension-icons/icon-128.png",
    width: 128,
    height: 128
  },
  {
    input: "assets/source/chrome-promo-440x280.svg",
    output: "assets/store/chrome-promo-440x280.png",
    width: 440,
    height: 280
  },
  {
    input: "assets/source/chrome-screenshot-1280x800.svg",
    output: "assets/store/chrome-screenshot-1280x800.png",
    width: 1280,
    height: 800
  }
];

function run(command, args) {
  return new Promise((resolve, reject) => {
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
  for (const job of jobs) {
    await mkdir(path.join(repoRoot, path.dirname(job.output)), { recursive: true });
    await run("sips", [
      "-s",
      "format",
      "png",
      job.input,
      "--out",
      job.output
    ]);
    await run("sips", ["-z", String(job.height), String(job.width), job.output]);
  }

  console.log("Generated extension and listing assets.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

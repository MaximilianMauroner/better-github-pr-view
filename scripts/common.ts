import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(__dirname, "..");

interface PackageManifest {
  name: string;
  version: string;
}

export async function readPackageManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as PackageManifest;
}

export function assertBrowser(browser: string | undefined): "chrome" | "firefox" {
  if (browser !== "chrome" && browser !== "firefox") {
    throw new Error("Usage: bun run scripts/<file>.ts <chrome|firefox>");
  }

  return browser;
}

export function buildArtifactSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

import { readFile } from "node:fs/promises";
import path from "node:path";

const fixturesDir = path.join(process.cwd(), "tests", "fixtures");

export async function loadFixtureDocument(name: string): Promise<Document> {
  const html = await readFile(path.join(fixturesDir, name), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

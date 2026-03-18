import { describe, expect, it } from "vitest";
import { getBaseRows, parseBaseRow } from "../src/content/dom";
import { loadFixtureDocument } from "./helpers/fixtures";

describe("PR row parsing", () => {
  it("parses modern GitHub PR list rows", async () => {
    const modernDocument = await loadFixtureDocument("pr-list-modern.html");
    const [row] = getBaseRows(modernDocument);

    expect(row.prUrl).toBe("https://github.com/octocat/hello-world/pull/42");
    expect(row.number).toBe("42");
    expect(row.usesStackedMetadata).toBe(true);
  });

  it("parses classic GitHub PR list rows", async () => {
    const classicDocument = await loadFixtureDocument("pr-list-classic.html");
    const rowElement = classicDocument.querySelector(".js-issue-row");

    expect(rowElement).not.toBeNull();

    const row = parseBaseRow(rowElement!);
    expect(row).not.toBeNull();
    expect(row?.prUrl).toBe("https://github.com/octocat/hello-world/pull/51");
    expect(row?.usesStackedMetadata).toBe(false);
  });
});

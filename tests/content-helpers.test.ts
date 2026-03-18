import { describe, expect, it } from "vitest";
import {
  extractCommitCountFallback,
  extractEmbeddedDetailMetrics,
  extractFilesChangedCount,
  extractLatestActivityAt
} from "../src/content/extractors";
import { formatBranchSummary, parseCountValue } from "../src/content/text";
import { loadFixtureDocument } from "./helpers/fixtures";

describe("content helper parsing", () => {
  it("parses humanized count values", () => {
    expect(parseCountValue("1.2k")).toBe(1200);
    expect(parseCountValue("2,145")).toBe(2145);
    expect(parseCountValue("")).toBeNull();
  });

  it("formats branch summaries for same-owner branches", () => {
    expect(formatBranchSummary("octocat", "feature/refactor", "octocat", "main")).toBe("feature/refactor -> main");
  });
});

describe("GitHub document extractors", () => {
  it("extracts embedded detail metrics and latest activity", async () => {
    const detailDocument = await loadFixtureDocument("pr-detail.html");

    expect(extractEmbeddedDetailMetrics(detailDocument)).toEqual({
      branchSummary: "feature/refactor -> main",
      commitCount: 12
    });
    expect(extractLatestActivityAt(detailDocument)).toBe("2026-03-17T14:30:00.000Z");
  });

  it("falls back to commit and file counters in the DOM", async () => {
    const detailDocument = await loadFixtureDocument("pr-detail.html");
    const filesDocument = await loadFixtureDocument("pr-files.html");

    expect(extractCommitCountFallback(detailDocument)).toBe(12);
    expect(extractFilesChangedCount(filesDocument)).toBe(128);
  });
});

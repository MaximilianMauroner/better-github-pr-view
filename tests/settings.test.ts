import { describe, expect, it } from "vitest";
import { buildPersistedPayload, CACHE_VERSION, readPersistedPayload } from "../src/shared/cache";
import {
  DEFAULT_AUTO_REFRESH_AFTER_HOURS,
  DEFAULT_SETTINGS,
  MAX_AUTO_REFRESH_AFTER_HOURS,
  mergeSettings,
  MIN_AUTO_REFRESH_AFTER_HOURS,
  sanitizeAutoRefreshAfterHours
} from "../src/shared/settings";

describe("shared settings", () => {
  it("sanitizes the auto-refresh threshold", () => {
    expect(sanitizeAutoRefreshAfterHours(undefined)).toBe(DEFAULT_AUTO_REFRESH_AFTER_HOURS);
    expect(sanitizeAutoRefreshAfterHours(-10)).toBe(MIN_AUTO_REFRESH_AFTER_HOURS);
    expect(sanitizeAutoRefreshAfterHours(999)).toBe(MAX_AUTO_REFRESH_AFTER_HOURS);
    expect(sanitizeAutoRefreshAfterHours(12)).toBe(12);
  });

  it("merges partial settings with defaults", () => {
    const merged = mergeSettings({
      filesChanged: true,
      autoRefreshAfterHours: 24
    });

    expect(merged).toEqual({
      ...DEFAULT_SETTINGS,
      filesChanged: true,
      autoRefreshAfterHours: 24
    });
  });
});

describe("persisted cache payloads", () => {
  it("round-trips a cache entry", () => {
    const payload = buildPersistedPayload({
      prUrl: "https://github.com/octocat/hello-world/pull/42",
      commitCount: 12
    });

    expect(payload.version).toBe(CACHE_VERSION);
    expect(readPersistedPayload(payload)).toEqual(payload.data);
  });

  it("rejects mismatched cache versions", () => {
    expect(readPersistedPayload({ version: CACHE_VERSION + 1, data: { prUrl: "x" } })).toBeNull();
  });
});

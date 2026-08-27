import type { Settings } from "./types";

export const DEFAULT_AUTO_REFRESH_AFTER_HOURS = 6;
export const MIN_AUTO_REFRESH_AFTER_HOURS = 0.5;
export const MAX_AUTO_REFRESH_AFTER_HOURS = 168;

export const DEFAULT_SETTINGS: Settings = {
  prListEnrichment: true,
  branchSummary: true,
  commitCount: true,
  filesChanged: false,
  locChanges: true,
  lastEditedTime: true,
  autoRefreshAfterHours: DEFAULT_AUTO_REFRESH_AFTER_HOURS,
  nativePrNumber: true,
  nativeOpenedTime: true,
  nativeAuthor: true,
  nativeDraft: true,
  nativeTasks: true,
  cacheState: false
};

export const BOOLEAN_SETTING_KEYS = [
  "prListEnrichment",
  "branchSummary",
  "commitCount",
  "filesChanged",
  "locChanges",
  "lastEditedTime",
  "nativePrNumber",
  "nativeOpenedTime",
  "nativeAuthor",
  "nativeDraft",
  "nativeTasks",
  "cacheState"
] as const satisfies ReadonlyArray<keyof Settings>;

export function sanitizeAutoRefreshAfterHours(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_AUTO_REFRESH_AFTER_HOURS;
  }

  return Math.min(MAX_AUTO_REFRESH_AFTER_HOURS, Math.max(MIN_AUTO_REFRESH_AFTER_HOURS, value));
}

export function mergeSettings(settings?: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...(settings ?? {}),
    autoRefreshAfterHours: sanitizeAutoRefreshAfterHours(settings?.autoRefreshAfterHours)
  };
}

interface Settings {
  prListEnrichment: boolean;
  locChanges: boolean;
  lastEditedTime: boolean;
  nativePrNumber: boolean;
  nativeOpenedTime: boolean;
  nativeAuthor: boolean;
  nativeTasks: boolean;
  cacheState: boolean;
}

interface LocChanges {
  additions: number;
  deletions: number;
}

interface HydratedPrData {
  prUrl: string;
  locChanges?: LocChanges | null;
  codeMetricsAttemptedAt?: string | null;
  lastActivityAt?: string | null;
  lastActivityAttemptedAt?: string | null;
  fetchedAt?: string | null;
}

interface PersistedPayload {
  version: number;
  data: HydratedPrData;
}

interface LocMetricsResult {
  locChanges: LocChanges | null;
  codeMetricsAttemptedAt: string;
}

interface LastEditedMetricsResult {
  lastActivityAt: string | null;
  lastActivityAttemptedAt: string;
}

interface CacheEntry {
  data: HydratedPrData | null;
  loadedFromStorage: boolean;
  filesPromise: Promise<LocMetricsResult | null> | null;
  detailPromise: Promise<LastEditedMetricsResult | null> | null;
  isRefreshing: boolean;
  refreshUiMode: "interactive" | null;
  lastAutoRefreshAt: number;
  lastRefreshErrorAt: number | null;
}

interface BaseRow {
  row: Element;
  titleLink: HTMLAnchorElement;
  metaNode: HTMLElement | null;
  insertionPoint: Element;
  prUrl: string;
  number: string | null;
  isDraft: boolean;
}

interface NativeMetaSnapshot {
  node: HTMLElement;
  originalNodes: Node[];
  numberText: string | null;
  timeNode: Node | null;
  authorNode: Node | null;
}

type StorageArea = "local" | "sync";
type FreshnessState = "fresh" | "soft_stale" | "hard_stale";

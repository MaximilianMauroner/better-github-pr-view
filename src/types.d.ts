interface Settings {
  prListEnrichment: boolean;
  branchSummary: boolean;
  commitCount: boolean;
  filesChanged: boolean;
  locChanges: boolean;
  lastEditedTime: boolean;
  autoRefreshAfterHours: number;
  nativePrNumber: boolean;
  nativeOpenedTime: boolean;
  nativeAuthor: boolean;
  nativeDraft: boolean;
  nativeTasks: boolean;
  cacheState: boolean;
}

interface LocChanges {
  additions: number;
  deletions: number;
}

interface HydratedPrData {
  prUrl: string;
  branchSummary?: string | null;
  commitCount?: number | null;
  filesChanged?: number | null;
  locChanges?: LocChanges | null;
  detailMetricsAttemptedAt?: string | null;
  codeMetricsAttemptedAt?: string | null;
  lastActivityAt?: string | null;
  filesChangedAttemptedAt?: string | null;
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

interface DetailMetricsResult {
  branchSummary: string | null;
  commitCount: number | null;
  lastActivityAt: string | null;
  detailMetricsAttemptedAt: string;
}

interface FilesChangedMetricsResult {
  filesChanged: number | null;
  filesChangedAttemptedAt: string;
}

interface CacheEntry {
  data: HydratedPrData | null;
  loadedFromStorage: boolean;
  locMetricsPromise: Promise<LocMetricsResult | null> | null;
  detailPromise: Promise<DetailMetricsResult | null> | null;
  filesChangedPromise: Promise<FilesChangedMetricsResult | null> | null;
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
  usesStackedMetadata: boolean;
  prUrl: string;
  number: string | null;
  isDraft: boolean;
}

interface NativeMetaSnapshot {
  node: HTMLElement;
  originalNodes: Node[];
  numberText: string | null;
  stateText: string;
  timeNode: Node | null;
  authorNode: Node | null;
}

type StorageArea = "local" | "sync";
type FreshnessState = "fresh" | "soft_stale" | "hard_stale";

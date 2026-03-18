import type {
  BaseRow,
  CacheEntry,
  DetailMetricsResult,
  FilesChangedMetricsResult,
  FreshnessState,
  HydratedPrData,
  LocMetricsResult,
  NativeMetaSnapshot,
  Settings
} from "../shared/types";
import {
  buildPersistedPayload,
  CACHE_BUST_SIGNAL_KEY,
  getStorageKey,
  readPersistedPayload
} from "../shared/cache";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  sanitizeAutoRefreshAfterHours
} from "../shared/settings";
import {
  AUTO_REFRESH_COOLDOWN_MS,
  AUTO_REFRESH_ERROR_COOLDOWN_MS,
  FRESH_CACHE_MS,
  HYDRATION_ROOT_MARGIN_PX,
  MAX_CONCURRENT_FETCHES
} from "./constants";
import { fetchDetailMetrics, fetchFilesChangedMetrics, fetchLocMetrics } from "./data";
import { getBaseRows, getPageKey, isPullListPage, parseBaseRow } from "./dom";
import { FetchQueue } from "./fetchQueue";
import { createRowRenderer } from "./render";
import { chromeStorageGet, chromeStorageSet } from "./storage";
import { formatRelativeTime } from "./text";

export function bootstrapContent(): void {
  createContentApp().bootstrap();
}

function createContentApp() {
  const hydrationCache = new Map<string, CacheEntry>();
  const nativeMetaCache = new Map<Element, NativeMetaSnapshot>();
  const fetchQueue = new FetchQueue(MAX_CONCURRENT_FETCHES);

  let settings: Settings = { ...DEFAULT_SETTINGS };
  let refreshTimer: number | null = null;
  let currentPageKey = "";
  let renderEpoch = 0;
  let intersectionObserver: IntersectionObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let observedRows = new WeakSet<Element>();

  function ensureCacheEntry(prUrl: string): CacheEntry {
    let entry = hydrationCache.get(prUrl);
    if (!entry) {
      entry = {
        data: null,
        loadedFromStorage: false,
        locMetricsPromise: null,
        detailPromise: null,
        filesChangedPromise: null,
        isRefreshing: false,
        refreshUiMode: null,
        lastAutoRefreshAt: 0,
        lastRefreshErrorAt: null
      };
      hydrationCache.set(prUrl, entry);
    }

    return entry;
  }

  function getFetchedAt(data: HydratedPrData | null): string | null {
    return data?.fetchedAt || null;
  }

  function getFreshnessAgeMs(data: HydratedPrData | null): number {
    const fetchedAt = getFetchedAt(data);
    if (!fetchedAt) {
      return Number.POSITIVE_INFINITY;
    }

    const timestamp = Date.parse(fetchedAt);
    if (!Number.isFinite(timestamp)) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.max(0, Date.now() - timestamp);
  }

  function getAutoRefreshThresholdMs(): number {
    return sanitizeAutoRefreshAfterHours(settings.autoRefreshAfterHours) * 60 * 60 * 1000;
  }

  function getFreshnessState(data: HydratedPrData | null): FreshnessState {
    const ageMs = getFreshnessAgeMs(data);
    if (ageMs <= FRESH_CACHE_MS) {
      return "fresh";
    }

    if (ageMs <= getAutoRefreshThresholdMs()) {
      return "soft_stale";
    }

    return "hard_stale";
  }

  function describeFreshness(
    data: HydratedPrData | null,
    cacheEntry: CacheEntry
  ): { text: string; tone: string; freshness: FreshnessState } | null {
    if (!data?.fetchedAt) {
      return null;
    }

    if (cacheEntry.refreshUiMode === "interactive") {
      return {
        text: "refreshing...",
        tone: "refreshing",
        freshness: getFreshnessState(data)
      };
    }

    const ageMs = getFreshnessAgeMs(data);
    const ageLabel = ageMs < 90 * 1000 ? "just now" : formatRelativeTime(data.fetchedAt);
    if (!ageLabel) {
      return null;
    }

    const freshness = getFreshnessState(data);
    return {
      text: freshness === "hard_stale" ? `stale ${ageLabel}` : `cached ${ageLabel}`,
      tone: freshness === "hard_stale" ? "stale" : "cached",
      freshness
    };
  }

  const rowRenderer = createRowRenderer({
    getSettings: () => settings,
    nativeMetaCache,
    describeFreshness,
    onRefreshRow: (row, options) => refreshRow(row, options)
  });

  function hasCompleteCachedData(data: HydratedPrData | null): boolean {
    if (!data) {
      return false;
    }

    if (settings.locChanges && !data.codeMetricsAttemptedAt) {
      return false;
    }

    if ((settings.lastEditedTime || settings.commitCount || settings.branchSummary) && !data.detailMetricsAttemptedAt) {
      return false;
    }

    if (settings.filesChanged && !data.filesChangedAttemptedAt) {
      return false;
    }

    return true;
  }

  function shouldFetchCodeMetrics(data: HydratedPrData | null, forceRefresh: boolean): boolean {
    if (!settings.locChanges) {
      return false;
    }

    if (forceRefresh) {
      return true;
    }

    return !data?.codeMetricsAttemptedAt;
  }

  function shouldFetchDetailMetrics(data: HydratedPrData | null, forceRefresh: boolean): boolean {
    if (!settings.lastEditedTime && !settings.commitCount && !settings.branchSummary) {
      return false;
    }

    if (forceRefresh) {
      return true;
    }

    return !data?.detailMetricsAttemptedAt;
  }

  function shouldFetchFilesChanged(data: HydratedPrData | null, forceRefresh: boolean): boolean {
    if (!settings.filesChanged) {
      return false;
    }

    if (forceRefresh) {
      return true;
    }

    return !data?.filesChangedAttemptedAt;
  }

  function shouldSkipAutoRefresh(cacheEntry: CacheEntry): boolean {
    if (!cacheEntry.data || cacheEntry.isRefreshing) {
      return true;
    }

    if (getFreshnessAgeMs(cacheEntry.data) < getAutoRefreshThresholdMs()) {
      return true;
    }

    const now = Date.now();
    if (cacheEntry.lastAutoRefreshAt && now - cacheEntry.lastAutoRefreshAt < AUTO_REFRESH_COOLDOWN_MS) {
      return true;
    }

    if (cacheEntry.lastRefreshErrorAt && now - cacheEntry.lastRefreshErrorAt < AUTO_REFRESH_ERROR_COOLDOWN_MS) {
      return true;
    }

    return false;
  }

  function resetPageState(): void {
    renderEpoch += 1;
    rowRenderer.removeInjectedMetadata();
    rowRenderer.restoreNativeMetadata();
    document.body.classList.remove("bgpv-pr-list-active");
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }

    mutationObserver?.disconnect();
    observedRows = new WeakSet();
    hydrationCache.clear();
    nativeMetaCache.clear();
  }

  function canRenderForEpoch(epoch: number): boolean {
    return epoch === renderEpoch && isPullListPage() && settings.prListEnrichment;
  }

  function createObserver(): void {
    if (intersectionObserver) {
      return;
    }

    intersectionObserver = new IntersectionObserver(onRowIntersection, {
      root: null,
      rootMargin: `${HYDRATION_ROOT_MARGIN_PX}px 0px`,
      threshold: 0
    });
  }

  function observeRows(baseRows: BaseRow[]): void {
    createObserver();

    baseRows.forEach(({ row }) => {
      if (observedRows.has(row)) {
        return;
      }

      observedRows.add(row);
      intersectionObserver?.observe(row);
    });
  }

  function onRowIntersection(entries: IntersectionObserverEntry[]): void {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) {
        return;
      }

      hydrateVisibleRow(entry.target);
    });
  }

  function ensureMutationObserver(): void {
    if (mutationObserver) {
      return;
    }

    mutationObserver = new MutationObserver((mutations) => {
      if (rowRenderer.shouldIgnoreMutations(mutations)) {
        return;
      }

      scheduleRefresh();
    });
  }

  function getMutationTargets(baseRows: BaseRow[]): Element[] {
    const selectorTargets = [
      ...Array.from(document.querySelectorAll('[data-testid="list-view"]')),
      ...Array.from(document.querySelectorAll(".js-navigation-container"))
    ];

    if (selectorTargets.length > 0) {
      return Array.from(new Set(selectorTargets));
    }

    return Array.from(new Set(
      baseRows
        .map(({ row }) => row.parentElement)
        .filter((element): element is HTMLElement => Boolean(element))
    ));
  }

  function syncMutationObserver(baseRows: BaseRow[]): void {
    if (!isPullListPage() || !settings.prListEnrichment) {
      mutationObserver?.disconnect();
      return;
    }

    const targets = getMutationTargets(baseRows);
    if (targets.length === 0) {
      mutationObserver?.disconnect();
      return;
    }

    ensureMutationObserver();
    mutationObserver?.disconnect();
    targets.forEach((target) => {
      mutationObserver?.observe(target, {
        childList: true,
        subtree: true
      });
    });
  }

  async function warmPersistentCache(baseRows: BaseRow[]): Promise<void> {
    const missing = baseRows
      .filter((baseRow) => !ensureCacheEntry(baseRow.prUrl).loadedFromStorage)
      .map((baseRow) => baseRow.prUrl);

    if (missing.length === 0) {
      return;
    }

    const storageKeys = missing.reduce<Record<string, null>>((accumulator, prUrl) => {
      accumulator[getStorageKey(prUrl)] = null;
      return accumulator;
    }, {});

    const storedValues = await chromeStorageGet("local", storageKeys);

    missing.forEach((prUrl) => {
      const entry = ensureCacheEntry(prUrl);
      const storedPayload = readPersistedPayload(storedValues[getStorageKey(prUrl)]);

      if (storedPayload) {
        entry.data = storedPayload;
      }

      entry.loadedFromStorage = true;
    });
  }

  async function persistHydratedData(prUrl: string, data: HydratedPrData): Promise<void> {
    await chromeStorageSet("local", {
      [getStorageKey(prUrl)]: buildPersistedPayload(data)
    });
  }

  async function getHydratedPrData(prUrl: string, options: { forceRefresh?: boolean } = {}): Promise<HydratedPrData> {
    const { forceRefresh = false } = options;
    const cacheEntry = ensureCacheEntry(prUrl);

    if (!forceRefresh && cacheEntry.data && hasCompleteCachedData(cacheEntry.data) && shouldSkipAutoRefresh(cacheEntry)) {
      return cacheEntry.data;
    }

    const needsCodeMetrics = shouldFetchCodeMetrics(cacheEntry.data, forceRefresh);
    const needsDetailMetrics = shouldFetchDetailMetrics(cacheEntry.data, forceRefresh);
    const needsFilesChanged = shouldFetchFilesChanged(cacheEntry.data, forceRefresh);

    if (needsCodeMetrics && !cacheEntry.locMetricsPromise) {
      cacheEntry.locMetricsPromise = fetchQueue.enqueue(() => fetchLocMetrics(prUrl).catch(() => null));
    }

    if (needsDetailMetrics && !cacheEntry.detailPromise) {
      cacheEntry.detailPromise = fetchQueue.enqueue(() => fetchDetailMetrics(prUrl).catch(() => null));
    }

    if (needsFilesChanged && !cacheEntry.filesChangedPromise) {
      cacheEntry.filesChangedPromise = fetchQueue.enqueue(() => fetchFilesChangedMetrics(prUrl).catch(() => null));
    }

    let nextData: HydratedPrData = {
      ...(cacheEntry.data ?? {}),
      prUrl
    };

    if (needsCodeMetrics) {
      let locData: LocMetricsResult | null;
      try {
        locData = await cacheEntry.locMetricsPromise;
      } finally {
        cacheEntry.locMetricsPromise = null;
      }

      if (locData) {
        nextData = {
          ...nextData,
          locChanges: locData.locChanges ?? nextData.locChanges ?? null,
          codeMetricsAttemptedAt: locData.codeMetricsAttemptedAt ?? nextData.codeMetricsAttemptedAt ?? null
        };
      }
    }

    if (needsDetailMetrics) {
      let detailData: DetailMetricsResult | null;
      try {
        detailData = await cacheEntry.detailPromise;
      } finally {
        cacheEntry.detailPromise = null;
      }

      if (detailData) {
        nextData = {
          ...nextData,
          branchSummary: detailData.branchSummary ?? nextData.branchSummary ?? null,
          commitCount: detailData.commitCount ?? nextData.commitCount ?? null,
          lastActivityAt: detailData.lastActivityAt ?? nextData.lastActivityAt ?? null,
          detailMetricsAttemptedAt: detailData.detailMetricsAttemptedAt ?? nextData.detailMetricsAttemptedAt ?? null
        };
      }
    }

    if (needsFilesChanged) {
      let filesChangedData: FilesChangedMetricsResult | null;
      try {
        filesChangedData = await cacheEntry.filesChangedPromise;
      } finally {
        cacheEntry.filesChangedPromise = null;
      }

      if (filesChangedData) {
        nextData = {
          ...nextData,
          filesChanged: filesChangedData.filesChanged ?? nextData.filesChanged ?? null,
          filesChangedAttemptedAt: filesChangedData.filesChangedAttemptedAt ?? nextData.filesChangedAttemptedAt ?? null
        };
      }
    }

    const persistedData = {
      ...nextData,
      fetchedAt: new Date().toISOString()
    };

    cacheEntry.data = persistedData;
    persistHydratedData(prUrl, persistedData).catch(() => {});

    return persistedData;
  }

  function refreshRow(row: Element, options: { interactive?: boolean } = {}): void {
    if (!isPullListPage() || !settings.prListEnrichment || !document.contains(row)) {
      return;
    }

    const { interactive = false } = options;
    const baseRow = parseBaseRow(row);
    if (!baseRow?.prUrl) {
      return;
    }

    const cacheEntry = ensureCacheEntry(baseRow.prUrl);
    if (cacheEntry.isRefreshing) {
      return;
    }

    const pageKeyAtStart = currentPageKey;
    const epochAtStart = renderEpoch;
    const previousData = cacheEntry.data;
    let nextRenderData = previousData;
    let shouldRemoveMetadata = !previousData;

    cacheEntry.isRefreshing = true;
    cacheEntry.refreshUiMode = interactive ? "interactive" : null;
    cacheEntry.lastAutoRefreshAt = Date.now();

    if (interactive && previousData && canRenderForEpoch(epochAtStart)) {
      rowRenderer.renderRowMetadata(baseRow, previousData, cacheEntry);
    }

    getHydratedPrData(baseRow.prUrl, { forceRefresh: true })
      .then((hydratedData) => {
        cacheEntry.lastRefreshErrorAt = null;
        nextRenderData = hydratedData;
        shouldRemoveMetadata = false;
      })
      .catch(() => {
        cacheEntry.lastRefreshErrorAt = Date.now();
        nextRenderData = previousData;
        shouldRemoveMetadata = !previousData;
      })
      .finally(() => {
        cacheEntry.isRefreshing = false;
        cacheEntry.refreshUiMode = null;

        if (!document.contains(row) || currentPageKey !== pageKeyAtStart || !canRenderForEpoch(epochAtStart)) {
          return;
        }

        if (shouldRemoveMetadata || !nextRenderData) {
          rowRenderer.removeRowMetadata(row);
          return;
        }

        rowRenderer.renderRowMetadata(baseRow, nextRenderData, cacheEntry);
      });
  }

  async function hydrateVisibleRow(row: Element): Promise<void> {
    if (!isPullListPage() || !settings.prListEnrichment || !document.contains(row)) {
      return;
    }

    const baseRow = parseBaseRow(row);
    if (!baseRow?.prUrl) {
      return;
    }

    const pageKeyAtStart = currentPageKey;
    const epochAtStart = renderEpoch;
    const cacheEntry = ensureCacheEntry(baseRow.prUrl);

    if (cacheEntry.data && canRenderForEpoch(epochAtStart)) {
      rowRenderer.renderRowMetadata(baseRow, cacheEntry.data, cacheEntry);
    }

    if (cacheEntry.data && !shouldSkipAutoRefresh(cacheEntry)) {
      refreshRow(row);
      return;
    }

    try {
      const hydratedData = await getHydratedPrData(baseRow.prUrl);
      if (!document.contains(row) || currentPageKey !== pageKeyAtStart || !canRenderForEpoch(epochAtStart)) {
        return;
      }

      rowRenderer.renderRowMetadata(baseRow, hydratedData, cacheEntry);
    } catch {
      if (cacheEntry.data && canRenderForEpoch(epochAtStart)) {
        rowRenderer.renderRowMetadata(baseRow, cacheEntry.data, cacheEntry);
        return;
      }

      rowRenderer.removeRowMetadata(row);
    }
  }

  function refresh(): void {
    const nextPageKey = getPageKey();
    if (nextPageKey !== currentPageKey) {
      currentPageKey = nextPageKey;
      resetPageState();
    }

    if (!isPullListPage() || !settings.prListEnrichment) {
      resetPageState();
      return;
    }

    document.body.classList.add("bgpv-pr-list-active");
    const initialBaseRows = getBaseRows();
    syncMutationObserver(initialBaseRows);

    warmPersistentCache(initialBaseRows)
      .catch(() => {})
      .finally(() => {
        const baseRows = getBaseRows();
        baseRows.forEach((baseRow) => {
          rowRenderer.applyNativeRowSettings(baseRow);
          const cacheEntry = ensureCacheEntry(baseRow.prUrl);
          if (cacheEntry.data) {
            rowRenderer.renderRowMetadata(baseRow, cacheEntry.data, cacheEntry);
            return;
          }

          rowRenderer.removeRowMetadata(baseRow.row);
        });

        observeRows(baseRows);
        syncMutationObserver(baseRows);
      });
  }

  function scheduleRefresh(): void {
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer);
    }

    refreshTimer = window.setTimeout(refresh, 120);
  }

  function invalidateHydrationState(): void {
    resetPageState();
    scheduleRefresh();
  }

  function installObservers(): void {
    document.addEventListener("turbo:load", scheduleRefresh);
    document.addEventListener("pjax:end", scheduleRefresh);
    window.addEventListener("popstate", scheduleRefresh);
  }

  function bootstrap(): void {
    chrome.storage.sync.get({ bgpvSettings: DEFAULT_SETTINGS }, (result) => {
      settings = mergeSettings(result.bgpvSettings as Partial<Settings> | undefined);
      refresh();
      installObservers();
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "sync" && changes.bgpvSettings) {
        settings = mergeSettings(changes.bgpvSettings.newValue as Partial<Settings> | undefined);
        scheduleRefresh();
        return;
      }

      if (areaName === "sync" && changes[CACHE_BUST_SIGNAL_KEY]) {
        invalidateHydrationState();
      }
    });
  }

  return { bootstrap };
}

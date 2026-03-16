(function () {
  interface DiffstatPayload {
    diffstat?: {
      linesAdded?: number;
      linesDeleted?: number;
    };
  }

  interface FetchQueueItem<T> {
    taskFactory: () => Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  }

  const DEFAULT_SETTINGS: Settings = {
    prListEnrichment: true,
    locChanges: true,
    lastEditedTime: true,
    nativePrNumber: true,
    nativeOpenedTime: true,
    nativeAuthor: true,
    nativeTasks: true,
    cacheState: false
  };

  const SELECTORS = {
    modernRows: '[data-testid="list-view"] li[class*="ListItem-module__listItem"]',
    classicRows: 'div[id^="issue_"].js-issue-row',
    modernTitleLink: '[data-testid="issue-pr-title-link"]',
    classicTitleLink: 'a.markdown-title',
    modernMeta: '[data-testid="created-at"]',
    classicMeta: '.opened-by'
  };

  const MAX_CONCURRENT_FETCHES = 4;
  const HYDRATION_ROOT_MARGIN_PX = 320;
  const CACHE_VERSION = 9;
  const FRESH_CACHE_MS = 5 * 60 * 1000;
  const HARD_STALE_MS = 30 * 60 * 1000;
  const AUTO_REFRESH_COOLDOWN_MS = 2 * 60 * 1000;
  const AUTO_REFRESH_ERROR_COOLDOWN_MS = 5 * 60 * 1000;
  const MANAGED_NATIVE_META_ATTR = "data-bgpv-managed-native-meta";
  const CACHE_BUST_SIGNAL_KEY = "bgpvCacheBustAt";

  const hydrationCache = new Map<string, CacheEntry>();
  const nativeMetaCache = new Map<Element, NativeMetaSnapshot>();
  let settings: Settings = { ...DEFAULT_SETTINGS };
  let refreshTimer: number | null = null;
  let currentPageKey = "";
  let renderEpoch = 0;
  let intersectionObserver: IntersectionObserver | null = null;
  let observedRows = new WeakSet<Element>();
  let activeFetches = 0;
  const fetchQueue: FetchQueueItem<LocMetricsResult | LastEditedMetricsResult | null>[] = [];

  function getStorageArea(area: StorageArea): chrome.storage.StorageArea {
    return area === "local" ? chrome.storage.local : chrome.storage.sync;
  }

  function getStorageKey(prUrl: string): string {
    return `bgpv:pr:${prUrl}`;
  }

  function ensureCacheEntry(prUrl: string): CacheEntry {
    let entry = hydrationCache.get(prUrl);
    if (!entry) {
      entry = {
        data: null,
        loadedFromStorage: false,
        filesPromise: null,
        detailPromise: null,
        isRefreshing: false,
        refreshUiMode: null,
        lastAutoRefreshAt: 0,
        lastRefreshErrorAt: null
      };
      hydrationCache.set(prUrl, entry);
    }

    return entry;
  }

  function chromeStorageGet(
    area: StorageArea,
    keys: string[] | Record<string, unknown> | null
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      getStorageArea(area).get(keys, (items) => resolve(items as Record<string, unknown>));
    });
  }

  function chromeStorageSet(area: StorageArea, value: Record<string, unknown>): Promise<void> {
    return new Promise((resolve) => {
      getStorageArea(area).set(value, () => resolve());
    });
  }

  function hasCompleteCachedData(data: HydratedPrData | null): boolean {
    if (!data) {
      return false;
    }

    if (settings.locChanges && !data.codeMetricsAttemptedAt) {
      return false;
    }

    if (settings.lastEditedTime && !data.lastActivityAttemptedAt) {
      return false;
    }

    return true;
  }

  function buildPersistedPayload(data: HydratedPrData): PersistedPayload {
    return {
      version: CACHE_VERSION,
      data
    };
  }

  function readPersistedPayload(payload: unknown): HydratedPrData | null {
    const typedPayload = payload as Partial<PersistedPayload> | null;
    if (!typedPayload || typedPayload.version !== CACHE_VERSION || !typedPayload.data) {
      return null;
    }

    return typedPayload.data;
  }

  function isPullListPage() {
    return /^\/[^/]+\/[^/]+\/pulls\/?$/.test(window.location.pathname);
  }

  function getPageKey() {
    return `${window.location.pathname}${window.location.search}`;
  }

  function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
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

  function getFreshnessState(data: HydratedPrData | null): FreshnessState {
    const ageMs = getFreshnessAgeMs(data);
    if (ageMs <= FRESH_CACHE_MS) {
      return "fresh";
    }

    if (ageMs <= HARD_STALE_MS) {
      return "soft_stale";
    }

    return "hard_stale";
  }

  function shouldFetchCodeMetrics(data: HydratedPrData | null, forceRefresh: boolean): boolean {
    if (!settings.locChanges) {
      return false;
    }

    if (forceRefresh) {
      return true;
    }

    if (settings.locChanges && !data?.codeMetricsAttemptedAt) {
      return true;
    }

    return false;
  }

  function shouldFetchLastEdited(data: HydratedPrData | null, forceRefresh: boolean): boolean {
    if (!settings.lastEditedTime) {
      return false;
    }

    if (forceRefresh) {
      return true;
    }

    if (!data?.lastActivityAttemptedAt) {
      return true;
    }

    return false;
  }

  function shouldSkipAutoRefresh(cacheEntry: CacheEntry): boolean {
    if (!cacheEntry.data || cacheEntry.isRefreshing) {
      return true;
    }

    if (getFreshnessState(cacheEntry.data) === "fresh") {
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

  function getRows(): Element[] {
    const rows = [
      ...Array.from(document.querySelectorAll(SELECTORS.modernRows)),
      ...Array.from(document.querySelectorAll(SELECTORS.classicRows))
    ];

    return rows.filter((row) => {
      const titleLink = getTitleLink(row);
      return titleLink?.getAttribute("href")?.includes("/pull/");
    });
  }

  function getTitleLink(row: ParentNode): HTMLAnchorElement | null {
    return row.querySelector<HTMLAnchorElement>(SELECTORS.modernTitleLink)
      || row.querySelector<HTMLAnchorElement>(SELECTORS.classicTitleLink);
  }

  function getNativeMetaNode(row: ParentNode): HTMLElement | null {
    return row.querySelector<HTMLElement>(SELECTORS.modernMeta)
      || row.querySelector<HTMLElement>(SELECTORS.classicMeta);
  }

  function isDraftRow(row: ParentNode, metaNode: HTMLElement | null): boolean {
    if (row.querySelector('[aria-label="Draft Pull Request"], .octicon-git-pull-request-draft, [data-status="draft"]')) {
      return true;
    }

    const metaText = normalizeWhitespace(metaNode?.textContent || "");
    return /\bDraft\b/.test(metaText);
  }

  function parseBaseRow(row: Element): BaseRow | null {
    const titleLink = getTitleLink(row);
    if (!titleLink) {
      return null;
    }

    const href = titleLink.getAttribute("href");
    if (!href || !href.includes("/pull/")) {
      return null;
    }

    const prUrl = new URL(href, window.location.origin).toString();
    const numberMatch = href.match(/\/pull\/(\d+)(?:$|[?#/])/);
    const metaNode = getNativeMetaNode(row);
    const insertionPoint = metaNode?.parentElement || titleLink.closest("div") || row;

    return {
      row,
      titleLink,
      metaNode,
      insertionPoint,
      prUrl,
      number: numberMatch ? numberMatch[1] : null,
      isDraft: isDraftRow(row, metaNode)
    };
  }

  function removeInjectedMetadata(target: ParentNode = document): void {
    target.querySelectorAll(".bgpv-inline-meta").forEach((node) => node.remove());
  }

  function buildNativeMetaSegments(baseRow: BaseRow, snapshot: NativeMetaSnapshot): Node[] {
    const segments: Node[] = [];
    const numberText = snapshot.numberText || (baseRow.number ? `#${baseRow.number}` : null);
    const timeNode = snapshot.timeNode?.cloneNode(true) || null;
    const authorNode = snapshot.authorNode?.cloneNode(true) || null;

    if (settings.nativePrNumber && numberText) {
      segments.push(document.createTextNode(numberText));
    }

    if (settings.nativeOpenedTime && timeNode) {
      segments.push(document.createTextNode(segments.length > 0 ? " opened " : "opened "));
      segments.push(timeNode);
    }

    if (settings.nativeAuthor && authorNode) {
      segments.push(document.createTextNode(segments.length > 0 ? " by " : "by "));
      segments.push(authorNode);
    }

    return segments;
  }

  function ensureNativeMetaSnapshot(baseRow: BaseRow): NativeMetaSnapshot | null {
    if (!baseRow.metaNode) {
      return null;
    }

    let snapshot = nativeMetaCache.get(baseRow.row);
    if (snapshot && snapshot.node === baseRow.metaNode) {
      return snapshot;
    }

    const metaNode = baseRow.metaNode;
    metaNode.setAttribute(MANAGED_NATIVE_META_ATTR, "true");
    snapshot = {
      node: metaNode,
      originalNodes: Array.from(metaNode.childNodes, (node: ChildNode) => node.cloneNode(true)),
      numberText: baseRow.number ? `#${baseRow.number}` : (normalizeWhitespace(metaNode.textContent || "").match(/#\d+/)?.[0] || null),
      timeNode: metaNode.querySelector("relative-time"),
      authorNode: metaNode.querySelector("a.Link--muted, a[data-hovercard-type='user'], a[title]")
    };

    nativeMetaCache.set(baseRow.row, snapshot);
    return snapshot;
  }

  function restoreNativeMetadata(target: ParentNode = document): void {
    nativeMetaCache.forEach((snapshot, row) => {
      if (!target.contains(row) || !snapshot.node.isConnected) {
        return;
      }

      snapshot.node.hidden = false;
      snapshot.node.replaceChildren(...snapshot.originalNodes.map((node) => node.cloneNode(true)));
    });

    target.querySelectorAll<HTMLElement>("tracked-issues-progress").forEach((node) => {
      node.hidden = false;
    });
  }

  function applyNativeMetaSettings(baseRow: BaseRow): void {
    const snapshot = ensureNativeMetaSnapshot(baseRow);
    if (!snapshot) {
      return;
    }

    if (settings.nativePrNumber && settings.nativeOpenedTime && settings.nativeAuthor) {
      snapshot.node.hidden = false;
      snapshot.node.replaceChildren(...snapshot.originalNodes.map((node: Node) => node.cloneNode(true)));
      return;
    }

    const segments = buildNativeMetaSegments(baseRow, snapshot);
    snapshot.node.replaceChildren(...segments);
    snapshot.node.hidden = segments.length === 0;
  }

  function applyNativeTaskSettings(baseRow: BaseRow): void {
    const taskProgressNode = baseRow.row.querySelector<HTMLElement>("tracked-issues-progress");
    if (!taskProgressNode) {
      return;
    }

    taskProgressNode.hidden = !settings.nativeTasks;
  }

  function applyNativeRowSettings(baseRow: BaseRow): void {
    applyNativeMetaSettings(baseRow);
    applyNativeTaskSettings(baseRow);
  }

  function removeRowMetadata(row: Element): void {
    row.querySelector(".bgpv-inline-meta")?.remove();
  }

  function isManagedMetaElement(node: Node | null): boolean {
    return node instanceof Element && (
      node.classList.contains("bgpv-inline-meta") ||
      Boolean(node.closest(".bgpv-inline-meta")) ||
      node.getAttribute(MANAGED_NATIVE_META_ATTR) === "true" ||
      Boolean(node.closest(`[${MANAGED_NATIVE_META_ATTR}="true"]`))
    );
  }

  function shouldIgnoreMutations(mutations: MutationRecord[]): boolean {
    return mutations.every((mutation) => {
      const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes]
        .map((node) => (node instanceof Element ? node : node.parentElement))
        .filter((node): node is Element => Boolean(node));

      if (changedNodes.length === 0) {
        return true;
      }

      return changedNodes.every((node) => isManagedMetaElement(node));
    });
  }

  function resetPageState() {
    renderEpoch += 1;
    removeInjectedMetadata();
    restoreNativeMetadata();
    document.body.classList.remove("bgpv-pr-list-active");
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }
    observedRows = new WeakSet();
    hydrationCache.clear();
    nativeMetaCache.clear();
  }

  function canRenderForEpoch(epoch: number): boolean {
    return epoch === renderEpoch && isPullListPage() && settings.prListEnrichment;
  }

  function createObserver() {
    if (intersectionObserver) {
      return;
    }

    intersectionObserver = new IntersectionObserver(onRowIntersection, {
      root: null,
      rootMargin: `${HYDRATION_ROOT_MARGIN_PX}px 0px`,
      threshold: 0
    });
  }

  function observeRows() {
    createObserver();

    getRows().forEach((row) => {
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

  function enqueueFetch<T extends LocMetricsResult | LastEditedMetricsResult | null>(
    taskFactory: () => Promise<T>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      fetchQueue.push({ taskFactory, resolve, reject } as unknown as FetchQueueItem<LocMetricsResult | LastEditedMetricsResult | null>);
      pumpFetchQueue();
    });
  }

  function pumpFetchQueue() {
    while (activeFetches < MAX_CONCURRENT_FETCHES && fetchQueue.length > 0) {
      const next = fetchQueue.shift();
      if (!next) {
        continue;
      }
      activeFetches += 1;

      next.taskFactory()
        .then(next.resolve, next.reject)
        .finally(() => {
          activeFetches -= 1;
          pumpFetchQueue();
        });
    }
  }

  async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Accept: "text/html, */*; q=0.01"
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  async function fetchDocument(url: string): Promise<Document> {
    const response = await fetch(url, {
      credentials: "same-origin"
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }

    const html = await response.text();
    return new DOMParser().parseFromString(html, "text/html");
  }

  function formatRelativeTime(timestamp: string): string | null {
    const target = Date.parse(timestamp);
    if (!Number.isFinite(target)) {
      return null;
    }

    const diffSeconds = Math.max(1, Math.round((Date.now() - target) / 1000));
    const units = [
      { limit: 60, size: 1, suffix: "s" },
      { limit: 3600, size: 60, suffix: "m" },
      { limit: 86400, size: 3600, suffix: "h" },
      { limit: 604800, size: 86400, suffix: "d" },
      { limit: 2592000, size: 604800, suffix: "w" },
      { limit: 31536000, size: 2592000, suffix: "mo" },
      { limit: Number.POSITIVE_INFINITY, size: 31536000, suffix: "y" }
    ];

    const unit = units.find((candidate) => diffSeconds < candidate.limit) || units[units.length - 1];
    const value = Math.max(1, Math.round(diffSeconds / unit.size));
    return `${value}${unit.suffix} ago`;
  }

  function extractLastEditedAt(detailDocument: Document): string | null {
    const timestamps = Array.from(detailDocument.querySelectorAll<HTMLElement>("relative-time[datetime]"))
      .map((node) => node.getAttribute("datetime"))
      .filter((value): value is string => Boolean(value))
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value));

    if (timestamps.length === 0) {
      return null;
    }

    return new Date(Math.max(...timestamps)).toISOString();
  }

  async function fetchLocMetrics(prUrl: string): Promise<LocMetricsResult> {
    const baseUrl = prUrl.replace(/\/$/, "");
    let locChanges = null;

    try {
      const diffstatPayload = await fetchJson<DiffstatPayload>(`${baseUrl}/page_data/diffstat`);
      const diffstat = diffstatPayload?.diffstat;
      if (diffstat && (typeof diffstat.linesAdded === "number" || typeof diffstat.linesDeleted === "number")) {
        locChanges = {
          additions: typeof diffstat.linesAdded === "number" ? diffstat.linesAdded : 0,
          deletions: typeof diffstat.linesDeleted === "number" ? diffstat.linesDeleted : 0
        };
      }
    } catch {}

    return {
      locChanges,
      codeMetricsAttemptedAt: new Date().toISOString()
    };
  }

  async function fetchLastEditedMetrics(prUrl: string): Promise<LastEditedMetricsResult> {
    let lastActivityAt = null;

    try {
      const detailDocument = await fetchDocument(prUrl);
      lastActivityAt = extractLastEditedAt(detailDocument);
    } catch {}

    return {
      lastActivityAt,
      lastActivityAttemptedAt: new Date().toISOString()
    };
  }

  async function warmPersistentCache(rows: Element[]): Promise<void> {
    const baseRows = rows
      .map(parseBaseRow)
      .filter((baseRow): baseRow is BaseRow => Boolean(baseRow));

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
    const needsLastEdited = shouldFetchLastEdited(cacheEntry.data, forceRefresh);

    if (needsCodeMetrics && !cacheEntry.filesPromise) {
      cacheEntry.filesPromise = enqueueFetch(() => fetchLocMetrics(prUrl).catch(() => null));
    }

    if (needsLastEdited && !cacheEntry.detailPromise) {
      cacheEntry.detailPromise = enqueueFetch(() => fetchLastEditedMetrics(prUrl).catch(() => null));
    }

    let nextData: HydratedPrData = {
      ...(cacheEntry.data ?? {}),
      prUrl
    };

    if (needsCodeMetrics) {
      let filesData: LocMetricsResult | null;
      try {
        filesData = await cacheEntry.filesPromise;
      } finally {
        cacheEntry.filesPromise = null;
      }

      if (filesData) {
        nextData = {
          ...nextData,
          locChanges: filesData.locChanges ?? nextData.locChanges ?? null,
          codeMetricsAttemptedAt: filesData.codeMetricsAttemptedAt ?? nextData.codeMetricsAttemptedAt ?? null
        };
      }
    }

    if (needsLastEdited) {
      let detailData: LastEditedMetricsResult | null;
      try {
        detailData = await cacheEntry.detailPromise;
      } finally {
        cacheEntry.detailPromise = null;
      }

      if (detailData) {
        nextData = {
          ...nextData,
          lastActivityAt: detailData.lastActivityAt ?? nextData.lastActivityAt ?? null,
          lastActivityAttemptedAt: detailData.lastActivityAttemptedAt ?? nextData.lastActivityAttemptedAt ?? null
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

  function createMetaItem(text: string, tone?: string): HTMLSpanElement {
    const item = document.createElement("span");
    item.className = "bgpv-inline-meta__item";
    if (tone) {
      item.dataset.tone = tone;
    }
    item.textContent = text;
    return item;
  }

  function createLocItem(locChanges: LocChanges): HTMLSpanElement {
    const item = document.createElement("span");
    item.className = "bgpv-inline-meta__item bgpv-inline-meta__loc";

    const additions = document.createElement("span");
    additions.className = "bgpv-inline-meta__loc-added";
    additions.textContent = `+${locChanges.additions}`;

    const deletions = document.createElement("span");
    deletions.className = "bgpv-inline-meta__loc-deleted";
    deletions.textContent = `-${locChanges.deletions}`;

    item.append(additions, deletions);
    return item;
  }

  function getFreshnessDescriptor(
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

  function createRefreshItem(
    baseRow: BaseRow,
    hydratedData: HydratedPrData,
    cacheEntry: CacheEntry
  ): HTMLButtonElement | null {
    const descriptor = getFreshnessDescriptor(hydratedData, cacheEntry);
    if (!descriptor) {
      return null;
    }

    const item = document.createElement("button");
    item.type = "button";
    item.className = "bgpv-inline-meta__item bgpv-inline-meta__refresh";
    item.dataset.tone = descriptor.tone;
    item.dataset.freshness = descriptor.freshness;
    item.textContent = descriptor.text;
    item.disabled = cacheEntry.isRefreshing;
    item.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      refreshRow(baseRow.row, { interactive: true });
    });
    return item;
  }

  function buildMetadataItems(baseRow: BaseRow, hydratedData: HydratedPrData, cacheEntry: CacheEntry): HTMLElement[] {
    const items: HTMLElement[] = [];

    if (settings.locChanges && hydratedData.locChanges) {
      items.push(createLocItem(hydratedData.locChanges));
    }

    if (settings.lastEditedTime && hydratedData.lastActivityAt) {
      const lastEditedLabel = formatRelativeTime(hydratedData.lastActivityAt);
      if (lastEditedLabel) {
        items.push(createMetaItem(`edited ${lastEditedLabel}`));
      }
    }

    if (settings.cacheState) {
      const refreshItem = createRefreshItem(baseRow, hydratedData, cacheEntry);
      if (refreshItem) {
        items.push(refreshItem);
      }
    }

    return items;
  }

  function renderRowMetadata(baseRow: BaseRow, hydratedData: HydratedPrData): void {
    removeRowMetadata(baseRow.row);
    applyNativeRowSettings(baseRow);

    const cacheEntry = ensureCacheEntry(baseRow.prUrl);
    const items = buildMetadataItems(baseRow, hydratedData, cacheEntry);
    if (items.length === 0) {
      return;
    }

    const container = document.createElement("span");
    container.className = "bgpv-inline-meta";
    items.forEach((item) => container.appendChild(item));

    baseRow.insertionPoint.appendChild(container);
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
      renderRowMetadata(baseRow, previousData);
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

        if (shouldRemoveMetadata) {
          removeRowMetadata(row);
          return;
        }

        if (!nextRenderData) {
          removeRowMetadata(row);
          return;
        }

        renderRowMetadata(baseRow, nextRenderData);
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
      renderRowMetadata(baseRow, cacheEntry.data);
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

      renderRowMetadata(baseRow, hydratedData);
    } catch {
      if (cacheEntry.data && canRenderForEpoch(epochAtStart)) {
        renderRowMetadata(baseRow, cacheEntry.data);
        return;
      }

      removeRowMetadata(row);
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
    const rows = getRows();
    warmPersistentCache(rows)
      .catch(() => {})
      .finally(() => {
        rows.forEach((row) => {
          const baseRow = parseBaseRow(row);
          if (!baseRow) {
            return;
          }

          applyNativeRowSettings(baseRow);
          const cacheEntry = ensureCacheEntry(baseRow.prUrl);
          if (cacheEntry.data) {
            renderRowMetadata(baseRow, cacheEntry.data);
            return;
          }

          removeRowMetadata(row);
        });

        observeRows();
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
    const mutationObserver = new MutationObserver((mutations) => {
      if (shouldIgnoreMutations(mutations)) {
        return;
      }

      scheduleRefresh();
    });
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    document.addEventListener("turbo:load", scheduleRefresh);
    document.addEventListener("pjax:end", scheduleRefresh);
    window.addEventListener("popstate", scheduleRefresh);
  }

  chrome.storage.sync.get({ bgpvSettings: DEFAULT_SETTINGS }, (result) => {
    settings = { ...DEFAULT_SETTINGS, ...(result.bgpvSettings as Partial<Settings> | undefined) };
    refresh();
    installObservers();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync" && changes.bgpvSettings) {
      settings = {
        ...DEFAULT_SETTINGS,
        ...((changes.bgpvSettings.newValue as Partial<Settings> | undefined) ?? {})
      };
      scheduleRefresh();
      return;
    }

    if (areaName === "sync" && changes[CACHE_BUST_SIGNAL_KEY]) {
      invalidateHydrationState();
    }
  });
})();

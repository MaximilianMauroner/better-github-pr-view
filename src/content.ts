(function () {
  interface DiffstatPayload {
    diffstat?: {
      linesAdded?: number;
      linesDeleted?: number;
    };
  }

  interface TabCountsPayload {
    filesChangedCount?: number;
    filesChangedCountLimitExceeded?: boolean;
  }

  interface FetchQueueItem<T> {
    taskFactory: () => Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  }

  const DEFAULT_SETTINGS: Settings = {
    prListEnrichment: true,
    branchSummary: true,
    commitCount: true,
    filesChanged: false,
    locChanges: true,
    lastEditedTime: true,
    autoRefreshAfterHours: 6,
    nativePrNumber: true,
    nativeOpenedTime: true,
    nativeAuthor: true,
    nativeDraft: true,
    nativeTasks: true,
    cacheState: false
  };

  const SELECTORS = {
    modernListRoot: '[data-testid="list-view"]',
    classicListRoot: ".js-navigation-container",
    modernRows: '[data-testid="list-view"] li[class*="ListItem-module__listItem"]',
    classicRows: 'div[id^="issue_"].js-issue-row',
    modernTitleLink: '[data-testid="issue-pr-title-link"]',
    classicTitleLink: 'a.markdown-title',
    modernMeta: '[data-testid="created-at"]',
    classicMeta: '.opened-by'
  };

  const MAX_CONCURRENT_FETCHES = 4;
  const HYDRATION_ROOT_MARGIN_PX = 320;
  const CACHE_VERSION = 11;
  const FRESH_CACHE_MS = 5 * 60 * 1000;
  const DEFAULT_AUTO_REFRESH_AFTER_HOURS = 6;
  const MIN_AUTO_REFRESH_AFTER_HOURS = 0.5;
  const MAX_AUTO_REFRESH_AFTER_HOURS = 168;
  const BRANCH_SUMMARY_OWNER_PREFIX_LENGTH = 6;
  const VERBOSE_BRANCH_SUMMARY_LENGTH = 26;
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
  let mutationObserver: MutationObserver | null = null;
  let observedRows = new WeakSet<Element>();
  let activeFetches = 0;
  const fetchQueue: FetchQueueItem<LocMetricsResult | DetailMetricsResult | FilesChangedMetricsResult | null>[] = [];

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

    if ((settings.lastEditedTime || settings.commitCount || settings.branchSummary) && !data.detailMetricsAttemptedAt) {
      return false;
    }

    if (settings.filesChanged && !data.filesChangedAttemptedAt) {
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

  function sanitizeAutoRefreshAfterHours(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return DEFAULT_AUTO_REFRESH_AFTER_HOURS;
    }

    return Math.min(MAX_AUTO_REFRESH_AFTER_HOURS, Math.max(MIN_AUTO_REFRESH_AFTER_HOURS, value));
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

  function shouldFetchDetailMetrics(data: HydratedPrData | null, forceRefresh: boolean): boolean {
    if (!settings.lastEditedTime && !settings.commitCount && !settings.branchSummary) {
      return false;
    }

    if (forceRefresh) {
      return true;
    }

    if (!data?.detailMetricsAttemptedAt) {
      return true;
    }

    return false;
  }

  function shouldFetchFilesChanged(data: HydratedPrData | null, forceRefresh: boolean): boolean {
    if (!settings.filesChanged) {
      return false;
    }

    if (forceRefresh) {
      return true;
    }

    if (!data?.filesChangedAttemptedAt) {
      return true;
    }

    return false;
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

  function getBaseRows(): BaseRow[] {
    return getRows()
      .map(parseBaseRow)
      .filter((baseRow): baseRow is BaseRow => Boolean(baseRow));
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
    const usesStackedMetadata = row.matches(SELECTORS.modernRows);

    return {
      row,
      titleLink,
      metaNode,
      insertionPoint,
      usesStackedMetadata,
      prUrl,
      number: numberMatch ? numberMatch[1] : null,
      isDraft: isDraftRow(row, metaNode)
    };
  }

  function removeInjectedMetadata(target: ParentNode = document): void {
    target.querySelectorAll(".bgpv-inline-meta, .bgpv-branch-summary").forEach((node) => node.remove());
  }

  function buildNativeMetaSegments(baseRow: BaseRow, snapshot: NativeMetaSnapshot): Node[] {
    const segments: Node[] = [];
    const numberText = snapshot.numberText || (baseRow.number ? `#${baseRow.number}` : null);
    const stateText = snapshot.stateText || "opened";
    const timeNode = snapshot.timeNode?.cloneNode(true) || null;
    const authorNode = snapshot.authorNode?.cloneNode(true) || null;

    if (settings.nativePrNumber && numberText) {
      segments.push(document.createTextNode(numberText));
    }

    if (settings.nativeOpenedTime && timeNode) {
      segments.push(document.createTextNode(segments.length > 0 ? ` ${stateText} ` : `${stateText} `));
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
    const metaText = normalizeWhitespace(metaNode.textContent || "");
    metaNode.setAttribute(MANAGED_NATIVE_META_ATTR, "true");
    snapshot = {
      node: metaNode,
      originalNodes: Array.from(metaNode.childNodes, (node: ChildNode) => node.cloneNode(true)),
      numberText: baseRow.number ? `#${baseRow.number}` : (normalizeWhitespace(metaNode.textContent || "").match(/#\d+/)?.[0] || null),
      stateText: metaText.includes(" was merged ")
        ? "was merged"
        : metaText.includes(" was closed ")
          ? "was closed"
          : "opened",
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

    target.querySelectorAll<HTMLAnchorElement>('a[href*="#partial-pull-merging"]').forEach((node) => {
      const container = node.closest<HTMLElement>("span");
      if (container) {
        container.hidden = false;
      }
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

  function applyNativeDraftSettings(baseRow: BaseRow): void {
    baseRow.row.querySelectorAll<HTMLAnchorElement>('a[href*="#partial-pull-merging"]').forEach((node) => {
      const container = node.closest<HTMLElement>("span");
      if (container) {
        container.hidden = !settings.nativeDraft;
      }
    });
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
    applyNativeDraftSettings(baseRow);
    applyNativeTaskSettings(baseRow);
  }

  function removeRowMetadata(row: Element): void {
    row.querySelector(".bgpv-inline-meta")?.remove();
    row.querySelector(".bgpv-branch-summary")?.remove();
  }

  function isManagedMetaElement(node: Node | null): boolean {
    return node instanceof Element && (
      node.classList.contains("bgpv-inline-meta") ||
      Boolean(node.closest(".bgpv-inline-meta")) ||
      node.classList.contains("bgpv-branch-summary") ||
      Boolean(node.closest(".bgpv-branch-summary")) ||
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
    mutationObserver?.disconnect();
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

  function observeRows(baseRows: BaseRow[]) {
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

  function ensureMutationObserver() {
    if (mutationObserver) {
      return;
    }

    mutationObserver = new MutationObserver((mutations) => {
      if (shouldIgnoreMutations(mutations)) {
        return;
      }

      scheduleRefresh();
    });
  }

  function getMutationTargets(baseRows: BaseRow[]): Element[] {
    const selectorTargets = [
      ...Array.from(document.querySelectorAll(SELECTORS.modernListRoot)),
      ...Array.from(document.querySelectorAll(SELECTORS.classicListRoot))
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

  function enqueueFetch<T extends LocMetricsResult | DetailMetricsResult | FilesChangedMetricsResult | null>(
    taskFactory: () => Promise<T>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      fetchQueue.push({ taskFactory, resolve, reject } as unknown as FetchQueueItem<LocMetricsResult | DetailMetricsResult | FilesChangedMetricsResult | null>);
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

  function parseCountValue(value: string | null | undefined): number | null {
    const normalized = normalizeWhitespace(value || "").toLowerCase();
    if (!normalized) {
      return null;
    }

    const suffixMatch = normalized.match(/^([\d,.]+)\s*([kmb])$/);
    if (suffixMatch) {
      const amount = Number.parseFloat(suffixMatch[1].replace(/,/g, ""));
      const multiplier = suffixMatch[2] === "k" ? 1_000 : suffixMatch[2] === "m" ? 1_000_000 : 1_000_000_000;
      return Number.isFinite(amount) ? Math.round(amount * multiplier) : null;
    }

    const digitsOnly = normalized.replace(/,/g, "");
    if (/^\d+$/.test(digitsOnly)) {
      return Number.parseInt(digitsOnly, 10);
    }

    return null;
  }

  function shortenBranchOwner(owner: string): string {
    if (owner.length <= BRANCH_SUMMARY_OWNER_PREFIX_LENGTH) {
      return owner;
    }

    return owner.slice(0, BRANCH_SUMMARY_OWNER_PREFIX_LENGTH);
  }

  function formatBranchSummary(headOwner: string, headBranch: string, baseOwner: string, baseBranch: string): string {
    if (headOwner === baseOwner) {
      return `${headBranch} → ${baseBranch}`;
    }

    return `${shortenBranchOwner(headOwner)}:${headBranch} → ${baseBranch}`;
  }

  function extractEmbeddedDetailMetrics(detailDocument: Document): Pick<DetailMetricsResult, "branchSummary" | "commitCount"> {
    const embeddedDataNode = detailDocument.querySelector<HTMLScriptElement>('script[data-target="react-app.embeddedData"]');
    if (!embeddedDataNode?.textContent) {
      return {
        branchSummary: null,
        commitCount: null
      };
    }

    try {
      const embeddedData = JSON.parse(embeddedDataNode.textContent) as {
        payload?: {
          pullRequestsLayoutRoute?: {
            pullRequest?: {
              commitsCount?: number;
              baseBranch?: string;
              headBranch?: string;
              headRepositoryOwnerLogin?: string;
            };
            repository?: {
              ownerLogin?: string;
            };
          };
        };
      };

      const pullRequest = embeddedData?.payload?.pullRequestsLayoutRoute?.pullRequest;
      const repository = embeddedData?.payload?.pullRequestsLayoutRoute?.repository;
      const branchSummary = typeof pullRequest?.headRepositoryOwnerLogin === "string"
        && typeof pullRequest?.headBranch === "string"
        && typeof repository?.ownerLogin === "string"
        && typeof pullRequest?.baseBranch === "string"
        ? formatBranchSummary(
          pullRequest.headRepositoryOwnerLogin,
          pullRequest.headBranch,
          repository.ownerLogin,
          pullRequest.baseBranch
        )
        : null;
      const commitCount = typeof pullRequest?.commitsCount === "number" ? pullRequest.commitsCount : null;

      return {
        branchSummary,
        commitCount
      };
    } catch {
      return {
        branchSummary: null,
        commitCount: null
      };
    }
  }

  function extractFilesChangedCount(filesDocument: Document): number | null {
    const counterNode = filesDocument.querySelector<HTMLElement>(
      "#files_tab_counter, #prs-files-anchor-tab .prc-CounterLabel-CounterLabel-X-kRU, a[href*='/pull/'][href$='/files'] .Counter"
    );

    return parseCountValue(counterNode?.getAttribute("title") || counterNode?.textContent);
  }

  function extractCommitCountFallback(detailDocument: Document): number | null {
    const counterNode = detailDocument.querySelector<HTMLElement>(
      "#prs-commits-anchor-tab .prc-CounterLabel-CounterLabel-X-kRU, #commits_tab_counter, a[href*='/pull/'][href$='/commits'] .Counter"
    );

    return parseCountValue(counterNode?.getAttribute("title") || counterNode?.textContent);
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

  async function fetchDetailMetrics(prUrl: string): Promise<DetailMetricsResult> {
    let branchSummary = null;
    let commitCount = null;
    let lastActivityAt = null;

    try {
      const detailDocument = await fetchDocument(prUrl);
      const embeddedDetailMetrics = extractEmbeddedDetailMetrics(detailDocument);
      branchSummary = embeddedDetailMetrics.branchSummary;
      commitCount = embeddedDetailMetrics.commitCount ?? extractCommitCountFallback(detailDocument);
      lastActivityAt = extractLastEditedAt(detailDocument);
    } catch {}

    return {
      branchSummary,
      commitCount,
      lastActivityAt,
      detailMetricsAttemptedAt: new Date().toISOString()
    };
  }

  async function fetchFilesChangedMetrics(prUrl: string): Promise<FilesChangedMetricsResult> {
    const baseUrl = prUrl.replace(/\/$/, "");
    let filesChanged = null;

    try {
      const tabCountsPayload = await fetchJson<TabCountsPayload>(`${baseUrl}/page_data/tab_counts`);
      if (typeof tabCountsPayload?.filesChangedCount === "number") {
        filesChanged = tabCountsPayload.filesChangedCount;
      }
    } catch {}

    if (filesChanged === null) {
      try {
        const filesDocument = await fetchDocument(`${baseUrl}/files`);
        filesChanged = extractFilesChangedCount(filesDocument);
      } catch {}
    }

    return {
      filesChanged,
      filesChangedAttemptedAt: new Date().toISOString()
    };
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
      cacheEntry.locMetricsPromise = enqueueFetch(() => fetchLocMetrics(prUrl).catch(() => null));
    }

    if (needsDetailMetrics && !cacheEntry.detailPromise) {
      cacheEntry.detailPromise = enqueueFetch(() => fetchDetailMetrics(prUrl).catch(() => null));
    }

    if (needsFilesChanged && !cacheEntry.filesChangedPromise) {
      cacheEntry.filesChangedPromise = enqueueFetch(() => fetchFilesChangedMetrics(prUrl).catch(() => null));
    }

    let nextData: HydratedPrData = {
      ...(cacheEntry.data ?? {}),
      prUrl
    };

    if (needsCodeMetrics) {
      let filesData: LocMetricsResult | null;
      try {
        filesData = await cacheEntry.locMetricsPromise;
      } finally {
        cacheEntry.locMetricsPromise = null;
      }

      if (filesData) {
        nextData = {
          ...nextData,
          locChanges: filesData.locChanges ?? nextData.locChanges ?? null,
          codeMetricsAttemptedAt: filesData.codeMetricsAttemptedAt ?? nextData.codeMetricsAttemptedAt ?? null
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

  function createCountItem(count: number, singularLabel: string, pluralLabel: string): HTMLSpanElement {
    const label = count === 1 ? singularLabel : pluralLabel;
    return createMetaItem(`${count} ${label}`);
  }

  function createBranchSummaryElement(summary: string): HTMLDivElement {
    const item = document.createElement("div");
    item.className = "bgpv-branch-summary";
    item.title = summary;

    const [sourceBranch, targetBranch] = summary.includes(" → ")
      ? summary.split(" → ", 2)
      : summary.split(" -> ", 2);

    const source = document.createElement("span");
    source.className = "bgpv-branch-summary__source";
    source.textContent = sourceBranch || summary;

    const arrow = document.createElement("span");
    arrow.className = "bgpv-branch-summary__arrow";
    arrow.textContent = "→";

    const target = document.createElement("span");
    target.className = "bgpv-branch-summary__target";
    target.textContent = targetBranch || "";

    item.append(source, arrow, target);
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
        text: "refreshing…",
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

    if (settings.commitCount && typeof hydratedData.commitCount === "number") {
      items.push(createCountItem(hydratedData.commitCount, "commit", "commits"));
    }

    if (settings.filesChanged && typeof hydratedData.filesChanged === "number") {
      items.push(createCountItem(hydratedData.filesChanged, "file", "files"));
    }

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

  function shouldStackMetadata(baseRow: BaseRow, items: HTMLElement[]): boolean {
    if (!baseRow.usesStackedMetadata) {
      return false;
    }

    if (items.length >= 4) {
      return true;
    }

    return items.length >= 3 && hasVerboseBranchSummary(items);
  }

  function hasVerboseBranchSummary(items: HTMLElement[]): boolean {
    return items.some((item) => normalizeWhitespace(item.textContent || "").length >= VERBOSE_BRANCH_SUMMARY_LENGTH);
  }

  function renderRowMetadata(baseRow: BaseRow, hydratedData: HydratedPrData): void {
    removeRowMetadata(baseRow.row);
    applyNativeRowSettings(baseRow);

    const cacheEntry = ensureCacheEntry(baseRow.prUrl);
    const items = buildMetadataItems(baseRow, hydratedData, cacheEntry);
    const branchSummary = settings.branchSummary && hydratedData.branchSummary
      ? createBranchSummaryElement(hydratedData.branchSummary)
      : null;

    if (branchSummary && baseRow.insertionPoint.parentElement) {
      baseRow.insertionPoint.insertAdjacentElement("beforebegin", branchSummary);
    }

    if (items.length === 0) {
      return;
    }

    const container = document.createElement(baseRow.usesStackedMetadata ? "div" : "span");
    container.className = "bgpv-inline-meta";
    if (shouldStackMetadata(baseRow, items)) {
      container.classList.add("bgpv-inline-meta--stacked");
    }
    items.forEach((item) => container.appendChild(item));

    const stackedAnchor = baseRow.metaNode || baseRow.insertionPoint;
    if (container.classList.contains("bgpv-inline-meta--stacked") && stackedAnchor.parentElement) {
      stackedAnchor.insertAdjacentElement("afterend", container);
      return;
    }

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
    const initialBaseRows = getBaseRows();
    syncMutationObserver(initialBaseRows);

    warmPersistentCache(initialBaseRows)
      .catch(() => {})
      .finally(() => {
        const baseRows = getBaseRows();
        baseRows.forEach((baseRow) => {
          applyNativeRowSettings(baseRow);
          const cacheEntry = ensureCacheEntry(baseRow.prUrl);
          if (cacheEntry.data) {
            renderRowMetadata(baseRow, cacheEntry.data);
            return;
          }

          removeRowMetadata(baseRow.row);
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

  chrome.storage.sync.get({ bgpvSettings: DEFAULT_SETTINGS }, (result) => {
    settings = {
      ...DEFAULT_SETTINGS,
      ...(result.bgpvSettings as Partial<Settings> | undefined),
      autoRefreshAfterHours: sanitizeAutoRefreshAfterHours(
        (result.bgpvSettings as Partial<Settings> | undefined)?.autoRefreshAfterHours
      )
    };
    refresh();
    installObservers();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync" && changes.bgpvSettings) {
      settings = {
        ...DEFAULT_SETTINGS,
        ...((changes.bgpvSettings.newValue as Partial<Settings> | undefined) ?? {}),
        autoRefreshAfterHours: sanitizeAutoRefreshAfterHours(
          (changes.bgpvSettings.newValue as Partial<Settings> | undefined)?.autoRefreshAfterHours
        )
      };
      scheduleRefresh();
      return;
    }

    if (areaName === "sync" && changes[CACHE_BUST_SIGNAL_KEY]) {
      invalidateHydrationState();
    }
  });
})();

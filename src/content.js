(function () {
  const DEFAULT_SETTINGS = {
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
  const CACHE_VERSION = 9;
  const FRESH_CACHE_MS = 5 * 60 * 1000;
  const HARD_STALE_MS = 30 * 60 * 1000;
  const AUTO_REFRESH_COOLDOWN_MS = 2 * 60 * 1000;
  const AUTO_REFRESH_ERROR_COOLDOWN_MS = 5 * 60 * 1000;

  const hydrationCache = new Map();
  const nativeMetaCache = new Map();
  let settings = { ...DEFAULT_SETTINGS };
  let refreshTimer = null;
  let currentPageKey = "";
  let renderEpoch = 0;
  let intersectionObserver = null;
  let observedRows = new WeakSet();
  let activeFetches = 0;
  const fetchQueue = [];

  function getStorageKey(prUrl) {
    return `bgpv:pr:${prUrl}`;
  }

  function ensureCacheEntry(prUrl) {
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

  function chromeStorageGet(area, keys) {
    return new Promise((resolve) => {
      chrome.storage[area].get(keys, resolve);
    });
  }

  function chromeStorageSet(area, value) {
    return new Promise((resolve) => {
      chrome.storage[area].set(value, resolve);
    });
  }

  function hasCompleteCachedData(data) {
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

  function buildPersistedPayload(data) {
    return {
      version: CACHE_VERSION,
      data
    };
  }

  function readPersistedPayload(payload) {
    if (!payload || payload.version !== CACHE_VERSION || !payload.data) {
      return null;
    }

    return payload.data;
  }

  function isPullListPage() {
    return /^\/[^/]+\/[^/]+\/pulls\/?$/.test(window.location.pathname);
  }

  function getPageKey() {
    return `${window.location.pathname}${window.location.search}`;
  }

  function normalizeWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function getFetchedAt(data) {
    return data?.fetchedAt || null;
  }

  function getFreshnessAgeMs(data) {
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

  function getFreshnessState(data) {
    const ageMs = getFreshnessAgeMs(data);
    if (ageMs <= FRESH_CACHE_MS) {
      return "fresh";
    }

    if (ageMs <= HARD_STALE_MS) {
      return "soft_stale";
    }

    return "hard_stale";
  }

  function shouldFetchCodeMetrics(data, forceRefresh) {
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

  function shouldFetchLastEdited(data, forceRefresh) {
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

  function shouldSkipAutoRefresh(cacheEntry) {
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

  function getRows() {
    const rows = [
      ...Array.from(document.querySelectorAll(SELECTORS.modernRows)),
      ...Array.from(document.querySelectorAll(SELECTORS.classicRows))
    ];

    return rows.filter((row) => {
      const titleLink = getTitleLink(row);
      return titleLink?.getAttribute("href")?.includes("/pull/");
    });
  }

  function getTitleLink(row) {
    return row.querySelector(SELECTORS.modernTitleLink) || row.querySelector(SELECTORS.classicTitleLink);
  }

  function getNativeMetaNode(row) {
    return row.querySelector(SELECTORS.modernMeta) || row.querySelector(SELECTORS.classicMeta);
  }

  function isDraftRow(row, metaNode) {
    if (row.querySelector('[aria-label="Draft Pull Request"], .octicon-git-pull-request-draft, [data-status="draft"]')) {
      return true;
    }

    const metaText = normalizeWhitespace(metaNode?.textContent || "");
    return /\bDraft\b/.test(metaText);
  }

  function parseBaseRow(row) {
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

  function removeInjectedMetadata(target = document) {
    target.querySelectorAll(".bgpv-inline-meta").forEach((node) => node.remove());
  }

  function buildNativeMetaSegments(baseRow, snapshot) {
    const segments = [];
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

  function ensureNativeMetaSnapshot(baseRow) {
    if (!baseRow.metaNode) {
      return null;
    }

    let snapshot = nativeMetaCache.get(baseRow.row);
    if (snapshot && snapshot.node === baseRow.metaNode) {
      return snapshot;
    }

    const metaNode = baseRow.metaNode;
    snapshot = {
      node: metaNode,
      originalHTML: metaNode.innerHTML,
      numberText: baseRow.number ? `#${baseRow.number}` : (normalizeWhitespace(metaNode.textContent || "").match(/#\d+/)?.[0] || null),
      timeNode: metaNode.querySelector("relative-time"),
      authorNode: metaNode.querySelector("a.Link--muted, a[data-hovercard-type='user'], a[title]")
    };

    nativeMetaCache.set(baseRow.row, snapshot);
    return snapshot;
  }

  function restoreNativeMetadata(target = document) {
    nativeMetaCache.forEach((snapshot, row) => {
      if (!target.contains(row) || !snapshot.node.isConnected) {
        return;
      }

      snapshot.node.hidden = false;
      snapshot.node.innerHTML = snapshot.originalHTML;
    });

    target.querySelectorAll("tracked-issues-progress").forEach((node) => {
      node.hidden = false;
    });
  }

  function applyNativeMetaSettings(baseRow) {
    const snapshot = ensureNativeMetaSnapshot(baseRow);
    if (!snapshot) {
      return;
    }

    if (settings.nativePrNumber && settings.nativeOpenedTime && settings.nativeAuthor) {
      snapshot.node.hidden = false;
      snapshot.node.innerHTML = snapshot.originalHTML;
      return;
    }

    const segments = buildNativeMetaSegments(baseRow, snapshot);
    snapshot.node.replaceChildren(...segments);
    snapshot.node.hidden = segments.length === 0;
  }

  function applyNativeTaskSettings(baseRow) {
    const taskProgressNode = baseRow.row.querySelector("tracked-issues-progress");
    if (!taskProgressNode) {
      return;
    }

    taskProgressNode.hidden = !settings.nativeTasks;
  }

  function applyNativeRowSettings(baseRow) {
    applyNativeMetaSettings(baseRow);
    applyNativeTaskSettings(baseRow);
  }

  function removeRowMetadata(row) {
    row.querySelector(".bgpv-inline-meta")?.remove();
  }

  function isManagedMetaElement(node) {
    return node instanceof Element && (node.classList.contains("bgpv-inline-meta") || Boolean(node.closest(".bgpv-inline-meta")));
  }

  function shouldIgnoreMutations(mutations) {
    return mutations.every((mutation) => {
      const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes]
        .map((node) => (node instanceof Element ? node : node.parentElement))
        .filter(Boolean);

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

  function canRenderForEpoch(epoch) {
    return epoch === renderEpoch && isPullListPage() && settings.prListEnrichment;
  }

  function createObserver() {
    if (intersectionObserver) {
      return;
    }

    intersectionObserver = new IntersectionObserver(onRowIntersection, {
      root: null,
      rootMargin: "320px 0px",
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
      intersectionObserver.observe(row);
    });
  }

  function onRowIntersection(entries) {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) {
        return;
      }

      hydrateVisibleRow(entry.target);
    });
  }

  function enqueueFetch(taskFactory) {
    return new Promise((resolve, reject) => {
      fetchQueue.push({ taskFactory, resolve, reject });
      pumpFetchQueue();
    });
  }

  function pumpFetchQueue() {
    while (activeFetches < MAX_CONCURRENT_FETCHES && fetchQueue.length > 0) {
      const next = fetchQueue.shift();
      activeFetches += 1;

      next.taskFactory()
        .then(next.resolve, next.reject)
        .finally(() => {
          activeFetches -= 1;
          pumpFetchQueue();
        });
    }
  }

  async function fetchJson(url) {
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

    return response.json();
  }

  async function fetchDocument(url) {
    const response = await fetch(url, {
      credentials: "same-origin"
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }

    const html = await response.text();
    return new DOMParser().parseFromString(html, "text/html");
  }

  function formatRelativeTime(timestamp) {
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

  function extractLastEditedAt(detailDocument) {
    const timestamps = Array.from(detailDocument.querySelectorAll("relative-time[datetime]"))
      .map((node) => node.getAttribute("datetime"))
      .filter(Boolean)
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value));

    if (timestamps.length === 0) {
      return null;
    }

    return new Date(Math.max(...timestamps)).toISOString();
  }

  async function fetchLocMetrics(prUrl) {
    const baseUrl = prUrl.replace(/\/$/, "");
    let locChanges = null;

    try {
      const diffstatPayload = await fetchJson(`${baseUrl}/page_data/diffstat`);
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

  async function fetchLastEditedMetrics(prUrl) {
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

  async function warmPersistentCache(rows) {
    const baseRows = rows
      .map(parseBaseRow)
      .filter(Boolean);

    const missing = baseRows
      .filter((baseRow) => !ensureCacheEntry(baseRow.prUrl).loadedFromStorage)
      .map((baseRow) => baseRow.prUrl);

    if (missing.length === 0) {
      return;
    }

    const storageKeys = missing.reduce((accumulator, prUrl) => {
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

  async function persistHydratedData(prUrl, data) {
    await chromeStorageSet("local", {
      [getStorageKey(prUrl)]: buildPersistedPayload(data)
    });
  }

  async function getHydratedPrData(prUrl, options = {}) {
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

    let nextData = {
      ...cacheEntry.data,
      prUrl
    }

    if (needsCodeMetrics) {
      let filesData;
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
      let detailData;
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

  function createMetaItem(text, tone) {
    const item = document.createElement("span");
    item.className = "bgpv-inline-meta__item";
    if (tone) {
      item.dataset.tone = tone;
    }
    item.textContent = text;
    return item;
  }

  function createLocItem(locChanges) {
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

  function getFreshnessDescriptor(data, cacheEntry) {
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

  function createRefreshItem(baseRow, hydratedData, cacheEntry) {
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

  function buildMetadataItems(baseRow, hydratedData, cacheEntry) {
    const items = [];

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

  function renderRowMetadata(baseRow, hydratedData) {
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

  function refreshRow(row, options = {}) {
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

    cacheEntry.isRefreshing = true;
    cacheEntry.refreshUiMode = interactive ? "interactive" : null;
    cacheEntry.lastAutoRefreshAt = Date.now();

    if (interactive && previousData && canRenderForEpoch(epochAtStart)) {
      renderRowMetadata(baseRow, previousData);
    }

    getHydratedPrData(baseRow.prUrl, { forceRefresh: true })
      .then((hydratedData) => {
        cacheEntry.lastRefreshErrorAt = null;
        if (!document.contains(row) || currentPageKey !== pageKeyAtStart || !canRenderForEpoch(epochAtStart)) {
          return;
        }

        renderRowMetadata(baseRow, hydratedData);
      })
      .catch(() => {
        cacheEntry.lastRefreshErrorAt = Date.now();
        if (!document.contains(row) || currentPageKey !== pageKeyAtStart || !canRenderForEpoch(epochAtStart)) {
          return;
        }

        if (previousData) {
          renderRowMetadata(baseRow, previousData);
          return;
        }

        removeRowMetadata(row);
      })
      .finally(() => {
        cacheEntry.isRefreshing = false;
        cacheEntry.refreshUiMode = null;

        if (!document.contains(row) || currentPageKey !== pageKeyAtStart || !canRenderForEpoch(epochAtStart)) {
          return;
        }

        if (cacheEntry.data) {
          renderRowMetadata(baseRow, cacheEntry.data);
        }
      });
  }

  async function hydrateVisibleRow(row) {
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

  function refresh() {
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

  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refresh, 120);
  }

  function installObservers() {
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
    settings = { ...DEFAULT_SETTINGS, ...result.bgpvSettings };
    refresh();
    installObservers();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !changes.bgpvSettings) {
      return;
    }

    settings = { ...DEFAULT_SETTINGS, ...changes.bgpvSettings.newValue };
    scheduleRefresh();
  });
})();

import type {
  BaseRow,
  CacheEntry,
  FreshnessState,
  HydratedPrData,
  NativeMetaSnapshot,
  Settings
} from "../shared/types";
import {
  MANAGED_NATIVE_META_ATTR,
  VERBOSE_BRANCH_SUMMARY_LENGTH
} from "./constants";
import { formatRelativeTime, normalizeWhitespace } from "./text";

interface FreshnessDescriptor {
  text: string;
  tone: string;
  freshness: FreshnessState;
}

interface RowRendererDependencies {
  getSettings: () => Settings;
  nativeMetaCache: Map<Element, NativeMetaSnapshot>;
  describeFreshness: (data: HydratedPrData | null, cacheEntry: CacheEntry) => FreshnessDescriptor | null;
  onRefreshRow: (row: Element, options?: { interactive?: boolean }) => void;
}

export function createRowRenderer({
  getSettings,
  nativeMetaCache,
  describeFreshness,
  onRefreshRow
}: RowRendererDependencies) {
  function removeInjectedMetadata(target: ParentNode = document): void {
    target.querySelectorAll(".bgpv-inline-meta, .bgpv-branch-summary").forEach((node) => node.remove());
  }

  function buildNativeMetaSegments(baseRow: BaseRow, snapshot: NativeMetaSnapshot): Node[] {
    const settings = getSettings();
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
    const settings = getSettings();
    const snapshot = ensureNativeMetaSnapshot(baseRow);
    if (!snapshot) {
      return;
    }

    if (settings.nativePrNumber && settings.nativeOpenedTime && settings.nativeAuthor) {
      snapshot.node.hidden = false;
      snapshot.node.replaceChildren(...snapshot.originalNodes.map((node) => node.cloneNode(true)));
      return;
    }

    const segments = buildNativeMetaSegments(baseRow, snapshot);
    snapshot.node.replaceChildren(...segments);
    snapshot.node.hidden = segments.length === 0;
  }

  function applyNativeDraftSettings(baseRow: BaseRow): void {
    const settings = getSettings();
    baseRow.row.querySelectorAll<HTMLAnchorElement>('a[href*="#partial-pull-merging"]').forEach((node) => {
      const container = node.closest<HTMLElement>("span");
      if (container) {
        container.hidden = !settings.nativeDraft;
      }
    });
  }

  function applyNativeTaskSettings(baseRow: BaseRow): void {
    const settings = getSettings();
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

  function createMetaItem(text: string, tone?: string): HTMLSpanElement {
    const item = document.createElement("span");
    item.className = "bgpv-inline-meta__item";
    if (tone) {
      item.dataset.tone = tone;
    }
    item.textContent = text;
    return item;
  }

  function createLocItem(locChanges: NonNullable<HydratedPrData["locChanges"]>): HTMLSpanElement {
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

    const [sourceBranch, targetBranch] = summary.includes(" -> ")
      ? summary.split(" -> ", 2)
      : summary.split(" → ", 2);

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

  function createRefreshItem(baseRow: BaseRow, hydratedData: HydratedPrData, cacheEntry: CacheEntry): HTMLButtonElement | null {
    const descriptor = describeFreshness(hydratedData, cacheEntry);
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
      onRefreshRow(baseRow.row, { interactive: true });
    });
    return item;
  }

  function buildMetadataItems(baseRow: BaseRow, hydratedData: HydratedPrData, cacheEntry: CacheEntry): HTMLElement[] {
    const settings = getSettings();
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
      const activityLabel = formatRelativeTime(hydratedData.lastActivityAt);
      if (activityLabel) {
        items.push(createMetaItem(`activity ${activityLabel}`));
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

  function hasVerboseItemLabel(items: HTMLElement[]): boolean {
    return items.some((item) => normalizeWhitespace(item.textContent || "").length >= VERBOSE_BRANCH_SUMMARY_LENGTH);
  }

  function shouldStackMetadata(baseRow: BaseRow, items: HTMLElement[]): boolean {
    if (!baseRow.usesStackedMetadata) {
      return false;
    }

    if (items.length >= 4) {
      return true;
    }

    return items.length >= 3 && hasVerboseItemLabel(items);
  }

  function renderRowMetadata(baseRow: BaseRow, hydratedData: HydratedPrData, cacheEntry: CacheEntry): void {
    const settings = getSettings();
    removeRowMetadata(baseRow.row);
    applyNativeRowSettings(baseRow);

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

  return {
    applyNativeRowSettings,
    removeInjectedMetadata,
    removeRowMetadata,
    renderRowMetadata,
    restoreNativeMetadata,
    shouldIgnoreMutations
  };
}

import type { BaseRow } from "../shared/types";
import { SELECTORS } from "./constants";
import { normalizeWhitespace } from "./text";

export function isPullListPage(pathname: string = window.location.pathname): boolean {
  return /^\/[^/]+\/[^/]+\/pulls\/?$/.test(pathname);
}

export function getPageKey(locationLike: Pick<Location, "pathname" | "search"> = window.location): string {
  return `${locationLike.pathname}${locationLike.search}`;
}

export function getTitleLink(row: ParentNode): HTMLAnchorElement | null {
  return row.querySelector<HTMLAnchorElement>(SELECTORS.modernTitleLink)
    || row.querySelector<HTMLAnchorElement>(SELECTORS.classicTitleLink);
}

export function getNativeMetaNode(row: ParentNode): HTMLElement | null {
  return row.querySelector<HTMLElement>(SELECTORS.modernMeta)
    || row.querySelector<HTMLElement>(SELECTORS.classicMeta);
}

export function isDraftRow(row: ParentNode, metaNode: HTMLElement | null): boolean {
  if (row.querySelector('[aria-label="Draft Pull Request"], .octicon-git-pull-request-draft, [data-status="draft"]')) {
    return true;
  }

  const metaText = normalizeWhitespace(metaNode?.textContent || "");
  return /\bDraft\b/.test(metaText);
}

export function parseBaseRow(row: Element): BaseRow | null {
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

export function getRows(root: ParentNode = document): Element[] {
  const rows = [
    ...Array.from(root.querySelectorAll(SELECTORS.modernRows)),
    ...Array.from(root.querySelectorAll(SELECTORS.classicRows))
  ];

  return rows.filter((row) => {
    const titleLink = getTitleLink(row);
    return titleLink?.getAttribute("href")?.includes("/pull/");
  });
}

export function getBaseRows(root: ParentNode = document): BaseRow[] {
  return getRows(root)
    .map(parseBaseRow)
    .filter((baseRow): baseRow is BaseRow => Boolean(baseRow));
}

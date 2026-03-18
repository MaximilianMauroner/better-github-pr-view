import type {
  DetailMetricsResult,
  FilesChangedMetricsResult,
  LocMetricsResult
} from "../shared/types";
import {
  extractCommitCountFallback,
  extractEmbeddedDetailMetrics,
  extractFilesChangedCount,
  extractLatestActivityAt
} from "./extractors";

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

export async function fetchLocMetrics(prUrl: string): Promise<LocMetricsResult> {
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

export async function fetchDetailMetrics(prUrl: string): Promise<DetailMetricsResult> {
  let branchSummary = null;
  let commitCount = null;
  let lastActivityAt = null;

  try {
    const detailDocument = await fetchDocument(prUrl);
    const embeddedDetailMetrics = extractEmbeddedDetailMetrics(detailDocument);
    branchSummary = embeddedDetailMetrics.branchSummary;
    commitCount = embeddedDetailMetrics.commitCount ?? extractCommitCountFallback(detailDocument);
    lastActivityAt = extractLatestActivityAt(detailDocument);
  } catch {}

  return {
    branchSummary,
    commitCount,
    lastActivityAt,
    detailMetricsAttemptedAt: new Date().toISOString()
  };
}

export async function fetchFilesChangedMetrics(prUrl: string): Promise<FilesChangedMetricsResult> {
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

import type { DetailMetricsResult } from "../shared/types";
import { formatBranchSummary, parseCountValue } from "./text";

export function extractEmbeddedDetailMetrics(
  detailDocument: Document
): Pick<DetailMetricsResult, "branchSummary" | "commitCount"> {
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

export function extractFilesChangedCount(filesDocument: Document): number | null {
  const counterNode = filesDocument.querySelector<HTMLElement>(
    "#files_tab_counter, #prs-files-anchor-tab .prc-CounterLabel-CounterLabel-X-kRU, a[href*='/pull/'][href$='/files'] .Counter"
  );

  return parseCountValue(counterNode?.getAttribute("title") || counterNode?.textContent);
}

export function extractCommitCountFallback(detailDocument: Document): number | null {
  const counterNode = detailDocument.querySelector<HTMLElement>(
    "#prs-commits-anchor-tab .prc-CounterLabel-CounterLabel-X-kRU, #commits_tab_counter, a[href*='/pull/'][href$='/commits'] .Counter"
  );

  return parseCountValue(counterNode?.getAttribute("title") || counterNode?.textContent);
}

export function extractLatestActivityAt(detailDocument: Document): string | null {
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

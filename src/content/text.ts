import { BRANCH_SUMMARY_OWNER_PREFIX_LENGTH } from "./constants";

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function formatRelativeTime(timestamp: string, now: number = Date.now()): string | null {
  const target = Date.parse(timestamp);
  if (!Number.isFinite(target)) {
    return null;
  }

  const diffSeconds = Math.max(1, Math.round((now - target) / 1000));
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

export function parseCountValue(value: string | null | undefined): number | null {
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

export function shortenBranchOwner(owner: string): string {
  if (owner.length <= BRANCH_SUMMARY_OWNER_PREFIX_LENGTH) {
    return owner;
  }

  return owner.slice(0, BRANCH_SUMMARY_OWNER_PREFIX_LENGTH);
}

export function formatBranchSummary(headOwner: string, headBranch: string, baseOwner: string, baseBranch: string): string {
  if (headOwner === baseOwner) {
    return `${headBranch} -> ${baseBranch}`;
  }

  return `${shortenBranchOwner(headOwner)}:${headBranch} -> ${baseBranch}`;
}

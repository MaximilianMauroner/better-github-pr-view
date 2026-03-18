import type { HydratedPrData, PersistedPayload } from "./types";

export const CACHE_VERSION = 11;
export const CACHE_BUST_SIGNAL_KEY = "bgpvCacheBustAt";

export function getStorageKey(prUrl: string): string {
  return `bgpv:pr:${prUrl}`;
}

export function buildPersistedPayload(data: HydratedPrData): PersistedPayload {
  return {
    version: CACHE_VERSION,
    data
  };
}

export function readPersistedPayload(payload: unknown): HydratedPrData | null {
  const typedPayload = payload as Partial<PersistedPayload> | null;
  if (!typedPayload || typedPayload.version !== CACHE_VERSION || !typedPayload.data) {
    return null;
  }

  return typedPayload.data;
}

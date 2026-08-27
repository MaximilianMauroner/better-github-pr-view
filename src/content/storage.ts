import type { StorageArea } from "../shared/types";

function getStorageArea(area: StorageArea): chrome.storage.StorageArea {
  return area === "local" ? chrome.storage.local : chrome.storage.sync;
}

export function chromeStorageGet(
  area: StorageArea,
  keys: string[] | Record<string, unknown> | null
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    getStorageArea(area).get(keys, (items) => resolve(items as Record<string, unknown>));
  });
}

export function chromeStorageSet(area: StorageArea, value: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    getStorageArea(area).set(value, () => resolve());
  });
}

import type { Settings } from "./shared/types";
import { CACHE_BUST_SIGNAL_KEY } from "./shared/cache";
import {
  BOOLEAN_SETTING_KEYS,
  DEFAULT_SETTINGS,
  mergeSettings,
  sanitizeAutoRefreshAfterHours
} from "./shared/settings";

(function () {
  const checkboxInputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[type='checkbox']"));
  const masterInput = document.getElementById("prListEnrichment") as HTMLInputElement | null;
  const autoRefreshAfterHoursInput = document.getElementById("autoRefreshAfterHours") as HTMLSelectElement | null;
  const settingsPane = document.getElementById("settingsPane") as HTMLElement | null;
  const clearCacheButton = document.getElementById("clearCache") as HTMLButtonElement | null;
  const cacheStatus = document.getElementById("cacheStatus") as HTMLElement | null;
  const cacheUsage = document.getElementById("cacheUsage") as HTMLElement | null;
  let statusTimer: number | null = null;

  if (!masterInput || !autoRefreshAfterHoursInput || !settingsPane || !clearCacheButton || !cacheStatus || !cacheUsage) {
    return;
  }

  const settingsPaneElement = settingsPane;
  const autoRefreshSelectElement = autoRefreshAfterHoursInput;
  const clearCacheButtonElement = clearCacheButton;
  const cacheStatusElement = cacheStatus;
  const cacheUsageElement = cacheUsage;

  function syncEnabledState(settings: Settings): void {
    const enabled = Boolean(settings.prListEnrichment);
    settingsPaneElement.classList.toggle("is-disabled", !enabled);

    checkboxInputs.forEach((input) => {
      if (input === masterInput) {
        return;
      }

      input.disabled = !enabled;
    });

    autoRefreshSelectElement.disabled = !enabled;
  }

  function setState(settings: Settings): void {
    checkboxInputs.forEach((input) => {
      const key = input.name as typeof BOOLEAN_SETTING_KEYS[number];
      input.checked = Boolean(settings[key]);
    });

    autoRefreshSelectElement.value = String(sanitizeAutoRefreshAfterHours(settings.autoRefreshAfterHours));
    syncEnabledState(settings);
  }

  function persist(): void {
    const nextSettings = checkboxInputs.reduce<Settings>((accumulator, input) => {
      const key = input.name as typeof BOOLEAN_SETTING_KEYS[number];
      accumulator[key] = input.checked;
      return accumulator;
    }, { ...DEFAULT_SETTINGS });
    nextSettings.autoRefreshAfterHours = sanitizeAutoRefreshAfterHours(Number(autoRefreshSelectElement.value));

    syncEnabledState(nextSettings);
    chrome.storage.sync.set({ bgpvSettings: nextSettings });
  }

  function setStatus(message: string): void {
    if (statusTimer !== null) {
      window.clearTimeout(statusTimer);
    }

    cacheStatusElement.textContent = message;

    if (!message) {
      return;
    }

    statusTimer = window.setTimeout(() => {
      cacheStatusElement.textContent = "";
    }, 2400);
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function measureCacheBytes(value: unknown): number {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).length;
    } catch {
      return 0;
    }
  }

  function updateCacheUsage(): void {
    chrome.storage.local.get(null, (items) => {
      const cacheEntries = Object.entries(items).filter(([key]) => key.startsWith("bgpv:pr:"));
      const bytes = cacheEntries.reduce((total, [, value]) => total + measureCacheBytes(value), 0);
      const count = cacheEntries.length;
      const countLabel = count === 1 ? "1 cached PR" : `${count} cached PRs`;
      const sizeLabel = formatBytes(bytes);

      cacheUsageElement.textContent = `${countLabel} · ${sizeLabel}`;
      cacheUsageElement.title = `${countLabel}, approximately ${bytes.toLocaleString()} bytes stored in local cache`;
    });
  }

  function clearCache(): void {
    clearCacheButtonElement.disabled = true;
    setStatus("Clearing...");

    chrome.storage.local.get(null, (items) => {
      const cacheKeys = Object.keys(items).filter((key) => key.startsWith("bgpv:pr:"));
      const finish = () => {
        chrome.storage.sync.set({ [CACHE_BUST_SIGNAL_KEY]: Date.now() }, () => {
          clearCacheButtonElement.disabled = false;
          setStatus("Cache cleared");
          updateCacheUsage();
        });
      };

      if (cacheKeys.length === 0) {
        finish();
        return;
      }

      chrome.storage.local.remove(cacheKeys, finish);
    });
  }

  chrome.storage.sync.get({ bgpvSettings: DEFAULT_SETTINGS }, (result) => {
    setState(mergeSettings(result.bgpvSettings as Partial<Settings> | undefined));
  });

  updateCacheUsage();

  checkboxInputs.forEach((input) => {
    input.addEventListener("change", persist);
  });

  autoRefreshSelectElement.addEventListener("change", persist);
  clearCacheButtonElement.addEventListener("click", clearCache);
})();

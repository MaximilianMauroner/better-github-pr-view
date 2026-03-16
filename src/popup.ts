(function () {
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

  const checkboxInputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[type='checkbox']"));
  const masterInput = document.getElementById("prListEnrichment") as HTMLInputElement | null;
  const autoRefreshAfterHoursInput = document.getElementById("autoRefreshAfterHours") as HTMLSelectElement | null;
  const settingsPane = document.getElementById("settingsPane") as HTMLElement | null;
  const clearCacheButton = document.getElementById("clearCache") as HTMLButtonElement | null;
  const cacheStatus = document.getElementById("cacheStatus") as HTMLElement | null;
  const cacheUsage = document.getElementById("cacheUsage") as HTMLElement | null;
  const CACHE_BUST_SIGNAL_KEY = "bgpvCacheBustAt";
  let statusTimer: number | null = null;

  if (!masterInput || !autoRefreshAfterHoursInput || !settingsPane || !clearCacheButton || !cacheStatus || !cacheUsage) {
    return;
  }

  const DEFAULT_AUTO_REFRESH_AFTER_HOURS = 6;
  const MIN_AUTO_REFRESH_AFTER_HOURS = 0.5;
  const MAX_AUTO_REFRESH_AFTER_HOURS = 168;
  const BOOLEAN_SETTING_KEYS = [
    "prListEnrichment",
    "branchSummary",
    "commitCount",
    "filesChanged",
    "locChanges",
    "lastEditedTime",
    "nativePrNumber",
    "nativeOpenedTime",
    "nativeAuthor",
    "nativeDraft",
    "nativeTasks",
    "cacheState"
  ] satisfies Array<keyof Settings>;
  const settingsPaneElement = settingsPane;
  const autoRefreshSelectElement = autoRefreshAfterHoursInput;
  const clearCacheButtonElement = clearCacheButton;
  const cacheStatusElement = cacheStatus;
  const cacheUsageElement = cacheUsage;

  function sanitizeAutoRefreshAfterHours(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return DEFAULT_AUTO_REFRESH_AFTER_HOURS;
    }

    return Math.min(MAX_AUTO_REFRESH_AFTER_HOURS, Math.max(MIN_AUTO_REFRESH_AFTER_HOURS, value));
  }

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
    setStatus("Clearing…");

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
    setState({ ...DEFAULT_SETTINGS, ...(result.bgpvSettings as Partial<Settings> | undefined) });
  });
  updateCacheUsage();

  checkboxInputs.forEach((input) => {
    input.addEventListener("change", persist);
  });

  autoRefreshSelectElement.addEventListener("change", persist);
  clearCacheButtonElement.addEventListener("click", clearCache);
})();

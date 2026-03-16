(function () {
  const DEFAULT_SETTINGS: Settings = {
    prListEnrichment: true,
    commitCount: false,
    filesChanged: false,
    locChanges: true,
    lastEditedTime: true,
    nativePrNumber: true,
    nativeOpenedTime: true,
    nativeAuthor: true,
    nativeTasks: true,
    cacheState: false
  };

  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[type='checkbox']"));
  const masterInput = document.getElementById("prListEnrichment") as HTMLInputElement | null;
  const settingsPane = document.getElementById("settingsPane") as HTMLElement | null;
  const clearCacheButton = document.getElementById("clearCache") as HTMLButtonElement | null;
  const cacheStatus = document.getElementById("cacheStatus") as HTMLElement | null;
  const CACHE_BUST_SIGNAL_KEY = "bgpvCacheBustAt";
  let statusTimer: number | null = null;

  if (!masterInput || !settingsPane || !clearCacheButton || !cacheStatus) {
    return;
  }

  const settingsPaneElement = settingsPane;
  const clearCacheButtonElement = clearCacheButton;
  const cacheStatusElement = cacheStatus;

  function syncEnabledState(settings: Settings): void {
    const enabled = Boolean(settings.prListEnrichment);
    settingsPaneElement.classList.toggle("is-disabled", !enabled);

    inputs.forEach((input) => {
      if (input === masterInput) {
        return;
      }

      input.disabled = !enabled;
    });
  }

  function setState(settings: Settings): void {
    inputs.forEach((input) => {
      const key = input.name as keyof Settings;
      input.checked = Boolean(settings[key]);
    });
    syncEnabledState(settings);
  }

  function persist(): void {
    const nextSettings = inputs.reduce<Settings>((accumulator, input) => {
      const key = input.name as keyof Settings;
      accumulator[key] = input.checked;
      return accumulator;
    }, { ...DEFAULT_SETTINGS });

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

  function clearCache(): void {
    clearCacheButtonElement.disabled = true;
    setStatus("Clearing…");

    chrome.storage.local.get(null, (items) => {
      const cacheKeys = Object.keys(items).filter((key) => key.startsWith("bgpv:pr:"));
      const finish = () => {
        chrome.storage.sync.set({ [CACHE_BUST_SIGNAL_KEY]: Date.now() }, () => {
          clearCacheButtonElement.disabled = false;
          setStatus("Cache cleared");
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

  inputs.forEach((input) => {
    input.addEventListener("change", persist);
  });

  clearCacheButtonElement.addEventListener("click", clearCache);
})();

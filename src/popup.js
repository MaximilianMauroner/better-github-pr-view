(function () {
  const DEFAULT_SETTINGS = {
    prListEnrichment: true,
    locChanges: true,
    lastEditedTime: true,
    nativePrNumber: true,
    nativeOpenedTime: true,
    nativeAuthor: true,
    nativeTasks: true,
    cacheState: false
  };

  const inputs = Array.from(document.querySelectorAll("input[type='checkbox']"));
  const masterInput = document.getElementById("prListEnrichment");
  const settingsPane = document.getElementById("settingsPane");
  const clearCacheButton = document.getElementById("clearCache");
  const cacheStatus = document.getElementById("cacheStatus");
  const CACHE_BUST_SIGNAL_KEY = "bgpvCacheBustAt";
  let statusTimer = null;

  function syncEnabledState(settings) {
    const enabled = Boolean(settings.prListEnrichment);
    settingsPane.classList.toggle("is-disabled", !enabled);

    inputs.forEach((input) => {
      if (input === masterInput) {
        return;
      }

      input.disabled = !enabled;
    });
  }

  function setState(settings) {
    inputs.forEach((input) => {
      input.checked = Boolean(settings[input.name]);
    });
    syncEnabledState(settings);
  }

  function persist() {
    const nextSettings = inputs.reduce((accumulator, input) => {
      accumulator[input.name] = input.checked;
      return accumulator;
    }, {});

    syncEnabledState(nextSettings);
    chrome.storage.sync.set({ bgpvSettings: nextSettings });
  }

  function setStatus(message) {
    window.clearTimeout(statusTimer);
    cacheStatus.textContent = message;

    if (!message) {
      return;
    }

    statusTimer = window.setTimeout(() => {
      cacheStatus.textContent = "";
    }, 2400);
  }

  function clearCache() {
    clearCacheButton.disabled = true;
    setStatus("Clearing...");

    chrome.storage.local.get(null, (items) => {
      const cacheKeys = Object.keys(items).filter((key) => key.startsWith("bgpv:pr:"));
      const finish = () => {
        chrome.storage.sync.set({ [CACHE_BUST_SIGNAL_KEY]: Date.now() }, () => {
          clearCacheButton.disabled = false;
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
    setState({ ...DEFAULT_SETTINGS, ...result.bgpvSettings });
  });

  inputs.forEach((input) => {
    input.addEventListener("change", persist);
  });

  clearCacheButton.addEventListener("click", clearCache);
})();

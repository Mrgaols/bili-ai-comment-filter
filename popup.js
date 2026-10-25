(() => {
  "use strict";

  const configApi = globalThis.BiliAiConfig;
  if (!configApi) return;

  const { DEFAULT_CONFIG, STORAGE_KEYS, THRESHOLD_MIN, THRESHOLD_MAX, normalizeConfig } = configApi;

  const els = {
    enabled: document.getElementById("enabled"),
    counter: document.getElementById("block-counter"),
    resetCount: document.getElementById("reset-count"),
    modeTag: document.getElementById("mode-tag"),
    modeBlock: document.getElementById("mode-block"),
    thresholdBox: document.getElementById("threshold-box"),
    thresholdRange: document.getElementById("threshold-range"),
    thresholdVal: document.getElementById("threshold-val"),
    blockFish: document.getElementById("block-fish"),
    blockOfficial: document.getElementById("block-official"),
    blockKeywords: document.getElementById("block-keywords"),
    whaleNames: document.getElementById("whale-names"),
    keywordList: document.getElementById("keyword-list"),
    saveBtn: document.getElementById("save-btn"),
    resetBtn: document.getElementById("reset-btn")
  };

  let toastTimer = null;

  function showToast(text) {
    let toast = document.querySelector(".toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "toast";
      toast.setAttribute("role", "status");
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add("visible");

    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      toast.classList.remove("visible");
    }, 1400);
  }

  function parseList(value) {
    return String(value || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  function updateThresholdLabel(value) {
    els.thresholdVal.textContent = `≥${value}%`;
  }

  /** 让表单的可用状态跟勾选/模式联动，避免「填了但不生效」的误解 */
  function syncFormState() {
    const isTagOnly = els.modeTag.checked;
    els.thresholdBox.classList.toggle("disabled", isTagOnly);
    els.thresholdRange.disabled = isTagOnly;

    els.whaleNames.disabled = !els.blockFish.checked;
    els.keywordList.disabled = !els.blockKeywords.checked;
  }

  function updateCountLabel(count) {
    els.counter.textContent = `已识别 ${Number(count) || 0} 条`;
  }

  function fillForm(config) {
    const normalized = normalizeConfig(config);

    els.enabled.checked = normalized.enabled;
    els.modeTag.checked = normalized.actionType !== "auto_block";
    els.modeBlock.checked = normalized.actionType === "auto_block";

    els.thresholdRange.value = String(normalized.blockThreshold);
    updateThresholdLabel(normalized.blockThreshold);

    els.blockFish.checked = normalized.blockFishDisaster;
    els.blockOfficial.checked = normalized.blockOfficialAISummary;
    els.blockKeywords.checked = normalized.blockByKeywords;

    els.whaleNames.value = normalized.whaleNames.join("\n");
    els.keywordList.value = normalized.keywords.join("\n");

    syncFormState();
  }

  function readFormConfig() {
    return normalizeConfig({
      enabled: els.enabled.checked,
      actionType: els.modeBlock.checked ? "auto_block" : "tag_only",
      blockThreshold: Number(els.thresholdRange.value),
      blockFishDisaster: els.blockFish.checked,
      blockOfficialAISummary: els.blockOfficial.checked,
      blockByKeywords: els.blockKeywords.checked,
      whaleNames: parseList(els.whaleNames.value),
      keywords: parseList(els.keywordList.value)
    });
  }

  function saveConfig(config, message) {
    chrome.storage.local.set({ [STORAGE_KEYS.config]: config }, () => {
      showToast(message || "已应用");
    });
  }

  // ---------------- 事件绑定 ----------------

  els.thresholdRange.min = String(THRESHOLD_MIN);
  els.thresholdRange.max = String(THRESHOLD_MAX);

  els.thresholdRange.addEventListener("input", () => {
    updateThresholdLabel(els.thresholdRange.value);
  });

  els.modeTag.addEventListener("change", syncFormState);
  els.modeBlock.addEventListener("change", syncFormState);
  els.blockFish.addEventListener("change", syncFormState);
  els.blockKeywords.addEventListener("change", syncFormState);

  // 总开关即时生效（其余选项点「保存并应用」）
  els.enabled.addEventListener("change", () => {
    chrome.storage.local.get([STORAGE_KEYS.config], (result) => {
      const next = normalizeConfig({
        ...normalizeConfig(result && result[STORAGE_KEYS.config]),
        enabled: els.enabled.checked
      });
      saveConfig(next, els.enabled.checked ? "已启用" : "已停用");
    });
  });

  els.saveBtn.addEventListener("click", () => {
    saveConfig(readFormConfig());
    els.saveBtn.textContent = "已应用 ✔";
    setTimeout(() => {
      els.saveBtn.textContent = "保存并应用";
    }, 1200);
  });

  els.resetBtn.addEventListener("click", () => {
    els.enabled.checked = DEFAULT_CONFIG.enabled;
    els.modeTag.checked = true;
    els.modeBlock.checked = false;
    els.thresholdRange.value = String(DEFAULT_CONFIG.blockThreshold);
    updateThresholdLabel(DEFAULT_CONFIG.blockThreshold);
    els.blockFish.checked = DEFAULT_CONFIG.blockFishDisaster;
    els.blockOfficial.checked = DEFAULT_CONFIG.blockOfficialAISummary;
    els.blockKeywords.checked = DEFAULT_CONFIG.blockByKeywords;
    els.whaleNames.value = DEFAULT_CONFIG.whaleNames.join("\n");
    els.keywordList.value = DEFAULT_CONFIG.keywords.join("\n");
    syncFormState();
    showToast("已恢复默认值（尚未保存）");
  });

  els.resetCount.addEventListener("click", () => {
    chrome.storage.local.set({ [STORAGE_KEYS.count]: 0 }, () => {
      updateCountLabel(0);
      showToast("计数已清零");
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEYS.count]) {
      updateCountLabel(changes[STORAGE_KEYS.count].newValue || 0);
    }
  });

  // ---------------- 初始化 ----------------

  chrome.storage.local.get([STORAGE_KEYS.config, STORAGE_KEYS.count], (result) => {
    fillForm(result && result[STORAGE_KEYS.config]);
    updateCountLabel(result && result[STORAGE_KEYS.count]);
  });
})();

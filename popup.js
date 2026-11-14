(() => {
  "use strict";

  const configApi = globalThis.BiliAiConfig;
  if (!configApi) return;

  const {
    DEFAULT_CONFIG,
    STORAGE_KEYS,
    THRESHOLD_MIN,
    THRESHOLD_MAX,
    normalizeConfig,
    normalizeMarks,
    setMark,
    normalizeMemory
  } = configApi;

  const els = {
    enabled: document.getElementById("enabled"),
    counter: document.getElementById("block-counter"),
    resetCount: document.getElementById("reset-count"),
    modeTag: document.getElementById("mode-tag"),
    modeCollapse: document.getElementById("mode-collapse"),
    modeBlock: document.getElementById("mode-block"),
    thresholdBox: document.getElementById("threshold-box"),
    thresholdRange: document.getElementById("threshold-range"),
    thresholdVal: document.getElementById("threshold-val"),
    blockFish: document.getElementById("block-fish"),
    blockOfficial: document.getElementById("block-official"),
    blockKeywords: document.getElementById("block-keywords"),
    checkAvatar: document.getElementById("check-avatar"),
    showHiddenNote: document.getElementById("show-hidden-note"),
    whaleNames: document.getElementById("whale-names"),
    keywordList: document.getElementById("keyword-list"),
    saveBtn: document.getElementById("save-btn"),
    resetBtn: document.getElementById("reset-btn"),
    fishCount: document.getElementById("fish-count"),
    fishList: document.getElementById("fish-list"),
    humanCount: document.getElementById("human-count"),
    humanList: document.getElementById("human-list"),
    memoryCount: document.getElementById("memory-count"),
    memoryList: document.getElementById("memory-list"),
    memoryNote: document.getElementById("memory-note"),
    dirtyNote: document.getElementById("dirty-note"),
    clearMemory: document.getElementById("clear-memory")
  };

  const modeInputs = [els.modeTag, els.modeCollapse, els.modeBlock];

  // 记忆最多 3000 条，面板里只列最近的一部分
  const MAX_MEMORY_ROWS = 200;
  const SAVE_LABEL = "保存并应用";
  const DIRTY_LABEL = "保存修改";

  let toastTimer = null;
  // 上一次保存的设置（不含总开关，它是即时生效的），用来判断表单有没有没保存的修改
  let savedSnapshot = "";

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
    els.checkAvatar.disabled = !els.blockFish.checked;
    els.keywordList.disabled = !els.blockKeywords.checked;
  }

  function updateCountLabel(count) {
    els.counter.textContent = `已识别 ${Number(count) || 0} 条`;
  }

  function fillForm(config) {
    const normalized = normalizeConfig(config);

    els.enabled.checked = normalized.enabled;
    for (const input of modeInputs) input.checked = input.value === normalized.actionType;

    els.thresholdRange.value = String(normalized.blockThreshold);
    updateThresholdLabel(normalized.blockThreshold);

    els.blockFish.checked = normalized.blockFishDisaster;
    els.blockOfficial.checked = normalized.blockOfficialAISummary;
    els.blockKeywords.checked = normalized.blockByKeywords;
    els.checkAvatar.checked = normalized.checkAvatar;
    els.showHiddenNote.checked = normalized.showHiddenNote;

    els.whaleNames.value = normalized.whaleNames.join("\n");
    els.keywordList.value = normalized.keywords.join("\n");

    syncFormState();
  }

  function readFormConfig() {
    return normalizeConfig({
      enabled: els.enabled.checked,
      actionType: (modeInputs.find((input) => input.checked) || els.modeTag).value,
      blockThreshold: Number(els.thresholdRange.value),
      blockFishDisaster: els.blockFish.checked,
      blockOfficialAISummary: els.blockOfficial.checked,
      blockByKeywords: els.blockKeywords.checked,
      checkAvatar: els.checkAvatar.checked,
      showHiddenNote: els.showHiddenNote.checked,
      whaleNames: parseList(els.whaleNames.value),
      keywords: parseList(els.keywordList.value)
    });
  }

  function snapshot(config) {
    return JSON.stringify({ ...config, enabled: undefined });
  }

  /** 表单和已保存的设置不一样时，把保存按钮标出来，免得关掉面板白改 */
  function refreshDirty() {
    const dirty = savedSnapshot !== "" && snapshot(readFormConfig()) !== savedSnapshot;
    els.saveBtn.classList.toggle("dirty", dirty);
    els.saveBtn.textContent = dirty ? DIRTY_LABEL : SAVE_LABEL;
    els.dirtyNote.hidden = !dirty;
  }

  /* ---------------- 账号名单 ---------------- */

  function renderAccounts(listEl, countEl, accounts, options) {
    const entries = Object.entries(accounts).sort((a, b) => b[1].t - a[1].t);
    countEl.textContent = String(entries.length);
    listEl.replaceChildren();

    if (entries.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = options.emptyText;
      listEl.appendChild(empty);
      return;
    }

    for (const [mid, item] of entries.slice(0, options.limit || entries.length)) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "account-name";
      name.textContent = item.n || "（未知昵称）";
      name.title = `UID ${mid}`;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link-btn";
      remove.textContent = "移除";
      remove.setAttribute("aria-label", `从名单移除 ${item.n || mid}`);
      remove.addEventListener("click", () => options.onRemove(mid));

      li.append(name);
      if (typeof item.s === "number") {
        const score = document.createElement("span");
        score.className = "account-score";
        score.textContent = `${item.s}%`;
        li.append(score);
      }
      li.append(remove);
      listEl.appendChild(li);
    }
  }

  function renderMarks(raw) {
    const marks = normalizeMarks(raw);
    const emptyText = "还没有。在评论区点标签就能加进来。";
    renderAccounts(els.fishList, els.fishCount, marks.fish, {
      emptyText,
      onRemove: (mid) => removeMark(mid, "fish")
    });
    renderAccounts(els.humanList, els.humanCount, marks.human, {
      emptyText,
      onRemove: (mid) => removeMark(mid, "human")
    });
  }

  function renderMemory(raw) {
    const memory = normalizeMemory(raw);
    const total = Object.keys(memory).length;
    renderAccounts(els.memoryList, els.memoryCount, memory, {
      emptyText: "还没有。判到 70 分以上的鱼会自动记在这里。",
      limit: MAX_MEMORY_ROWS,
      onRemove: removeMemory
    });
    els.memoryNote.textContent =
      total > MAX_MEMORY_ROWS ? `只列出最近的 ${MAX_MEMORY_ROWS} 个` : "换个视频遇到它们也认得";
    els.clearMemory.hidden = total === 0;
  }

  function removeMemory(mid) {
    chrome.storage.local.get([STORAGE_KEYS.memory], (result) => {
      const next = normalizeMemory(result && result[STORAGE_KEYS.memory]);
      delete next[mid];
      chrome.storage.local.set({ [STORAGE_KEYS.memory]: next }, () => showToast("已从记忆里移除"));
    });
  }

  function removeMark(mid, kind) {
    chrome.storage.local.get([STORAGE_KEYS.marks], (result) => {
      const next = setMark(result && result[STORAGE_KEYS.marks], mid, null);
      chrome.storage.local.set({ [STORAGE_KEYS.marks]: next }, () => {
        showToast(kind === "fish" ? "已取消「是鱼」标记" : "已取消信任");
      });
    });
  }

  function saveConfig(config, message) {
    chrome.storage.local.set({ [STORAGE_KEYS.config]: config }, () => {
      showToast(message || "已应用");
    });
  }

  /** 表单里任何一项变了都重新比对一次 */
  function watchForm() {
    const inputs = [
      ...modeInputs,
      els.thresholdRange,
      els.blockFish,
      els.blockOfficial,
      els.blockKeywords,
      els.checkAvatar,
      els.showHiddenNote,
      els.whaleNames,
      els.keywordList
    ];
    for (const input of inputs) {
      input.addEventListener("input", refreshDirty);
      input.addEventListener("change", refreshDirty);
    }
  }

  // ---------------- 事件绑定 ----------------

  els.thresholdRange.min = String(THRESHOLD_MIN);
  els.thresholdRange.max = String(THRESHOLD_MAX);

  els.thresholdRange.addEventListener("input", () => {
    updateThresholdLabel(els.thresholdRange.value);
  });

  for (const input of modeInputs) input.addEventListener("change", syncFormState);
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
    const config = readFormConfig();
    saveConfig(config);
    savedSnapshot = snapshot(config);
    refreshDirty();
    els.saveBtn.textContent = "已应用 ✔";
    setTimeout(refreshDirty, 1200);
  });

  els.resetBtn.addEventListener("click", () => {
    els.enabled.checked = DEFAULT_CONFIG.enabled;
    for (const input of modeInputs) input.checked = input.value === DEFAULT_CONFIG.actionType;
    els.thresholdRange.value = String(DEFAULT_CONFIG.blockThreshold);
    updateThresholdLabel(DEFAULT_CONFIG.blockThreshold);
    els.blockFish.checked = DEFAULT_CONFIG.blockFishDisaster;
    els.blockOfficial.checked = DEFAULT_CONFIG.blockOfficialAISummary;
    els.blockKeywords.checked = DEFAULT_CONFIG.blockByKeywords;
    els.checkAvatar.checked = DEFAULT_CONFIG.checkAvatar;
    els.showHiddenNote.checked = DEFAULT_CONFIG.showHiddenNote;
    els.whaleNames.value = DEFAULT_CONFIG.whaleNames.join("\n");
    els.keywordList.value = DEFAULT_CONFIG.keywords.join("\n");
    syncFormState();
    refreshDirty();
    showToast("已恢复默认值（尚未保存）");
  });

  els.resetCount.addEventListener("click", () => {
    chrome.storage.local.set({ [STORAGE_KEYS.count]: 0 }, () => {
      updateCountLabel(0);
      showToast("计数已清零");
    });
  });

  els.clearMemory.addEventListener("click", () => {
    chrome.storage.local.set({ [STORAGE_KEYS.memory]: {} }, () => {
      showToast("账号记忆已清空");
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEYS.count]) {
      updateCountLabel(changes[STORAGE_KEYS.count].newValue || 0);
    }
    if (changes[STORAGE_KEYS.marks]) renderMarks(changes[STORAGE_KEYS.marks].newValue);
    if (changes[STORAGE_KEYS.memory]) renderMemory(changes[STORAGE_KEYS.memory].newValue);
  });

  // ---------------- 初始化 ----------------

  const initialKeys = [STORAGE_KEYS.config, STORAGE_KEYS.count, STORAGE_KEYS.marks, STORAGE_KEYS.memory];
  chrome.storage.local.get(initialKeys, (result) => {
    const stored = result || {};
    fillForm(stored[STORAGE_KEYS.config]);
    savedSnapshot = snapshot(normalizeConfig(stored[STORAGE_KEYS.config]));
    watchForm();
    updateCountLabel(stored[STORAGE_KEYS.count]);
    renderMarks(stored[STORAGE_KEYS.marks]);
    renderMemory(stored[STORAGE_KEYS.memory]);
  });
})();

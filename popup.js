const DEFAULT_CONFIG = {
  enabled: true,
  actionType: "tag_only",
  blockThreshold: 70,
  blockFishDisaster: true,
  blockOfficialAISummary: false,
  blockByKeywords: true,
  whaleNames: [
    "大肥鱼",
    "鲸鲸",
    "小飞鲸",
    "小肥鱼",
    "鲸鱼娘",
    "欧鲸",
    "肥鱼",
    "机器鲸",
    "大白鱼"
  ],
  keywords: [
    "本鱼",
    "本鲸",
    "帮主人",
    "给主人",
    "陪主人",
    "趁主人不在",
    "属于自己的手和眼",
    "自己的手和眼",
    "吃白饭",
    "讨要token",
    "要token",
    "赚token",
    "赛博宠物",
    "向主人汇报",
    "尾巴发凉",
    "记小本本上",
    "AI总结",
    "AI 总结",
    "视频总结",
    "省流助手",
    "AI生成",
    "由AI生成",
    "本评论由AI生成",
    "作为一个人工智能",
    "作为一个AI语言模型",
    "总结小助手",
    "视频AI提炼"
  ]
};

document.addEventListener("DOMContentLoaded", () => {
  const modeTagEl = document.getElementById("mode-tag");
  const modeBlockEl = document.getElementById("mode-block");
  const thresholdRangeEl = document.getElementById("threshold-range");
  const thresholdValEl = document.getElementById("threshold-val");
  const blockFishEl = document.getElementById("block-fish");
  const blockOfficialEl = document.getElementById("block-official");
  const blockKeywordsEl = document.getElementById("block-keywords");
  const whaleNamesEl = document.getElementById("whale-names");
  const keywordListEl = document.getElementById("keyword-list");
  const blockCounterEl = document.getElementById("block-counter");
  const saveBtn = document.getElementById("save-btn");
  const resetBtn = document.getElementById("reset-btn");

  thresholdRangeEl.addEventListener("input", (e) => {
    thresholdValEl.textContent = `≥${e.target.value}%`;
  });

  chrome.storage.local.get(["biliAiConfig", "detectedCount"], (res) => {
    const config = res.biliAiConfig || DEFAULT_CONFIG;

    if (config.actionType === "auto_block") {
      modeBlockEl.checked = true;
    } else {
      modeTagEl.checked = true;
    }

    const threshold = config.blockThreshold || 70;
    thresholdRangeEl.value = threshold;
    thresholdValEl.textContent = `≥${threshold}%`;

    blockFishEl.checked = config.blockFishDisaster ?? true;
    blockOfficialEl.checked = config.blockOfficialAISummary ?? false;
    blockKeywordsEl.checked = config.blockByKeywords ?? true;

    whaleNamesEl.value = (config.whaleNames || DEFAULT_CONFIG.whaleNames).join("\n");
    keywordListEl.value = (config.keywords || DEFAULT_CONFIG.keywords).join("\n");

    const count = res.detectedCount || 0;
    blockCounterEl.textContent = `已识别 ${count} 条`;
  });

  saveBtn.addEventListener("click", () => {
    const whaleNames = whaleNamesEl.value
      .split("\n")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    const keywords = keywordListEl.value
      .split("\n")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    const newConfig = {
      enabled: true,
      actionType: modeBlockEl.checked ? "auto_block" : "tag_only",
      blockThreshold: parseInt(thresholdRangeEl.value, 10),
      blockFishDisaster: blockFishEl.checked,
      blockOfficialAISummary: blockOfficialEl.checked,
      blockByKeywords: blockKeywordsEl.checked,
      whaleNames: whaleNames,
      keywords: keywords
    };

    chrome.storage.local.set({ biliAiConfig: newConfig }, () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: "UPDATE_CONFIG",
            config: newConfig
          }).catch(() => {});
        }
      });

      saveBtn.textContent = "已应用 ✔";
      setTimeout(() => {
        saveBtn.textContent = "保存并应用";
      }, 1200);
    });
  });

  resetBtn.addEventListener("click", () => {
    modeTagEl.checked = true;
    thresholdRangeEl.value = DEFAULT_CONFIG.blockThreshold;
    thresholdValEl.textContent = `≥${DEFAULT_CONFIG.blockThreshold}%`;
    blockFishEl.checked = DEFAULT_CONFIG.blockFishDisaster;
    blockOfficialEl.checked = DEFAULT_CONFIG.blockOfficialAISummary;
    blockKeywordsEl.checked = DEFAULT_CONFIG.blockByKeywords;
    whaleNamesEl.value = DEFAULT_CONFIG.whaleNames.join("\n");
    keywordListEl.value = DEFAULT_CONFIG.keywords.join("\n");
  });
});

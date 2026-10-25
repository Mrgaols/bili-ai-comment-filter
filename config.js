/**
 * 共享配置：默认值 + 读写键名 + 配置校验。
 *
 * 该文件会被同时加载到：
 *   1. content script（manifest.json 的 content_scripts.js 数组第一位）
 *   2. popup（popup.html 里排在 popup.js 之前）
 *   3. 单元测试（Node.js require）
 *
 * 因此这里不能出现任何 DOM / chrome API 调用，只做纯数据处理。
 */
(function (root, factory) {
  "use strict";

  const api = factory();

  // Node.js（单元测试）
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  // 浏览器 / content script 的隔离世界
  root.BiliAiConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STORAGE_KEYS = Object.freeze({
    config: "biliAiConfig",
    count: "detectedCount"
  });

  const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    // "tag_only": 只打标；"auto_block": 达到阈值自动隐藏
    actionType: "tag_only",
    blockThreshold: 70,
    // 鱼灾专项：昵称库 + 人设口癖（Token / 主人 / 尾巴 …）
    blockFishDisaster: true,
    // 隐藏评论区置顶的官方 AI 总结
    blockOfficialAISummary: true,
    // 启用正文特征词库
    blockByKeywords: true,

    // 只匹配用户名，绝不匹配正文
    whaleNames: [
      "鲸鲸",
      "欧鲸鲸",
      "大肥鱼",
      "小肥鱼",
      "小飞鲸",
      "鲸鱼娘",
      "欧鲸",
      "肥鱼",
      "机器鲸",
      "大白鱼"
    ],

    // 只匹配正文；命中任意一条记 60 分
    keywords: [
      "AI总结",
      "AI 总结",
      "视频总结",
      "视频AI提炼",
      "省流助手",
      "总结小助手",
      "作为一个人工智能",
      "作为一个AI语言模型",
      "作为一个ai",
      "大模型生成",
      "AI生成",
      "由AI生成",
      "本评论由AI生成"
    ]
  });

  const THRESHOLD_MIN = 50;
  const THRESHOLD_MAX = 95;
  const MAX_LIST_ITEMS = 200;
  const MAX_LIST_ITEM_LENGTH = 40;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function toBool(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }

  /** 清洗字符串列表：去空、去重、限长、限量 */
  function cleanList(value, fallback) {
    const source = Array.isArray(value) ? value : fallback;
    const out = [];
    const seen = new Set();

    for (const item of source) {
      if (typeof item !== "string") continue;
      const text = item.trim().slice(0, MAX_LIST_ITEM_LENGTH);
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= MAX_LIST_ITEMS) break;
    }

    return out.length > 0 ? out : fallback.slice();
  }

  /**
   * 把 storage 里的任意内容规整成合法配置。
   * 缺失字段回落到默认值，非法值不会把界面搞崩。
   */
  function normalizeConfig(raw) {
    const input = raw && typeof raw === "object" ? raw : {};
    const out = {
      enabled: toBool(input.enabled, DEFAULT_CONFIG.enabled),
      actionType: input.actionType === "auto_block" ? "auto_block" : "tag_only",
      blockThreshold: DEFAULT_CONFIG.blockThreshold,
      blockFishDisaster: toBool(input.blockFishDisaster, DEFAULT_CONFIG.blockFishDisaster),
      blockOfficialAISummary: toBool(
        input.blockOfficialAISummary,
        DEFAULT_CONFIG.blockOfficialAISummary
      ),
      blockByKeywords: toBool(input.blockByKeywords, DEFAULT_CONFIG.blockByKeywords),
      whaleNames: cleanList(input.whaleNames, DEFAULT_CONFIG.whaleNames),
      keywords: cleanList(input.keywords, DEFAULT_CONFIG.keywords)
    };

    const threshold = Number(input.blockThreshold);
    if (Number.isFinite(threshold)) {
      out.blockThreshold = clamp(Math.round(threshold), THRESHOLD_MIN, THRESHOLD_MAX);
    }

    return out;
  }

  return {
    STORAGE_KEYS,
    DEFAULT_CONFIG,
    THRESHOLD_MIN,
    THRESHOLD_MAX,
    MIN_TAG_SCORE: 50,
    normalizeConfig,
    clamp
  };
});

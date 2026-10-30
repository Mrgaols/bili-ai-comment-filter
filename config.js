/**
 * 共享配置：默认值 + 读写键名 + 配置校验，以及手动标记名单 / 账号记忆的规整。
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
    count: "detectedCount",
    // 手动标记：{ fish: { mid: { n: 昵称, t: 时间 } }, human: { … } }
    marks: "biliAiMarks",
    // 账号记忆：被判定为鱼的账号 { mid: { s: 最高分, n: 昵称, t: 时间 } }
    memory: "biliAiMemory"
  });

  const ACTION_TYPES = Object.freeze(["tag_only", "auto_collapse", "auto_block"]);

  const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    // "tag_only": 只打标；"auto_collapse": 达到阈值自动折叠；"auto_block": 达到阈值自动隐藏
    actionType: "tag_only",
    blockThreshold: 70,
    // 鱼灾专项：昵称 / 签名 / 等级 + 正文人设 + 被点名 + 账号记忆
    blockFishDisaster: true,
    // 隐藏评论区置顶的官方 AI 总结
    blockOfficialAISummary: true,
    // 启用正文特征词库
    blockByKeywords: true,
    // 看头像颜色：鲸鱼娘头像大片是蓝色（会从 B 站图床加载一张 48px 的头像小图）
    checkAvatar: true,

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

    // 只匹配正文；出现在开头 / 作为结尾署名记 60 分，句中提及记 30 分
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
  const MAX_MARKS = 1000;
  const MAX_MEMORY = 3000;
  const MID_RE = /^\d{1,20}$/;

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
      actionType: ACTION_TYPES.includes(input.actionType) ? input.actionType : "tag_only",
      blockThreshold: DEFAULT_CONFIG.blockThreshold,
      blockFishDisaster: toBool(input.blockFishDisaster, DEFAULT_CONFIG.blockFishDisaster),
      blockOfficialAISummary: toBool(
        input.blockOfficialAISummary,
        DEFAULT_CONFIG.blockOfficialAISummary
      ),
      blockByKeywords: toBool(input.blockByKeywords, DEFAULT_CONFIG.blockByKeywords),
      checkAvatar: toBool(input.checkAvatar, DEFAULT_CONFIG.checkAvatar),
      whaleNames: cleanList(input.whaleNames, DEFAULT_CONFIG.whaleNames),
      keywords: cleanList(input.keywords, DEFAULT_CONFIG.keywords)
    };

    const threshold = Number(input.blockThreshold);
    if (Number.isFinite(threshold)) {
      out.blockThreshold = clamp(Math.round(threshold), THRESHOLD_MIN, THRESHOLD_MAX);
    }

    return out;
  }

  function cleanName(value) {
    return typeof value === "string" ? value.trim().slice(0, MAX_LIST_ITEM_LENGTH) : "";
  }

  function cleanTime(value) {
    const time = Number(value);
    return Number.isFinite(time) && time > 0 ? Math.round(time) : 0;
  }

  /** 只保留最近的 limit 条（按时间倒序） */
  function newest(entries, limit) {
    return entries.sort((a, b) => b[1].t - a[1].t).slice(0, limit);
  }

  function cleanMarkList(raw) {
    const input = raw && typeof raw === "object" ? raw : {};
    const entries = [];
    for (const [mid, value] of Object.entries(input)) {
      if (!MID_RE.test(mid)) continue;
      const item = value && typeof value === "object" ? value : {};
      entries.push([mid, { n: cleanName(item.n), t: cleanTime(item.t) }]);
    }
    return Object.fromEntries(newest(entries, MAX_MARKS));
  }

  /** 手动标记名单：同一个账号只能在一边 */
  function normalizeMarks(raw) {
    const input = raw && typeof raw === "object" ? raw : {};
    const fish = cleanMarkList(input.fish);
    const human = cleanMarkList(input.human);
    for (const mid of Object.keys(human)) delete fish[mid];
    return { fish, human };
  }

  /** 把一个账号标记为 "fish" / "human"，或者用 null 取消标记；返回新对象 */
  function setMark(marks, mid, kind, name, now) {
    const out = normalizeMarks(marks);
    const key = String(mid || "");
    if (!MID_RE.test(key)) return out;

    delete out.fish[key];
    delete out.human[key];
    if (kind === "fish" || kind === "human") {
      out[kind][key] = { n: cleanName(name), t: cleanTime(now) || Date.now() };
    }
    return normalizeMarks(out);
  }

  function markOf(marks, mid) {
    const key = String(mid || "");
    if (!key || !marks) return null;
    if (marks.human && marks.human[key]) return "human";
    if (marks.fish && marks.fish[key]) return "fish";
    return null;
  }

  /** 账号记忆：分数限定在 50-99，超出上限时丢掉最久没见过的 */
  function normalizeMemory(raw) {
    const input = raw && typeof raw === "object" ? raw : {};
    const entries = [];
    for (const [mid, value] of Object.entries(input)) {
      if (!MID_RE.test(mid)) continue;
      const item = value && typeof value === "object" ? value : {};
      const score = Number(item.s);
      if (!Number.isFinite(score) || score < 50) continue;
      entries.push([mid, { s: clamp(Math.round(score), 50, 99), n: cleanName(item.n), t: cleanTime(item.t) }]);
    }
    return Object.fromEntries(newest(entries, MAX_MEMORY));
  }

  /** 合并两份记忆（多个标签页各自写入时用）：同一账号取更高分和更晚时间 */
  function mergeMemory(base, extra) {
    const out = normalizeMemory(base);
    for (const [mid, item] of Object.entries(normalizeMemory(extra))) {
      const old = out[mid];
      out[mid] = old
        ? { s: Math.max(old.s, item.s), n: item.n || old.n, t: Math.max(old.t, item.t) }
        : item;
    }
    return normalizeMemory(out);
  }

  return {
    STORAGE_KEYS,
    DEFAULT_CONFIG,
    ACTION_TYPES,
    THRESHOLD_MIN,
    THRESHOLD_MAX,
    MAX_MARKS,
    MAX_MEMORY,
    MIN_TAG_SCORE: 50,
    normalizeConfig,
    normalizeMarks,
    setMark,
    markOf,
    normalizeMemory,
    mergeMemory,
    clamp
  };
});

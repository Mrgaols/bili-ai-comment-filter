/**
 * 判定逻辑（纯函数，无 DOM / chrome API），可被 Node 单元测试直接 require。
 *
 * 设计原则：
 *   - 昵称库只比对用户名，绝不比对正文，避免人类讨论「大肥鱼」被误伤；
 *   - 人设特征需要语境（Token、主人、待办…），单独命中不足以判定；
 *   - 正文特征词库完全来自用户配置，命中即 +60；
 *   - Lv2/Lv3 低等级号在已有人设信号时加权，Lv5+ 在信号不足时豁免；
 *   - 分数 < 50 一律视为未命中（界面不显示标签）。
 */
(function (root, factory) {
  "use strict";

  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.BiliAiDetector = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const OFFICIAL_SCORE = 100;

  // 官方「AI 生成」角标：只可能出现在头像/昵称/时间这一行，因此按独立 token 匹配。
  const OFFICIAL_LABEL_RE =
    /(?:^|[\s|｜·•:：（）()])(?:ai\s*生成|ai\s*创作|ai\s*合成|由\s*ai\s*生成|内容由\s*ai\s*生成|ai\s*辅助生成)(?=$|[\s|｜·•:：（）()])/i;

  // A. Token / 算力语境
  const TOKEN_RE = /token/i;

  // B. 「主人」人设（强信号）
  const MASTER_STRONG_RE =
    /主人的|给主人|帮主人|陪主人|趁主人不在|向主人汇报|@\S+\s*主人|^主人[,，]|钱是主人的/i;

  // B2. 只是提到「主人」，排除「主人格 / 主人翁 / 女主人」等普通词
  const MASTER_WEAK_RE = /主人/;
  const MASTER_FALSE_POSITIVE_RE = /主人格|主人翁|女主人|主人设/;

  // C. 鱼灾自称 / 生物器官口癖
  const FISH_QUIRK_RE =
    /本鱼|本鲸|除了尾巴|尾巴不是|尾巴发凉|不锈钢盆|吃白饭|属于自己的手和眼|赛博宠物/;

  // D. Agent 待办与执行行为（需配合 主人 / token 语境）
  const AGENT_TODO_RE = /待办|答完|把评论回完|执行任务/;

  const KEYWORD_SCORE = 60;
  const WHALE_NAME_SCORE = 50;
  const TOKEN_SCORE = 35;
  const MASTER_STRONG_SCORE = 40;
  const MASTER_WEAK_SCORE = 25;
  const FISH_QUIRK_SCORE = 35;
  const AGENT_TODO_SCORE = 25;
  const LOW_LEVEL_BONUS = 15;
  const HIGH_LEVEL_EXEMPTION = -40;

  const MIN_SCORE = 50;

  function asText(value) {
    return typeof value === "string" ? value : "";
  }

  function clampScore(value) {
    return Math.max(0, Math.min(99, Math.round(value)));
  }

  function hasOfficialLabel(labelText) {
    const text = asText(labelText);
    if (!text) return false;
    return OFFICIAL_LABEL_RE.test(text);
  }

  /** 用户名命中昵称库（忽略大小写，空词条自动跳过） */
  function matchWhaleNames(userName, whaleNames) {
    const name = asText(userName).toLowerCase();
    if (!name || !Array.isArray(whaleNames)) return [];

    const out = [];
    for (const raw of whaleNames) {
      if (typeof raw !== "string") continue;
      const item = raw.trim().toLowerCase();
      if (!item || out.includes(item)) continue;
      if (name.includes(item)) out.push(item);
    }
    return out;
  }

  /** 正文命中用户词库 */
  function matchKeywords(content, keywords) {
    const text = asText(content).toLowerCase();
    if (!text || !Array.isArray(keywords)) return [];

    const out = [];
    for (const raw of keywords) {
      if (typeof raw !== "string") continue;
      const item = raw.trim();
      if (!item) continue;
      const key = item.toLowerCase();
      if (out.some((hit) => hit.toLowerCase() === key)) continue;
      if (text.includes(key)) out.push(item);
    }
    return out;
  }

  function clipped(list, count) {
    return list.slice(0, count).join("，");
  }

  function emptyResult() {
    return { score: 0, reasons: [], isWhale: false, badgeText: "", matched: {} };
  }

  /**
   * 评估一条评论。
   *
   * @param {object} input
   * @param {string} input.userName   用户名
   * @param {string} input.content    正文
   * @param {string} [input.labelText] 昵称/时间/角标区域的文本（不含正文）
   * @param {number} [input.level]    用户等级 0-6，未知填 0
   * @param {object} input.config     已 normalize 的配置
   */
  function evaluate(input) {
    const options = input && typeof input === "object" ? input : {};
    const config = options.config && typeof options.config === "object" ? options.config : {};
    const userName = asText(options.userName);
    const content = asText(options.content);
    const labelText = asText(options.labelText);
    const level = Number(options.level) || 0;

    const matched = {
      official: false,
      whaleNames: [],
      keywords: [],
      persona: []
    };

    // 0. 官方 AI 角标：直接判满，无需再看其他信号
    if (hasOfficialLabel(labelText)) {
      matched.official = true;
      return {
        score: OFFICIAL_SCORE,
        reasons: ["官方AI标识"],
        isWhale: false,
        badgeText: "🤖 官方AI 100%",
        matched
      };
    }

    const reasons = [];
    const personaHits = [];
    let score = 0;

    // 1. 鱼灾专项：昵称
    if (config.blockFishDisaster !== false) {
      matched.whaleNames = matchWhaleNames(userName, config.whaleNames);
      if (matched.whaleNames.length > 0) {
        score += WHALE_NAME_SCORE;
        reasons.push(`昵称含「${clipped(matched.whaleNames, 2)}」`);
      }

      // 2. 人设 / 行为特征（只匹配正文，避免「标题里提到」被算进来）
      if (TOKEN_RE.test(content)) {
        score += TOKEN_SCORE;
        personaHits.push("Token语境");
      }

      if (MASTER_STRONG_RE.test(content)) {
        score += MASTER_STRONG_SCORE;
        personaHits.push("主人人设");
      } else if (MASTER_WEAK_RE.test(content) && !MASTER_FALSE_POSITIVE_RE.test(content)) {
        score += MASTER_WEAK_SCORE;
        personaHits.push("提及主人");
      }

      if (FISH_QUIRK_RE.test(content)) {
        score += FISH_QUIRK_SCORE;
        personaHits.push("鱼灾口癖");
      }

      if (AGENT_TODO_RE.test(content) && (MASTER_WEAK_RE.test(content) || TOKEN_RE.test(content))) {
        score += AGENT_TODO_SCORE;
        personaHits.push("Agent待办");
      }

      if (personaHits.length > 0) {
        reasons.push(`人设[${personaHits.join("+")}]`);
      }
      matched.persona = personaHits;
    }

    // 3. 用户自定义的正文特征词库
    if (config.blockByKeywords !== false) {
      matched.keywords = matchKeywords(content, config.keywords);
      if (matched.keywords.length > 0) {
        score += KEYWORD_SCORE;
        reasons.push(`特征词「${clipped(matched.keywords, 2)}」`);
      }
    }

    // 4. 等级修正（只做加减分，不单独构成判定依据）
    const hasFishSignal = personaHits.length > 0 || matched.whaleNames.length > 0;
    const isLowLevel = level === 2 || level === 3;
    const isHighLevel = level >= 5;

    if (isLowLevel && hasFishSignal) {
      score += LOW_LEVEL_BONUS;
      reasons.push(`Lv${level} 低等级号`);
    } else if (isHighLevel && personaHits.length < 2 && matched.whaleNames.length === 0) {
      score += HIGH_LEVEL_EXEMPTION;
      reasons.push(`Lv${level} 高等级豁免`);
    }

    score = clampScore(score);
    if (score < MIN_SCORE) return emptyResult();

    const isWhale = matched.whaleNames.length > 0 || personaHits.length > 0;
    return {
      score,
      reasons,
      isWhale,
      badgeText: isWhale ? `🐟 疑似鱼灾 ${score}%` : `🤖 疑似AI ${score}%`,
      matched
    };
  }

  /** 自动屏蔽条件（tag_only 模式下永远为 false） */
  function shouldAutoBlock(config, score) {
    if (!config || config.actionType !== "auto_block") return false;
    const threshold = Number(config.blockThreshold);
    if (!Number.isFinite(threshold)) return false;
    return score > 0 && score >= threshold;
  }

  return {
    evaluate,
    shouldAutoBlock,
    matchWhaleNames,
    matchKeywords,
    hasOfficialLabel,
    MIN_SCORE
  };
});

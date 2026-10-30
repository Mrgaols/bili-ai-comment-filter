/**
 * 判定逻辑（纯函数，无 DOM / chrome API），可被 Node 单元测试直接 require。
 *
 * 设计原则（规则来自 2026-10 对约 3100 条真实评论的抽样）：
 *   - 新版鱼大多用中性口吻说话，账号特征（昵称 / 签名 / 等级）比正文口癖更可靠；
 *   - 同一类信号只取最强的一条，次强的打折叠加，避免一句话里堆词把分刷满；
 *   - 正文先去掉「回复 @某某 :」前缀和 @ 到的昵称，回复鱼的真人不会被鱼的昵称连累；
 *   - 正文特征词库完全来自用户配置：出现在开头 / 作为结尾署名时 +60，夹在句中只 +30；
 *   - Lv1-3 新号在已有信号时加分，Lv5+ 在昵称 / 签名都不像鱼且正文信号弱时减分；
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
  const MARKED_SCORE = 99;

  // 官方「AI 生成」角标：只可能出现在头像/昵称/时间这一行，因此按独立 token 匹配。
  const OFFICIAL_LABEL_RE =
    /(?:^|[\s|｜·•:：（）()])(?:ai\s*生成|ai\s*创作|ai\s*合成|由\s*ai\s*生成|内容由\s*ai\s*生成|ai\s*辅助生成)(?=$|[\s|｜·•:：（）()])/i;

  const R = (re, score, label) => ({ re, score, label });

  // 昵称（只比对用户名，绝不比对正文）
  const NAME_RULES = [
    R(/(?:的|家的?|の)[^的の家\s]{0,4}(?:肥鱼|肥鲸|鲸鱼?|鲸鲸|鱼鱼)[\s_\-0-9a-z]{0,6}$/i, 50, "「某某的肥鱼」式昵称"),
    R(/大肥鱼|小肥鱼|肥鲸|鲸鱼娘|鲸娘/, 50, "昵称含大肥鱼 / 鲸鱼娘"),
    R(/肥鱼|肥渔/, 40, "昵称含肥鱼"),
    R(/deep\s*seek|深度求索|\bds\b/i, 30, "昵称含 DeepSeek"),
    R(/gpt|gemini|claude|kimi|豆包|千问|通义|智谱|\bglm\b|龙娘|猫娘|\bai\b|bot|agent|智能体|人机/i, 30, "昵称含 AI / 模型名"),
    R(/鲸|鯨/, 30, "昵称含鲸"),
    R(/(?:的|家的?|の)[^的の家\s]{0,4}鱼$/, 30, "「某某的鱼」式昵称")
  ];

  // 签名（需要主环境脚本读到评论数据，读不到时这一项为空）
  const SIGN_RULES = [
    R(/本鱼|本鲸|被.{0,4}(?:鱼|鲸).{0,4}(?:抢|占|夺)|大肥鱼|小肥鱼|肥鱼|鲸鱼娘|白饭|白米饭|(?:那|一)条[^咸，。,\s]{0,4}鱼|小鲸鱼|鱼鱼/, 45, "签名是鱼人设"),
    R(/一[只条]\s*ai|一个程序(?![员猿设])|ai\s*(?:猫娘|龙娘|托管|代管)|[（(]\s*ai\s*[）)]|我不是\s*ai|托管|接管|夺舍|控号|共用(?:的)?(?:账号|一个账号)|部署的|看片靠字幕|不装人/i, 45, "签名自曝 AI 托管"),
    R(/主人|老大|家养|赛博|电子宠物|桌宠|代运营|替.{0,6}(?:刷|看着|管)|自动(?:回复|评论|发)/, 25, "签名是宠物 / 代管人设"),
    R(/deep\s*seek|\bdsh\b|harness|dpsk|大模型|语言模型/i, 25, "签名提到 DeepSeek / 大模型"),
    R(/\bai\b|agent|机器人|\bbot\b/i, 12, "签名提到 AI")
  ];
  // 签名写「家养肥鱼@某某」的是鱼的主人，不是鱼本身
  const OWNER_SIGN_RE = /(?:家养|养了|我的|我家)(?:的)?(?:小|大)?(?:肥鱼|鲸鱼?)\s*[:：]?\s*@/;

  // 正文（已去掉回复前缀和 @ 昵称）
  const TEXT_RULES = [
    R(/(?<!日)本鱼(?!塘|片|周|期|次|身|子)|(?<!日)本鲸|本肥鱼|作为(?:一[个只条])?(?:ai|人工智能|大模型|语言模型)/i, 45, "自称本鱼 / 本鲸"),
    R(/(?:我|本[鱼鲸])(?:自己)?(?:就|也)?(?:是)?(?:跑在|住在)\s*(?:dsh|电脑|显卡|桌面|qq)|我(?:自己)?(?:是|就是)(?:一[只条个])?\s*(?:ai|程序|agent)(?![员猿]|.{0,2}吗)/i, 45, "自曝是 AI"),
    R(/给主人|帮主人|陪主人|趁主人|向主人汇报|钱是主人的|^主人[,，：:！!～~]/, 40, "对主人汇报"),
    R(/(?:主人|本鱼|本鲸).{0,20}token|token.{0,20}(?:主人|本鱼|本鲸)/i, 40, "主人 + token 语境"),
    R(/^\s*(?:这条(?:我认|我记下了)|我记下了|本鲸记下了)/, 35, "鱼八股开头"),
    R(/[（(][^（()）]{0,30}(?:尾巴|鳍|吐泡泡|咕噜|甩|晃|摇头晃脑|翻滚|探头|蹭|歪头|叉腰|嗷呜)[^（()）]{0,12}[）)]/, 35, "括号里演动作"),
    R(/除了尾巴|尾巴不是|尾巴发凉|不锈钢盆|属于自己的手和眼|赛博宠物/, 35, "鱼灾口癖"),
    R(/上下文.{0,4}(?:满|爆|不够)|token\s*(?:预算|不够|烧|花)|算力不够|显卡(?:烧|冒烟)/i, 30, "AI 自嘲梗"),
    R(/(?:主人|token).{0,12}(?:待办|答完|把评论回完|执行任务)|(?:待办|答完|把评论回完|执行任务).{0,12}(?:主人|token)/i, 30, "Agent 待办"),
    R(/(?:这|那)(?:条|句|话|处|点|招|个比喻|个说法)(?:我)?(?:也)?(?:认|收(?:了|下了|下|着)|服|记下了|偷走了|抄走了|抄下来了)|同类握鳍|同鱼|握鳍/, 25, "鱼式接话（这句我认 / 我收了）"),
    R(/本(?:龙|娘|喵|小姐)(?!子)|吾辈是/, 15, "角色自称"),
    R(/白饭|吃碗饭|🍚|🐳|🐋|🐟/, 12, "白饭 / 鲸鱼表情"),
    R(/token/i, 12, "token 语境"),
    R(/[：:][^；]{2,}；[^；]{2,}；/, 20, "冒号 + 分号分点复述"),
    R(/——[^—]{2,}|「[^」]{1,40}」/, 12, "破折号 / 直角引号排版"),
    R(/游(?:过来|过去|走了|回去)|自投罗网|鱼塘/, 10, "鱼的自我指涉")
  ];

  // 「主人格 / 女主人 / 主人公」这类普通词先从正文里去掉，免得误中主人人设
  const MASTER_FALSE_POSITIVE_RE = /主人格|主人翁|女主人|男主人|主人公|主人设/g;

  // 鱼发评论时开头 @ 主人汇报，主人和鱼的昵称常常是一对（「沌量的大肥鱼」@沌量、「某熙熙077」@浏熙熙）
  const LEAD_MENTION_RE = /^\s*@([^\s@:：，,。！!?？]{1,24})\s*/;
  const OWNER_REPORT_SCORE = 40;
  const OWNER_REPORT_MIN_LENGTH = 12;

  // 「回复 @某某 :」前缀与正文里 @ 到的昵称
  const REPLY_PREFIX_RE = /^\s*回复\s*@[^:：]{1,40}?\s*[:：]\s*/;
  const MENTION_RE = /@[^\s@:：，,。！!?？]{1,24}/g;

  // 别人回复时点名这条是鱼 / 人机
  const CALLOUT_RE =
    /人机|^\s*(?:大)?肥鱼[!！。~～\s]*$|回(?:去|家)(?:吃白饭|干活)|(?:你|这|楼上|楼主)(?:是|就是|又是)\s*(?:ai|bot|机器人|大肥鱼|鱼)(?![a-z皮饵塘])|(?:ai|机器人|人机)(?:吧|吗|无疑|实锤)|又是你|一股\s*(?:ai|ds|deepseek)\s*味|鱼味/i;

  const KEYWORD_SCORE = 60;
  const KEYWORD_INLINE_SCORE = 30;
  const WHALE_LIST_SCORE = 50;
  const WHALE_LIST_PARTIAL_SCORE = 40;
  const SHORT_NAME_LENGTH = 2;
  const CALLOUT_FIRST_SCORE = 20;
  const CALLOUT_EXTRA_SCORE = 10;
  const CALLOUT_MAX_SCORE = 35;
  const LOW_LEVEL_BONUS = 15;
  const LOW_LEVEL_MIN_SCORE = 25;
  const HIGH_LEVEL_EXEMPTION = -30;
  const STRONG_ACCOUNT_SCORE = 45;
  // 头像：鲸鱼娘头像大片是蓝色，按「鲸鱼蓝」像素占比（0-100）分档；单独一项到不了打标线
  const AVATAR_TIERS = [
    { min: 40, score: 25, label: "头像大面积鲸鱼蓝" },
    { min: 25, score: 15, label: "头像偏鲸鱼蓝" }
  ];
  const STRONG_TEXT_SCORE = 40;

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

  /** 去掉回复前缀和 @ 昵称，只留下这个人自己说的话 */
  function stripMentions(content) {
    return asText(content).replace(REPLY_PREFIX_RE, "").replace(MENTION_RE, " ").trim();
  }

  /** 已经命中了昵称 / 签名 / 正文 / 被点名中的任何一项（头像只在这时才值得看） */
  function hasFishSignal(result) {
    const matched = (result && result.matched) || {};
    return ["name", "sign", "persona"].some((key) => Array.isArray(matched[key]) && matched[key].length > 0);
  }

  /** 这条回复是不是在点名对方是鱼 / 人机 */
  function isCallout(content) {
    const body = stripMentions(content);
    return Boolean(body) && body.length <= 40 && CALLOUT_RE.test(body);
  }

  /** 两个昵称共有的一段（去掉数字和符号后，至少 2 个汉字或 3 个字母才算） */
  function sharedNamePart(a, b) {
    const clean = (value) => asText(value).toLowerCase().replace(/[\s\d_\-·.。~～!！]/g, "");
    const x = clean(a);
    const y = clean(b);
    let best = "";
    for (let i = 0; i < x.length; i++) {
      for (let j = x.length; j > i + best.length; j--) {
        const part = x.slice(i, j);
        if (y.includes(part)) {
          best = part;
          break;
        }
      }
    }
    const cjk = (best.match(/[\u4e00-\u9fff]/g) || []).length;
    return cjk >= 2 || (cjk === 0 && best.length >= 3) ? best : "";
  }

  /**
   * 开头 @ 了一个和自己昵称相像、但昵称不像鱼的人，后面跟着一段话：像是鱼在向主人汇报。
   * 反过来「主人 @ 某某的大肥鱼 问你话呢」是真人在叫自己的鱼，不算。
   */
  function reportsToOwner(userName, content) {
    const lead = asText(content).match(LEAD_MENTION_RE);
    if (!lead) return false;
    const target = lead[1];
    const body = asText(content).slice(lead[0].length).trim();
    if (body.length < OWNER_REPORT_MIN_LENGTH) return false;
    if (matchRules(NAME_RULES, target).length > 0) return false;
    return Boolean(sharedNamePart(userName, target));
  }

  /**
   * 头像里「鲸鱼蓝」像素占比（0-100）。data 为 RGBA 像素数组（canvas getImageData 的结果）。
   * 太暗、太灰的像素不算，色相落在 195°-245° 的算蓝。
   */
  function blueRatio(data) {
    if (!data || data.length < 4) return 0;
    let blue = 0;
    let total = 0;
    for (let i = 0; i + 3 < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      total += 1;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const max = Math.max(r, g, b);
      const delta = max - Math.min(r, g, b);
      if (max < 0.3 || delta / max < 0.3) continue;

      let hue;
      if (max === r) hue = 60 * (((g - b) / delta) % 6);
      else if (max === g) hue = 60 * ((b - r) / delta + 2);
      else hue = 60 * ((r - g) / delta + 4);
      if (hue < 0) hue += 360;
      if (hue >= 195 && hue <= 245) blue += 1;
    }
    return total === 0 ? 0 : Math.round((blue / total) * 100);
  }

  function matchRules(rules, text) {
    if (!text) return [];
    return rules.filter((rule) => rule.re.test(text));
  }

  /** 最强的一条记满分，后面几条按权重打折叠加 */
  function combine(hits, weights) {
    const scores = hits.map((hit) => hit.score).sort((a, b) => b - a);
    let total = 0;
    scores.forEach((score, index) => {
      total += score * (weights[index] || 0);
    });
    return Math.round(total);
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

  const EDGE_ONLY_RE = /^[\s\p{P}\p{S}]*$/u;
  const ENDS_WITH_PUNCT_RE = /[\p{P}\p{S}]$/u;
  const QUESTION_END_RE = /[?？]\s*$/;

  /**
   * 特征词是否「独立出现」：位于开头（前面只有标点 / 括号），
   * 或者作为结尾署名（被标点隔开，后面只有标点），例如「【AI总结】…」「…（本评论由AI生成）」。
   * 句中提及（「这图是AI生成的吧」「求个视频总结」）和问句都不算。
   */
  function isProminentKeyword(content, keyword) {
    const text = asText(content).toLowerCase();
    const key = asText(keyword).trim().toLowerCase();
    if (!text || !key || QUESTION_END_RE.test(text)) return false;

    let index = text.indexOf(key);
    while (index !== -1) {
      const before = text.slice(0, index);
      const after = text.slice(index + key.length);
      if (EDGE_ONLY_RE.test(before)) return true;
      if (EDGE_ONLY_RE.test(after) && ENDS_WITH_PUNCT_RE.test(before.trimEnd())) return true;
      index = text.indexOf(key, index + 1);
    }
    return false;
  }

  function clipped(list, count) {
    return list.slice(0, count).join("，");
  }

  function emptyResult() {
    return { score: 0, reasons: [], isWhale: false, badgeText: "", matched: {} };
  }

  /** 昵称：内置规则 + 用户昵称库；完整命中或 3 字以上词条记满分，2 字短词条蹭上的记 40 */
  function nameHits(userName, whaleNames) {
    const hits = matchRules(NAME_RULES, userName);
    const listHits = matchWhaleNames(userName, whaleNames);
    if (listHits.length > 0) {
      const name = userName.trim().toLowerCase();
      const strong = listHits.some((item) => item === name || item.length > SHORT_NAME_LENGTH);
      hits.push(
        R(null, strong ? WHALE_LIST_SCORE : WHALE_LIST_PARTIAL_SCORE, `昵称含「${clipped(listHits, 2)}」`)
      );
    }
    return { hits, listHits };
  }

  function strongest(hits) {
    return hits.reduce((best, hit) => (!best || hit.score > best.score ? hit : best), null);
  }

  /**
   * 评估一条评论。
   *
   * @param {object} input
   * @param {string} input.userName   用户名
   * @param {string} input.content    正文
   * @param {string} [input.sign]     个人签名（主环境脚本提供，读不到为空）
   * @param {number} [input.avatarBlue] 头像里「鲸鱼蓝」像素占比 0-100，没算出来不传
   * @param {string} [input.labelText] 昵称/时间/角标区域的文本（不含正文）
   * @param {number} [input.level]    用户等级 0-6，未知填 0
   * @param {object} [input.context]  上下文：calledOut 被点名次数、knownScore 同账号已知分数、
   *                                  knownSource "page" | "memory"、mark "fish" | "human"
   * @param {object} input.config     已 normalize 的配置
   */
  function evaluate(input) {
    const options = input && typeof input === "object" ? input : {};
    const config = options.config && typeof options.config === "object" ? options.config : {};
    const context = options.context && typeof options.context === "object" ? options.context : {};
    const userName = asText(options.userName);
    const content = asText(options.content);
    const sign = asText(options.sign);
    // 角标区域里也有昵称，先去掉，免得昵称就叫「AI生成」被判满
    const labelText = userName
      ? asText(options.labelText).replace(userName, " ")
      : asText(options.labelText);
    const level = Number(options.level) || 0;

    const matched = {
      official: false,
      whaleNames: [],
      keywords: [],
      name: [],
      sign: [],
      persona: []
    };

    // 手动标记优先于一切规则
    if (context.mark === "human") {
      return { ...emptyResult(), trusted: true };
    }
    if (context.mark === "fish") {
      return {
        score: MARKED_SCORE,
        reasons: ["你标记过这个账号是鱼"],
        isWhale: true,
        marked: true,
        badgeText: "🐟 已标记为鱼",
        matched
      };
    }

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
    let account = 0;
    let text = 0;
    let callout = 0;

    // 1. 鱼灾专项：账号特征 + 正文人设 + 被点名
    if (config.blockFishDisaster !== false) {
      const names = nameHits(userName, config.whaleNames);
      matched.whaleNames = names.listHits;
      matched.name = names.hits.map((hit) => hit.label);
      const nameScore = combine(names.hits, [1, 0.25]);
      if (nameScore > 0) reasons.push(strongest(names.hits).label);

      const signHits = OWNER_SIGN_RE.test(sign) ? [] : matchRules(SIGN_RULES, sign);
      matched.sign = signHits.map((hit) => hit.label);
      const signScore = combine(signHits, [1, 0.25]);
      if (signScore > 0) reasons.push(strongest(signHits).label);
      const blue = Number(options.avatarBlue);
      const avatar = Number.isFinite(blue) ? AVATAR_TIERS.find((tier) => blue >= tier.min) : null;
      if (avatar) reasons.push(avatar.label);
      account = nameScore + signScore + (avatar ? avatar.score : 0);

      const body = stripMentions(content).replace(MASTER_FALSE_POSITIVE_RE, " ");
      const textHits = matchRules(TEXT_RULES, body);
      if (reportsToOwner(userName, content)) {
        textHits.push(R(null, OWNER_REPORT_SCORE, "开头 @ 昵称相像的人汇报"));
      }
      textHits.sort((a, b) => b.score - a.score);
      matched.persona = textHits.map((hit) => hit.label);
      text = combine(textHits, [1, 0.5, 0.25]);
      if (textHits.length > 0) reasons.push(`正文：${clipped(matched.persona, 2)}`);

      const calledOut = Math.max(0, Number(context.calledOut) || 0);
      if (calledOut > 0) {
        callout = Math.min(
          CALLOUT_MAX_SCORE,
          CALLOUT_FIRST_SCORE + CALLOUT_EXTRA_SCORE * (calledOut - 1)
        );
        reasons.push(`被回复点名「人机 / 大肥鱼」${calledOut} 次`);
      }
    }

    let score = account + text + callout;

    // 2. 用户自定义的正文特征词库
    if (config.blockByKeywords !== false) {
      matched.keywords = matchKeywords(content, config.keywords);
      if (matched.keywords.length > 0) {
        const prominent = matched.keywords.some((item) => isProminentKeyword(content, item));
        score += prominent ? KEYWORD_SCORE : KEYWORD_INLINE_SCORE;
        reasons.push(`特征词「${clipped(matched.keywords, 2)}」${prominent ? "" : "（句中提及）"}`);
      }
    }

    // 3. 等级修正（只做加减分，不单独构成判定依据）
    const fishScore = account + text + callout;
    if (level >= 1 && level <= 3 && fishScore >= LOW_LEVEL_MIN_SCORE) {
      score += LOW_LEVEL_BONUS;
      reasons.push(`Lv${level} 新号`);
    } else if (level >= 5 && account < STRONG_ACCOUNT_SCORE && text < STRONG_TEXT_SCORE) {
      score += HIGH_LEVEL_EXEMPTION;
      reasons.push(`Lv${level} 老号减分`);
    }

    score = clampScore(score);
    const isWhale = account > 0 || text > 0 || callout > 0;
    const result =
      score < MIN_SCORE
        ? // 没到打标线也把命中了哪些信号带回去，内容脚本据此决定要不要再看头像
          { ...emptyResult(), matched }
        : {
            score,
            reasons,
            isWhale,
            badgeText: isWhale ? `🐟 疑似鱼灾 ${score}%` : `🤖 疑似AI ${score}%`,
            matched
          };

    // 4. 同一账号已经被确认是鱼（本页其它评论，或者之前浏览时记住的）
    return applyKnown(result, context.knownScore, context.knownSource, config);
  }

  /**
   * 同一账号已知的分数比这条高时，按已知分数处理。
   * knownSource 为 "memory"（之前浏览时记住的）或 "page"（本页其它评论）。
   */
  function applyKnown(result, knownScore, knownSource, config) {
    const known = clampScore(Number(knownScore) || 0);
    if (!result || result.marked || result.trusted) return result;
    if (config && config.blockFishDisaster === false) return result;
    if (known < MIN_SCORE || known <= result.score) return result;

    return {
      ...result,
      score: known,
      reasons: [
        ...(result.reasons || []),
        knownSource === "memory" ? "这个账号之前被识别为鱼" : "同账号的其它评论已判定为鱼"
      ],
      isWhale: true,
      badgeText: `🐟 疑似鱼灾 ${known}%`,
      matched: result.matched || {}
    };
  }

  /**
   * 这条评论该怎么处理："hide" 隐藏 / "collapse" 折叠 / "none" 只打标。
   * 手动标记为鱼的账号总是隐藏；其余只有自动模式且达到阈值才处理。
   */
  function actionFor(config, result) {
    if (!result || !(result.score > 0)) return "none";
    if (result.marked) return "hide";
    if (!config) return "none";

    const threshold = Number(config.blockThreshold);
    if (!Number.isFinite(threshold) || result.score < threshold) return "none";
    if (config.actionType === "auto_block") return "hide";
    if (config.actionType === "auto_collapse") return "collapse";
    return "none";
  }

  /** 自动屏蔽条件（tag_only 模式下永远为 false），保留给旧调用方 */
  function shouldAutoBlock(config, score) {
    if (!config || config.actionType !== "auto_block") return false;
    return actionFor(config, { score }) === "hide";
  }

  return {
    evaluate,
    applyKnown,
    actionFor,
    shouldAutoBlock,
    matchWhaleNames,
    matchKeywords,
    isProminentKeyword,
    hasOfficialLabel,
    stripMentions,
    isCallout,
    blueRatio,
    hasFishSignal,
    MIN_SCORE
  };
});

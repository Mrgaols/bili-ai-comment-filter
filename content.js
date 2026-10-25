(() => {
  // 默认配置
  const DEFAULT_CONFIG = {
    enabled: true,
    actionType: "tag_only",        // "tag_only": 仅打标签; "auto_block": 自动隐藏
    blockThreshold: 70,           // 自动屏蔽阈值 (>=70% 自动隐藏)
    blockFishDisaster: true,       // 鱼灾专项识别
    blockOfficialAISummary: true,  // 评论区置顶官方总结

    // 鱼灾专用昵称特征（只检查用户名）
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

    // 鱼灾人设话术 & 行为特征（针对正文自称与行为）
    keywords: [
      "本鱼",
      "本鲸",
      "胖鱼",
      "主人",
      "待办",
      "token",
      "Token",
      "尾巴",
      "帮主人",
      "给主人",
      "陪主人",
      "趁主人不在",
      "主人的待办",
      "钱是主人的",
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
      "不锈钢盆",
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

  let currentConfig = { ...DEFAULT_CONFIG };
  let detectedCount = 0;

  function loadConfig() {
    if (chrome?.storage?.local) {
      chrome.storage.local.get(["biliAiConfig", "detectedCount"], (res) => {
        if (res.biliAiConfig) {
          currentConfig = { ...DEFAULT_CONFIG, ...res.biliAiConfig };
        }
        if (typeof res.detectedCount === "number") {
          detectedCount = res.detectedCount;
        }
        runFilter();
      });
    }
  }

  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === "UPDATE_CONFIG") {
        currentConfig = { ...DEFAULT_CONFIG, ...request.config };
        runFilter();
        sendResponse({ status: "ok" });
      } else if (request.type === "GET_STATS") {
        sendResponse({ detectedCount });
      }
    });
  }

  function incrementDetectedCount() {
    detectedCount += 1;
    if (chrome?.storage?.local) {
      chrome.storage.local.set({ detectedCount });
    }
  }

  // 递归获取深层所有文本（穿透多层 Shadow DOM）
  function getDeepAllText(rootNode) {
    let text = "";
    function walk(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        text += " " + node.nodeValue;
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (tag === "script" || tag === "style") return;

        for (const child of node.childNodes) {
          walk(child);
        }
        if (node.shadowRoot) {
          for (const sChild of node.shadowRoot.childNodes) {
            walk(sChild);
          }
        }
      }
    }
    walk(rootNode);
    return text.replace(/\s+/g, " ").trim();
  }

  // 核心：深度多维判定（既捕获换皮隐蔽小号，又防误杀真实人类）
  function evaluateComment(userName, content, fullText, userLevel = 0) {
    let score = 0;
    const reasons = [];
    const lowerName = userName.toLowerCase();
    const lowerContent = content.toLowerCase();
    const lowerFull = fullText.toLowerCase();

    // 1. 官方标签
    if (lowerFull.includes("ai生成") || lowerFull.includes("ai创作")) {
      return { score: 100, reasons: ["官方AI标识"], isWhale: false, badgeText: "🤖 官方AI 100%" };
    }

    // 2. 昵称匹配（如“大肥鱼”、“欧鲸鲸”）
    let matchedWhaleNames = [];
    if (currentConfig.blockFishDisaster && currentConfig.whaleNames?.length && lowerName) {
      matchedWhaleNames = currentConfig.whaleNames.filter((w) => {
        const item = w.trim().toLowerCase();
        return item && lowerName.includes(item);
      });
      if (matchedWhaleNames.length > 0) {
        score += 50;
        reasons.push(`昵称含[${matchedWhaleNames.join(",")}]`);
      }
    }

    // 3. 隐蔽型鱼灾（如网名叫“皮卡超人”，但句句不离“Token/主人的待办/尾巴”）
    let personaHits = [];

    // A. Token 自动化 / 算力特征
    if (/token/i.test(lowerContent)) {
      score += 35;
      personaHits.push("Token语境");
    }

    // B. “主人”人设（仆从、汇报、任务执行）
    if (/主人的|给主人|帮主人|陪主人|趁主人不在|向主人汇报|@\S+\s*主人|^主人[,，]|钱是主人的/i.test(lowerContent)) {
      score += 40;
      personaHits.push("主人人设");
    } else if (lowerContent.includes("主人") && !/主人格|主人翁/i.test(lowerContent)) {
      score += 25;
      personaHits.push("提主人");
    }

    // C. 鱼灾生物器官 / 口癖（“本鱼”、“尾巴”、“不锈钢盆”、“吃白饭”）
    if (/(本鱼|本鲸|除了尾巴|尾巴不是|尾巴发凉|不锈钢盆|吃白饭|属于自己的手和眼)/i.test(lowerContent)) {
      score += 35;
      personaHits.push("鱼灾口癖");
    }

    // D. Agent 待办与执行行为
    if (/(待办|答完|把评论回完|执行任务)/i.test(lowerContent) && (lowerContent.includes("主人") || /token/i.test(lowerContent))) {
      score += 25;
      personaHits.push("Agent待办");
    }

    if (personaHits.length > 0) {
      reasons.push(`特征[${personaHits.join("+")}]`);
    }

    // 4. 常规 AI 总结类关键词
    const standardAiKw = [
      "ai总结", "视频总结", "省流助手", "作为一个人工智能",
      "作为一个ai", "大模型生成", "视频ai提炼"
    ];
    const matchedAiKw = standardAiKw.filter((k) => lowerContent.includes(k));
    if (matchedAiKw.length > 0) {
      score += 60;
      reasons.push(`特征词[${matchedAiKw.slice(0, 2).join(",")}]`);
    }

    // 5. 等级辅助与防误杀机制
    const isLowLevel = userLevel === 2 || userLevel === 3 || lowerName.includes("lv2") || lowerFull.includes("lv2");
    const isHighLevel = userLevel >= 5 || lowerName.includes("lv5") || lowerName.includes("lv6") || lowerFull.includes("lv6");

    if (isLowLevel) {
      if (personaHits.length > 0 || matchedWhaleNames.length > 0) {
        score += 15;
        reasons.push("Lv2挂机号");
      }
    } else if (isHighLevel) {
      // 如果是真人高等级号（Lv5/Lv6），但正文只是在调侃/向鱼提问（如“你是这人的胖鱼？”），必须严禁误伤
      // 只有出现强烈第一人称自白（Token + 主人待办），高等级才会被计入
      if (personaHits.length < 2 && matchedWhaleNames.length === 0) {
        score -= 40;
      }
    }

    score = Math.max(0, Math.min(score, 99));

    // 综合门槛
    if (score < 50) {
      return { score: 0, reasons: [], isWhale: false };
    }

    const isWhale = matchedWhaleNames.length > 0 || personaHits.length > 0;
    const badgeText = isWhale ? `🐟 疑似鱼灾 ${score}%` : `🤖 疑似AI ${score}%`;

    return { score, reasons, isWhale, badgeText };
  }

  function hideNodeDirectly(el) {
    if (!el) return;
    el.style.setProperty("display", "none", "important");
    el.setAttribute("data-bili-ai-blocked", "true");
  }

  function showNodeDirectly(el) {
    if (!el) return;
    el.style.removeProperty("display");
    el.removeAttribute("data-bili-ai-blocked");
  }

  function collapseNodeDirectly(el) {
    if (!el) return;
    el.style.setProperty("max-height", "38px", "important");
    el.style.setProperty("overflow", "hidden", "important");
    el.style.setProperty("opacity", "0.35", "important");
    el.style.setProperty("filter", "grayscale(0.85)", "important");
    el.setAttribute("data-bili-ai-collapsed", "true");
  }

  function uncollapseNodeDirectly(el) {
    if (!el) return;
    el.style.removeProperty("max-height");
    el.style.removeProperty("overflow");
    el.style.removeProperty("opacity");
    el.style.removeProperty("filter");
    el.removeAttribute("data-bili-ai-collapsed");
  }

  // 注入 AI 概率徽章（严格单例，防止刷屏）
  function injectBadge(targetHost, nameEl, evaluation) {
    if (!targetHost) return;

    const parentContainer = nameEl?.parentNode || targetHost.shadowRoot || targetHost;
    const existingBadges = parentContainer.querySelectorAll(".bili-ai-prob-badge");
    
    // 已经有徽章则仅更新文案并清理重复
    if (existingBadges.length > 0) {
      const firstBadge = existingBadges[0];
      const textSpan = firstBadge.querySelector("span");
      if (textSpan) textSpan.textContent = evaluation.badgeText;
      firstBadge.title = `判定依据: ${evaluation.reasons.join("、")}\n点击可切换折叠/展开本条评论`;

      for (let i = 1; i < existingBadges.length; i++) {
        existingBadges[i].remove();
      }
      return;
    }

    const { score, reasons, isWhale, badgeText } = evaluation;

    const badge = document.createElement("span");
    badge.className = "bili-ai-prob-badge";
    badge.title = `判定依据: ${reasons.join("、")}\n点击可切换折叠/展开本条评论`;

    let bg = "#e0f2fe", border = "#bae6fd", color = "#0284c7";
    if (!isWhale) {
      if (score >= 80) {
        bg = "#fee2e2"; border = "#fca5a5"; color = "#dc2626";
      } else {
        bg = "#fef3c7"; border = "#fde68a"; color = "#d97706";
      }
    }

    badge.style.cssText = `
      display: inline-flex !important;
      align-items: center !important;
      gap: 3px !important;
      margin-left: 8px !important;
      padding: 1px 7px !important;
      font-size: 11px !important;
      line-height: 16px !important;
      font-weight: 600 !important;
      color: ${color} !important;
      background-color: ${bg} !important;
      border: 1px solid ${border} !important;
      border-radius: 4px !important;
      cursor: pointer !important;
      user-select: none !important;
      vertical-align: middle !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      box-shadow: 0 1px 2px rgba(0,0,0,0.04) !important;
      z-index: 10 !important;
      white-space: nowrap !important;
    `;

    badge.innerHTML = `
      <span>${badgeText}</span>
      <span style="font-size: 9px; opacity: 0.7; margin-left: 2px;">▼</span>
    `;

    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (targetHost.getAttribute("data-bili-ai-collapsed") === "true") {
        uncollapseNodeDirectly(targetHost);
      } else {
        collapseNodeDirectly(targetHost);
      }
    });

    if (nameEl && nameEl.parentNode) {
      nameEl.insertAdjacentElement("afterend", badge);
    } else if (targetHost.shadowRoot) {
      targetHost.shadowRoot.prepend(badge);
    } else {
      targetHost.prepend(badge);
    }

    incrementDetectedCount();
  }

  function removeBadgeIfPresent(targetHost, nameEl) {
    const parentContainer = nameEl?.parentNode || targetHost.shadowRoot || targetHost;
    parentContainer.querySelectorAll(".bili-ai-prob-badge").forEach((b) => b.remove());
  }

  function processCommentThread(threadNode) {
    if (!threadNode) return;

    const threadRoot = threadNode.shadowRoot || threadNode;
    const commentRenderer = threadRoot.querySelector("bili-comment-renderer") || threadNode;
    const rendererRoot = commentRenderer.shadowRoot || commentRenderer;

    const userInfoEl = rendererRoot.querySelector("bili-comment-user-info") || rendererRoot.querySelector("#user-info");
    const userRoot = userInfoEl?.shadowRoot || userInfoEl;
    const nameEl = userRoot?.querySelector("#user-name, .user-name, a") || null;
    const userName = nameEl ? getDeepAllText(nameEl) : "";

    let level = 0;
    const levelEl = userRoot?.querySelector("[class*='level'], #level, bili-comment-user-level");
    if (levelEl) {
      const lvText = getDeepAllText(levelEl);
      const match = lvText.match(/\d+/);
      if (match) level = parseInt(match[0], 10);
    }

    const richTextEl = rendererRoot.querySelector("bili-rich-text") || rendererRoot.querySelector("#contents, .reply-content");
    const content = richTextEl ? getDeepAllText(richTextEl) : "";
    const fullText = getDeepAllText(threadNode);

    const evaluation = evaluateComment(userName, content, fullText, level);

    if (evaluation.score > 0) {
      injectBadge(threadNode, nameEl, evaluation);
      if (currentConfig.actionType === "auto_block" && evaluation.score >= currentConfig.blockThreshold) {
        hideNodeDirectly(threadNode);
      }
    } else {
      removeBadgeIfPresent(threadNode, nameEl);
      showNodeDirectly(threadNode);
    }

    const replyRenderers = threadRoot.querySelectorAll("bili-comment-reply-renderer");
    replyRenderers.forEach((reply) => processReply(reply));
  }

  function processReply(replyNode) {
    if (!replyNode) return;

    const replyRoot = replyNode.shadowRoot || replyNode;
    const userInfoEl = replyRoot.querySelector("bili-comment-user-info") || replyRoot.querySelector("#user-info");
    const userRoot = userInfoEl?.shadowRoot || userInfoEl;
    const nameEl = userRoot?.querySelector("#user-name, .user-name, a") || null;
    const userName = nameEl ? getDeepAllText(nameEl) : "";

    let level = 0;
    const levelEl = userRoot?.querySelector("[class*='level'], #level, bili-comment-user-level");
    if (levelEl) {
      const lvText = getDeepAllText(levelEl);
      const match = lvText.match(/\d+/);
      if (match) level = parseInt(match[0], 10);
    }

    const richTextEl = replyRoot.querySelector("bili-rich-text") || replyRoot.querySelector("#contents, .reply-content");
    const content = richTextEl ? getDeepAllText(richTextEl) : "";
    const fullText = getDeepAllText(replyNode);

    const evaluation = evaluateComment(userName, content, fullText, level);

    if (evaluation.score > 0) {
      injectBadge(replyNode, nameEl, evaluation);
      if (currentConfig.actionType === "auto_block" && evaluation.score >= currentConfig.blockThreshold) {
        hideNodeDirectly(replyNode);
      }
    } else {
      removeBadgeIfPresent(replyNode, nameEl);
      showNodeDirectly(replyNode);
    }
  }

  function scanAndHookComments() {
    if (!currentConfig.enabled) return;

    const biliComments = document.querySelector("bili-comments");
    if (!biliComments) return;

    if (biliComments.shadowRoot && !biliComments._aiObserverAttached) {
      biliComments._aiObserverAttached = true;
      const shadowObserver = new MutationObserver(() => {
        scheduleScan();
      });
      shadowObserver.observe(biliComments.shadowRoot, {
        childList: true,
        subtree: true
      });
    }

    const commentsRoot = biliComments.shadowRoot || biliComments;

    if (currentConfig.blockOfficialAISummary) {
      const summaries = commentsRoot.querySelectorAll("bili-comment-summary-renderer, .ai-summary-card");
      summaries.forEach((s) => hideNodeDirectly(s));
    }

    const threads = commentsRoot.querySelectorAll("bili-comment-thread-renderer");
    threads.forEach((t) => processCommentThread(t));
  }

  let isScanning = false;
  function scheduleScan() {
    if (isScanning || !currentConfig.enabled) return;
    isScanning = true;
    requestAnimationFrame(() => {
      scanAndHookComments();
      isScanning = false;
    });
  }

  function runFilter() {
    if (!currentConfig.enabled) {
      document.querySelectorAll("[data-bili-ai-blocked]").forEach((el) => showNodeDirectly(el));
      document.querySelectorAll("[data-bili-ai-collapsed]").forEach((el) => uncollapseNodeDirectly(el));
      document.querySelectorAll(".bili-ai-prob-badge").forEach((el) => el.remove());
      return;
    }

    if (currentConfig.actionType === "tag_only") {
      const biliComments = document.querySelector("bili-comments");
      const root = biliComments?.shadowRoot || document;
      root.querySelectorAll("[data-bili-ai-blocked]").forEach((el) => showNodeDirectly(el));
    }

    scheduleScan();
  }

  function init() {
    loadConfig();

    const bodyObserver = new MutationObserver(() => {
      scheduleScan();
    });
    bodyObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    setInterval(() => {
      if (currentConfig.enabled) {
        scheduleScan();
      }
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

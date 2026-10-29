/**
 * 内容脚本：负责在 B 站评论区里找到评论节点、打分、贴标签、折叠/隐藏。
 *
 * 与旧版相比的关键变化：
 *   1. 配置与判定逻辑拆到 config.js / detector.js，默认值只有一份；
 *   2. 处理过的节点用 WeakMap 记住「昵称+等级+正文」指纹，内容变了 / 徽章被冲掉才重新判定；
 *   3. 用 MutationObserver + 1.5s 兜底发现，取代「1s 全量递归遍历所有评论」；
 *   4. 自动隐藏与手动折叠使用不同的状态集合，切换模式能正确恢复原样；
 *   5. 扫描异常只跳过出错的那一条评论。
 */
(() => {
  "use strict";

  const configApi = globalThis.BiliAiConfig;
  const detector = globalThis.BiliAiDetector;
  if (!configApi || !detector) return;

  const { STORAGE_KEYS, normalizeConfig } = configApi;
  const { evaluate, shouldAutoBlock } = detector;

  // 线上结构：thread 的 shadowRoot 里是 #comment（楼主）+ replies-renderer，
  // 楼中楼 reply-renderer 藏在 replies-renderer 自己的 shadowRoot 里
  const COMMENT_SELECTOR = "bili-comment-thread-renderer, bili-comment-reply-renderer";
  const REPLIES_SELECTOR = "bili-comment-replies-renderer";
  const SUMMARY_SELECTOR = "bili-comment-summary-renderer, .ai-summary-card";

  const BADGE_CLASS = "bai-badge";
  const BLOCK_CLASS = "bai-blocked";
  const COLLAPSE_CLASS = "bai-collapsed";
  const MAX_TEXT_LENGTH = 4000;
  const MAX_SHADOW_DEPTH = 6;

  let config = normalizeConfig(null);
  let configGeneration = 0;
  let ready = false;
  let detectedCount = 0;
  let countTimer = null;

  let processed = new WeakMap();
  const countedHosts = new WeakSet();
  const badgeByHost = new WeakMap();
  const badges = new Set();
  const blockedHosts = new Set();
  const collapsedHosts = new Set();
  const hiddenSummaries = new Set();
  const observedRoots = new WeakSet();
  const styledRoots = new WeakSet();

  let mutationObserver = null;
  let scanTimer = null;

  /* ------------------------------------------------------------------ *
   * 文本 / 等级读取
   * ------------------------------------------------------------------ */

  /** 递归收集文本（穿透 Shadow DOM），可排除某个子树，并限制总长度与深度 */
  function collectText(root, exclude, depth = 0) {
    if (!root || depth > MAX_SHADOW_DEPTH) return "";
    let out = "";

    const walk = (node, level) => {
      if (!node || out.length >= MAX_TEXT_LENGTH || level > 64) return;
      if (node === exclude) return;

      if (node.nodeType === Node.TEXT_NODE) {
        out += " " + node.nodeValue;
        return;
      }

      const isElement = node.nodeType === Node.ELEMENT_NODE;
      const isContainer =
        isElement ||
        node.nodeType === Node.DOCUMENT_FRAGMENT_NODE ||
        node.nodeType === Node.DOCUMENT_NODE;
      if (!isContainer) return;

      if (isElement) {
        const tag = node.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") {
          return;
        }
        if (node.shadowRoot) {
          for (const child of node.shadowRoot.childNodes) walk(child, level + 1);
        }
      }

      for (const child of node.childNodes) walk(child, level + 1);
    };

    walk(root, depth);
    return out
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TEXT_LENGTH);
  }

  /** 从等级元素文本里解析 0-6；解析不出来就当未知（0），不猜 */
  function parseLevel(text) {
    const value = String(text || "").trim();
    if (!value || value.length > 12) return 0;

    const lv = value.match(/lv\s*([0-6])/i);
    if (lv) return Number(lv[1]);

    if (value.length <= 3) {
      const digit = value.match(/[0-6]/);
      if (digit) return Number(digit[0]);
    }
    return 0;
  }

  function readUserInfo(scope) {
    const host =
      scope.querySelector("bili-comment-user-info") || scope.querySelector("#user-info") || null;
    const root = (host && host.shadowRoot) || host || scope;

    const nameEl =
      root.querySelector("#user-name, .user-name, a[href*='space.bilibili.com']") ||
      root.querySelector("a") ||
      null;
    const name = nameEl ? collectText(nameEl) : "";

    const levelEl = root.querySelector(
      "#user-level, #level, bili-comment-user-level, [class*='level']"
    );
    const level = readLevel(levelEl);

    return { name, nameEl, level };
  }

  /** 线上等级是一张图（.../level_6.svg），没有文字；图、类名、文字依次兜底 */
  function readLevel(el) {
    if (!el) return 0;

    const img = el.tagName === "IMG" ? el : el.querySelector("img");
    const src = img ? img.getAttribute("src") || "" : "";
    const fromSrc = src.match(/level_([0-6])(?!\d)/i);
    if (fromSrc) return Number(fromSrc[1]);

    const className = typeof el.className === "string" ? el.className : "";
    const fromClass = className.match(/level[-_]?([0-6])(?!\d)/i);
    if (fromClass) return Number(fromClass[1]);

    return parseLevel(collectText(el));
  }

  function findContentEl(scope) {
    return scope.querySelector("bili-rich-text") || scope.querySelector("#contents, .reply-content");
  }

  /* ------------------------------------------------------------------ *
   * 徽章
   * ------------------------------------------------------------------ */

  function getShadowRoot(node) {
    if (!node || typeof node.getRootNode !== "function") return null;
    const root = node.getRootNode();
    return root && root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? root : null;
  }

  /** 徽章在 Shadow DOM 里，文档级 CSS 管不到，需要往对应 root 注入一小段样式 */
  function ensureShadowStyle(node) {
    const root = getShadowRoot(node);
    if (!root || styledRoots.has(root)) return;
    styledRoots.add(root);

    const style = document.createElement("style");
    style.textContent = `
      .${BADGE_CLASS}:hover { filter: brightness(0.95); transform: translateY(-1px); }
      .${BADGE_CLASS}:focus-visible { outline: 2px solid #00aeec; outline-offset: 1px; }
    `;
    root.appendChild(style);
  }

  function paletteFor(result) {
    if (result.isWhale) return { bg: "#e0f2fe", border: "#bae6fd", color: "#0284c7" };
    if (result.score >= 80) return { bg: "#fee2e2", border: "#fca5a5", color: "#dc2626" };
    return { bg: "#fef3c7", border: "#fde68a", color: "#d97706" };
  }

  function applyBadgeLook(badge, result) {
    const palette = paletteFor(result);
    badge.style.cssText = `
      display: inline-flex !important;
      align-items: center !important;
      gap: 3px !important;
      margin-left: 8px !important;
      padding: 1px 7px !important;
      font-size: 11px !important;
      line-height: 16px !important;
      font-weight: 600 !important;
      color: ${palette.color} !important;
      background-color: ${palette.bg} !important;
      border: 1px solid ${palette.border} !important;
      border-radius: 4px !important;
      cursor: pointer !important;
      user-select: none !important;
      vertical-align: middle !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      box-shadow: 0 1px 2px rgba(0,0,0,0.04) !important;
      white-space: nowrap !important;
    `;

    const textEl = badge.querySelector(".bai-badge-text");
    if (textEl && textEl.textContent !== result.badgeText) {
      textEl.textContent = result.badgeText;
    }

    const title = `判定依据：${result.reasons.join("、")}\n点击可折叠 / 展开这条评论`;
    if (badge.title !== title) badge.title = title;

    const label = result.isWhale ? "疑似鱼灾评论，点击折叠" : "疑似 AI 评论，点击折叠";
    if (badge.getAttribute("aria-label") !== label) badge.setAttribute("aria-label", label);
  }

  function createBadge(host, result) {
    const badge = document.createElement("span");
    badge.className = BADGE_CLASS;
    badge.setAttribute("role", "button");
    badge.tabIndex = 0;

    const textEl = document.createElement("span");
    textEl.className = "bai-badge-text";

    const caret = document.createElement("span");
    caret.textContent = "▾";
    caret.setAttribute("aria-hidden", "true");
    caret.style.cssText = "font-size:9px;opacity:.7;margin-left:2px;";

    badge.append(textEl, caret);
    applyBadgeLook(badge, result);

    const toggle = (event) => {
      event.preventDefault();
      event.stopPropagation();
      setCollapsed(host, !collapsedHosts.has(host));
    };
    badge.addEventListener("click", toggle);
    badge.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      toggle(event);
    });

    return badge;
  }

  function injectBadge(host, anchor, result) {
    const existing = badgeByHost.get(host);
    if (existing && existing.isConnected) {
      applyBadgeLook(existing, result);
      return false;
    }
    if (existing) badges.delete(existing);

    const badge = createBadge(host, result);
    if (anchor && anchor.parentNode) {
      anchor.insertAdjacentElement("afterend", badge);
    } else if (host.shadowRoot) {
      host.shadowRoot.prepend(badge);
    } else {
      host.prepend(badge);
    }

    ensureShadowStyle(badge);
    badgeByHost.set(host, badge);
    badges.add(badge);
    return true;
  }

  function removeBadge(host) {
    const badge = badgeByHost.get(host);
    if (!badge) return;
    if (badge.isConnected) badge.remove();
    badges.delete(badge);
    badgeByHost.delete(host);
  }

  /* ------------------------------------------------------------------ *
   * 显示状态
   * ------------------------------------------------------------------ */

  /**
   * 评论宿主元素在线上是 display: inline，max-height 对行内元素无效，
   * 折叠时必须切成 block；隐藏优先于折叠，两种状态都没有时恢复原样。
   */
  function syncDisplay(host) {
    if (blockedHosts.has(host)) {
      host.style.setProperty("display", "none", "important");
    } else if (collapsedHosts.has(host)) {
      host.style.setProperty("display", "block", "important");
    } else {
      host.style.removeProperty("display");
    }
  }

  function setBlocked(host, blocked) {
    if (!host) return;

    if (blocked) {
      blockedHosts.add(host);
      host.classList.add(BLOCK_CLASS);
      host.setAttribute("data-bai-blocked", "1");
    } else {
      blockedHosts.delete(host);
      host.classList.remove(BLOCK_CLASS);
      host.removeAttribute("data-bai-blocked");
    }
    syncDisplay(host);
  }

  function setCollapsed(host, collapsed) {
    if (!host) return;

    if (collapsed) {
      collapsedHosts.add(host);
      host.classList.add(COLLAPSE_CLASS);
      syncDisplay(host);
      host.style.setProperty("max-height", "38px", "important");
      host.style.setProperty("overflow", "hidden", "important");
      host.style.setProperty("opacity", "0.35", "important");
      host.style.setProperty("filter", "grayscale(0.85)", "important");
      host.setAttribute("data-bai-collapsed", "1");
      return;
    }

    collapsedHosts.delete(host);
    host.classList.remove(COLLAPSE_CLASS);
    syncDisplay(host);
    host.style.removeProperty("max-height");
    host.style.removeProperty("overflow");
    host.style.removeProperty("opacity");
    host.style.removeProperty("filter");
    host.removeAttribute("data-bai-collapsed");
  }

  function setSummaryHidden(el, hidden) {
    if (!el) return;
    // 每轮扫描都会调用，状态没变就别反复写样式（避免无谓的重排）
    if (hidden === (el.getAttribute("data-bai-summary") === "1")) return;

    if (hidden) {
      hiddenSummaries.add(el);
      el.classList.add(BLOCK_CLASS);
      el.style.setProperty("display", "none", "important");
      el.setAttribute("data-bai-summary", "1");
      return;
    }

    hiddenSummaries.delete(el);
    el.classList.remove(BLOCK_CLASS);
    el.style.removeProperty("display");
    el.removeAttribute("data-bai-summary");
  }

  /** 把本脚本加过的样式/标签全部撤掉（切换配置、停用插件时调用） */
  function clearDecorations() {
    for (const badge of Array.from(badges)) {
      if (badge.isConnected) badge.remove();
    }
    badges.clear();

    for (const host of Array.from(blockedHosts)) setBlocked(host, false);
    for (const host of Array.from(collapsedHosts)) setCollapsed(host, false);
    for (const el of Array.from(hiddenSummaries)) setSummaryHidden(el, false);
  }

  /* ------------------------------------------------------------------ *
   * 评论处理
   * ------------------------------------------------------------------ */

  function applyResult(host, anchor, result) {
    if (result.score <= 0) {
      removeBadge(host);
      setBlocked(host, false);
      return false;
    }

    const created = injectBadge(host, anchor, result);
    setBlocked(host, shouldAutoBlock(config, result.score));
    return created;
  }

  /** 已处理且内容没变、该有的徽章也还在页面上，才可以跳过 */
  function isUpToDate(node, signature) {
    const record = processed.get(node);
    if (!record || record.generation !== configGeneration) return false;
    if (record.signature !== signature) return false;
    if (!record.tagged) return true;

    // Lit 重新渲染时可能把插进去的徽章冲掉，需要补回
    const badge = badgeByHost.get(node);
    return Boolean(badge && badge.isConnected);
  }

  function processComment(node) {
    if (!node) return;

    const root = node.shadowRoot || node;
    const renderer = root.querySelector("bili-comment-renderer") || node;
    const scope = renderer.shadowRoot || renderer;

    const info = readUserInfo(scope);
    const contentEl = findContentEl(scope);
    const content = contentEl ? collectText(contentEl) : "";

    // 组件是异步渲染的：昵称和正文都还没出来时先不记录，等下一轮再看
    if (!info.name && !content) return;

    const signature = `${info.name}\u0000${info.level}\u0000${content}`;
    if (isUpToDate(node, signature)) return;

    // 同一个节点被复用来显示另一条评论时，旧的手动折叠状态不应该带过去
    const previous = processed.get(node);
    if (previous && previous.signature !== signature) setCollapsed(node, false);

    // 角标区域 = 渲染器内除正文以外的文本，避免正文里提到「AI 生成」就判满
    const labelText = collectText(scope, contentEl);

    const result = evaluate({
      userName: info.name,
      content,
      labelText,
      level: info.level,
      config
    });

    const created = applyResult(node, info.nameEl || contentEl, result);
    processed.set(node, {
      generation: configGeneration,
      signature,
      tagged: result.score > 0
    });

    if (created && !countedHosts.has(node)) {
      countedHosts.add(node);
      bumpCount();
    }
  }

  function descend(node, depth) {
    const shadow = node.shadowRoot;
    if (!shadow) return;
    observeNode(shadow);
    scanRoot(shadow, depth + 1);
  }

  function scanRoot(root, depth) {
    if (!root || depth > MAX_SHADOW_DEPTH) return;

    root.querySelectorAll(COMMENT_SELECTOR).forEach((node) => {
      try {
        processComment(node);
      } catch (error) {
        // 单条评论结构异常只跳过它自己，不影响同一轮里的其他评论
      }
      descend(node, depth);
    });

    root.querySelectorAll(REPLIES_SELECTOR).forEach((node) => descend(node, depth));
  }

  function syncSummaries(root) {
    root.querySelectorAll(SUMMARY_SELECTOR).forEach((el) => {
      setSummaryHidden(el, config.blockOfficialAISummary);
    });
  }

  function scanAll() {
    if (!ready || !config.enabled) return;

    try {
      const hosts = Array.from(document.querySelectorAll("bili-comments"));

      if (hosts.length === 0) {
        // 兜底：某些页面（或旧版结构）没有 bili-comments 包裹层
        if (document.querySelector(COMMENT_SELECTOR)) {
          syncSummaries(document);
          scanRoot(document, 0);
        }
        return;
      }

      for (const host of hosts) {
        observeNode(host);
        const root = host.shadowRoot;
        observeNode(root);

        const target = root || host;
        syncSummaries(target);
        scanRoot(target, 0);
      }
    } catch (error) {
      // 容器层结构异常时跳过本轮，下一轮兜底扫描会重试
    }
  }

  /* ------------------------------------------------------------------ *
   * 调度
   * ------------------------------------------------------------------ */

  function scheduleScan() {
    if (!ready || !config.enabled || scanTimer !== null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanAll();
    }, 200);
  }

  function observeNode(node) {
    if (!node || !mutationObserver || observedRoots.has(node)) return;

    observedRoots.add(node);
    try {
      mutationObserver.observe(node, { childList: true, subtree: true });
    } catch (error) {
      observedRoots.delete(node);
    }
  }

  /** 兜底发现：评论容器可能晚于脚本创建，影子根也可能延迟挂载 */
  function discoveryTick() {
    if (!ready || !config.enabled) return;

    document.querySelectorAll("bili-comments").forEach((host) => {
      observeNode(host);
      observeNode(host.shadowRoot);
    });

    scheduleScan();
  }

  /* ------------------------------------------------------------------ *
   * 配置 / 计数 / 生命周期
   * ------------------------------------------------------------------ */

  function hasChromeStorage() {
    return typeof chrome !== "undefined" && Boolean(chrome.storage && chrome.storage.local);
  }

  function applyConfig(raw) {
    config = normalizeConfig(raw);
    configGeneration += 1;
    processed = new WeakMap();
    clearDecorations();

    if (!config.enabled) {
      if (scanTimer !== null) {
        clearTimeout(scanTimer);
        scanTimer = null;
      }
      return;
    }
    scheduleScan();
  }

  function bumpCount() {
    detectedCount += 1;
    if (countTimer !== null) return;
    countTimer = setTimeout(() => {
      countTimer = null;
      if (hasChromeStorage()) {
        try {
          chrome.storage.local.set({ [STORAGE_KEYS.count]: detectedCount });
        } catch (error) {
          // 扩展被更新 / 卸载时 context 会失效，忽略即可
        }
      }
    }, 1000);
  }

  function listenForConfigChanges() {
    if (!hasChromeStorage() || !chrome.storage.onChanged) return;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;

      // 面板里「重置计数」会改 storage，本地缓存必须跟着走，否则下一次写回旧值
      if (changes[STORAGE_KEYS.count]) {
        const next = Number(changes[STORAGE_KEYS.count].newValue);
        if (Number.isFinite(next) && next >= 0 && next !== detectedCount) {
          detectedCount = next;
          if (countTimer !== null) {
            clearTimeout(countTimer);
            countTimer = null;
          }
        }
      }

      if (changes[STORAGE_KEYS.config]) {
        applyConfig(changes[STORAGE_KEYS.config].newValue);
      }
    });
  }

  function loadConfig(callback) {
    if (!hasChromeStorage()) {
      ready = true;
      callback();
      return;
    }

    const onLoaded = (result) => {
      const storedCount = result && result[STORAGE_KEYS.count];
      if (typeof storedCount === "number" && storedCount >= 0) {
        detectedCount = storedCount;
      }

      config = normalizeConfig(result && result[STORAGE_KEYS.config]);
      configGeneration += 1;
      ready = true;
      callback();
    };

    try {
      chrome.storage.local.get([STORAGE_KEYS.config, STORAGE_KEYS.count], onLoaded);
    } catch (error) {
      // 扩展 context 失效时退回默认配置，至少不会卡在未初始化状态
      ready = true;
      callback();
    }
  }

  function init() {
    mutationObserver = new MutationObserver(() => scheduleScan());

    listenForConfigChanges();
    loadConfig(() => {
      if (config.enabled) scheduleScan();
    });

    // 1.5s 兜底：新评论容器 / 迟到的 shadowRoot 都能被发现；已处理节点会被跳过
    setInterval(discoveryTick, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();

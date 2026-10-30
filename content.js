/**
 * 内容脚本：负责在 B 站评论区里找到评论节点、打分、贴标签、折叠/隐藏。
 *
 * 每一轮扫描：
 *   1. 收集所有评论（楼主 + 楼中楼），读出昵称、等级、正文；签名和账号 ID 由主环境脚本
 *      bridge.js 从组件的 .data 里读出来，读不到时退回 DOM；
 *   2. 逐条打分（结果按「昵称 + 等级 + 签名 + 正文 + 上下文」指纹缓存），
 *      楼中楼里点名「人机 / 大肥鱼」的回复会给被回复的那条加分；
 *   3. 同一账号只要有一条被确认是鱼，本页其它评论跟着处理，并记进账号记忆（跨页面生效）；
 *      已经有可疑信号的评论再看一眼头像：从 B 站图床取 48px 小图，算「鲸鱼蓝」占比；
 *   4. 按处理模式打标 / 折叠 / 隐藏，只作用于这一条评论本身，不连带楼中楼。
 */
(() => {
  "use strict";

  const configApi = globalThis.BiliAiConfig;
  const detector = globalThis.BiliAiDetector;
  if (!configApi || !detector) return;

  const { STORAGE_KEYS, normalizeConfig, normalizeMarks, setMark, markOf, normalizeMemory, mergeMemory } =
    configApi;
  const { evaluate, applyKnown, actionFor, isCallout, blueRatio, hasFishSignal } = detector;

  // 线上结构：thread 的 shadowRoot 里是 #comment（楼主）+ replies-renderer，
  // 楼中楼 reply-renderer 藏在 replies-renderer 自己的 shadowRoot 里
  const COMMENT_SELECTOR = "bili-comment-thread-renderer, bili-comment-reply-renderer";
  const REPLIES_SELECTOR = "bili-comment-replies-renderer";
  const SUMMARY_SELECTOR = "bili-comment-summary-renderer, .ai-summary-card";

  // 与 bridge.js 约定的事件名和属性名
  const BRIDGE_EVENT = "bai:read-comment";
  const BRIDGE_ATTR = "data-bai-info";

  const BADGE_CLASS = "bai-badge";
  const BLOCK_CLASS = "bai-blocked";
  const COLLAPSE_CLASS = "bai-collapsed";
  const MAX_TEXT_LENGTH = 4000;
  const MAX_SHADOW_DEPTH = 6;
  // 达到这个分数才算「确认是鱼」：本页同账号跟着处理，并写进账号记忆
  const CONFIRMED_SCORE = 70;
  const MEMORY_REFRESH_MS = 6 * 60 * 60 * 1000;
  // 头像只从 B 站图床取，缩成 32×32 统计颜色
  const AVATAR_HOST_RE = /(?:^|\.)hdslb\.com$/i;
  const AVATAR_SIZE = 32;
  const AVATAR_TIMEOUT_MS = 8000;
  const MAX_AVATAR_JOBS = 4;
  const MAX_AVATAR_CACHE = 3000;

  let config = normalizeConfig(null);
  let marks = normalizeMarks(null);
  let memory = normalizeMemory(null);
  let configGeneration = 0;
  let ready = false;
  let detectedCount = 0;
  let countTimer = null;
  let memoryTimer = null;
  const pendingMemory = new Map();
  // 头像颜色：图片地址 → 鲸鱼蓝占比（取不到记 null，不再重试）
  const avatarCache = new Map();
  const avatarQueue = [];
  const avatarQueued = new Set();
  let avatarJobs = 0;

  let processed = new WeakMap();
  const countedHosts = new WeakSet();
  const badgeByHost = new WeakMap();
  const badgeState = new WeakMap();
  const badgeLook = new WeakMap();
  const badges = new Set();
  const blockedEls = new Set();
  // 折叠状态：元素 → "auto"（自动折叠模式加的）| "manual"（用户点的）
  const collapsedEls = new Map();
  // 用户手动展开过的元素，自动折叠模式不再把它折回去
  let userExpanded = new WeakSet();
  const hiddenSummaries = new Set();
  const observedRoots = new WeakSet();
  const styledRoots = new WeakSet();

  let mutationObserver = null;
  let scanTimer = null;
  let menu = null;
  let menuBadge = null;

  /* ------------------------------------------------------------------ *
   * 文本 / 等级 / 账号读取
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
        // 自己插进去的徽章不算评论内容
        if (node.classList && node.classList.contains(BADGE_CLASS)) return;
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

  /** 账号 ID：昵称上的 data-user-profile-id，或者空间链接里的数字 */
  function readMid(root) {
    const idEl = root.querySelector("[data-user-profile-id]");
    const fromAttr = idEl ? String(idEl.getAttribute("data-user-profile-id") || "") : "";
    if (/^\d{1,20}$/.test(fromAttr)) return fromAttr;

    const link = root.querySelector("a[href*='space.bilibili.com']");
    const href = link ? link.getAttribute("href") || "" : "";
    const fromHref = href.match(/space\.bilibili\.com\/(?:[a-z-]+\/)?(\d{1,20})/i);
    return fromHref ? fromHref[1] : "";
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

    return { name, nameEl, level: readLevel(levelEl), mid: readMid(root) };
  }

  /** DOM 里的头像地址（主环境脚本读不到数据时兜底） */
  function readFace(scope) {
    const box = scope.querySelector("#user-avatar");
    if (!box) return "";
    const avatar = box.querySelector("bili-avatar");
    const img =
      box.querySelector("img") ||
      (avatar && avatar.shadowRoot ? avatar.shadowRoot.querySelector("img") : null);
    return img ? img.getAttribute("src") || "" : "";
  }

  function findContentEl(scope) {
    return scope.querySelector("bili-rich-text") || scope.querySelector("#contents, .reply-content");
  }

  /** 请主环境脚本把组件 .data 里的签名、账号 ID 等字段写到属性上，再读回来 */
  function readBridge(node) {
    try {
      node.dispatchEvent(new CustomEvent(BRIDGE_EVENT, { bubbles: true, composed: true }));
      const raw = node.getAttribute(BRIDGE_ATTR);
      const data = raw ? JSON.parse(raw) : null;
      return data && typeof data === "object" ? data : {};
    } catch (error) {
      return {};
    }
  }

  function readItem(node, thread, isThread) {
    const root = node.shadowRoot || node;
    const renderer = isThread ? root.querySelector("bili-comment-renderer") || node : node;
    const scope = renderer.shadowRoot || renderer;

    const user = readUserInfo(scope);
    const contentEl = findContentEl(scope);
    const content = contentEl ? collectText(contentEl) : "";

    // 组件是异步渲染的：昵称和正文都还没出来时先跳过，等下一轮再看
    if (!user.name && !content) return null;

    const data = readBridge(node);
    return {
      node,
      thread,
      isThread,
      // 隐藏 / 折叠只作用于这一条：楼主是 #comment 渲染器，楼中楼就是它自己
      own: renderer,
      scope,
      nameEl: user.nameEl,
      contentEl,
      content,
      name: typeof data.name === "string" && data.name ? data.name : user.name,
      level: Number(data.level) > 0 ? Number(data.level) : user.level,
      mid: /^\d{1,20}$/.test(String(data.mid || "")) ? String(data.mid) : user.mid,
      sign: typeof data.sign === "string" ? data.sign : "",
      face: typeof data.face === "string" && data.face ? data.face : readFace(scope),
      rpid: typeof data.rpid === "string" ? data.rpid : "",
      parent: typeof data.parent === "string" ? data.parent : ""
    };
  }

  /* ------------------------------------------------------------------ *
   * 头像颜色
   * ------------------------------------------------------------------ */

  /** 图片地址规整成「主机 + 路径」，去掉尺寸后缀；不是 B 站图床、或者是默认头像就不看 */
  function avatarKey(url) {
    const match = String(url || "").trim().match(/^(?:https?:)?\/\/([^/?#@]+)(\/[^?#@]*)/i);
    if (!match || !AVATAR_HOST_RE.test(match[1].split(":")[0])) return "";
    if (/noface/i.test(match[2])) return "";
    return `${match[1]}${match[2]}`;
  }

  function measureAvatar(key) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      const timer = setTimeout(() => reject(new Error("timeout")), AVATAR_TIMEOUT_MS);

      img.onload = () => {
        clearTimeout(timer);
        try {
          const canvas = document.createElement("canvas");
          canvas.width = AVATAR_SIZE;
          canvas.height = AVATAR_SIZE;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
          resolve(blueRatio(ctx.getImageData(0, 0, AVATAR_SIZE, AVATAR_SIZE).data));
        } catch (error) {
          reject(error);
        }
      };
      img.onerror = () => {
        clearTimeout(timer);
        reject(new Error("load failed"));
      };

      // https 页面上只能取 https 图片
      const protocol = location.protocol === "https:" ? "https:" : "http:";
      img.src = `${protocol}//${key}@48w_48h.webp`;
    });
  }

  function rememberAvatar(key, value) {
    avatarCache.set(key, value);
    if (avatarCache.size > MAX_AVATAR_CACHE) {
      avatarCache.delete(avatarCache.keys().next().value);
    }
  }

  function pumpAvatars() {
    while (avatarJobs < MAX_AVATAR_JOBS && avatarQueue.length > 0) {
      const key = avatarQueue.shift();
      avatarJobs += 1;
      measureAvatar(key)
        .then((ratio) => rememberAvatar(key, ratio))
        .catch(() => rememberAvatar(key, null))
        .finally(() => {
          avatarJobs -= 1;
          avatarQueued.delete(key);
          pumpAvatars();
          // 算出来之后重新判定一轮（指纹里带着头像结果）
          scheduleScan();
        });
    }
  }

  /** 已经算过就返回占比，没算过返回 undefined；需要时排队去算 */
  function avatarBlueOf(item, wanted) {
    if (!config.checkAvatar || config.blockFishDisaster === false) return undefined;
    const key = avatarKey(item.face);
    if (!key) return undefined;
    if (avatarCache.has(key)) {
      const value = avatarCache.get(key);
      return value === null ? undefined : value;
    }
    if (wanted && !avatarQueued.has(key)) {
      avatarQueued.add(key);
      avatarQueue.push(key);
      pumpAvatars();
    }
    return undefined;
  }

  /* ------------------------------------------------------------------ *
   * 徽章与菜单
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
    // 每轮扫描都会调用，结果没变就别反复写样式
    const key = `${result.badgeText}\u0000${result.isWhale}\u0000${result.reasons.join("、")}`;
    if (badgeLook.get(badge) === key) return;
    badgeLook.set(badge, key);

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

    badge.title = `判定依据：${result.reasons.join("、")}\n点击可折叠 / 标记这个账号`;
    badge.setAttribute(
      "aria-label",
      `${result.isWhale ? "疑似鱼灾评论" : "疑似 AI 评论"}，点击打开处理菜单`
    );
  }

  function createBadge() {
    const badge = document.createElement("span");
    badge.className = BADGE_CLASS;
    badge.setAttribute("role", "button");
    badge.setAttribute("aria-haspopup", "menu");
    badge.tabIndex = 0;

    const textEl = document.createElement("span");
    textEl.className = "bai-badge-text";

    const caret = document.createElement("span");
    caret.textContent = "▾";
    caret.setAttribute("aria-hidden", "true");
    caret.style.cssText = "font-size:9px;opacity:.7;margin-left:2px;";

    badge.append(textEl, caret);

    const toggle = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menuBadge === badge) closeMenu();
      else openMenu(badge);
    };
    badge.addEventListener("click", toggle);
    badge.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      toggle(event);
    });

    return badge;
  }

  function injectBadge(item, result) {
    const { node } = item;
    let badge = badgeByHost.get(node);
    let created = false;

    if (!badge || !badge.isConnected) {
      if (badge) badges.delete(badge);
      badge = createBadge();
      const anchor = item.nameEl || item.contentEl;
      if (anchor && anchor.parentNode) {
        anchor.insertAdjacentElement("afterend", badge);
      } else if (node.shadowRoot) {
        node.shadowRoot.prepend(badge);
      } else {
        node.prepend(badge);
      }
      ensureShadowStyle(badge);
      badgeByHost.set(node, badge);
      badges.add(badge);
      created = true;
    }

    applyBadgeLook(badge, result);
    badgeState.set(badge, { own: item.own, mid: item.mid, name: item.name, result });
    return created;
  }

  function removeBadge(node) {
    const badge = badgeByHost.get(node);
    if (!badge) return;
    if (menuBadge === badge) closeMenu();
    if (badge.isConnected) badge.remove();
    badges.delete(badge);
    badgeByHost.delete(node);
  }

  /** 菜单挂在文档顶层（固定定位），不会被折叠后的评论裁掉，样式由 content.css 提供 */
  function ensureMenu() {
    if (menu && menu.isConnected) return menu;
    menu = document.createElement("div");
    menu.className = "bai-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        const badge = menuBadge;
        closeMenu();
        if (badge && badge.isConnected) badge.focus();
      }
    });
    (document.body || document.documentElement).appendChild(menu);
    return menu;
  }

  function addMenuItem(parent, label, onSelect) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      onSelect();
    });
    parent.appendChild(button);
    return button;
  }

  function openMenu(badge) {
    const state = badgeState.get(badge);
    if (!state) return;

    const el = ensureMenu();
    el.replaceChildren();

    const reasons = document.createElement("div");
    reasons.className = "bai-menu-reasons";
    reasons.textContent = `判定依据：${state.result.reasons.join("、")}`;
    el.appendChild(reasons);

    const collapsed = collapsedEls.has(state.own);
    const first = addMenuItem(el, collapsed ? "展开这条评论" : "折叠这条评论", () =>
      toggleCollapse(state.own)
    );

    if (state.mid) {
      const current = markOf(marks, state.mid);
      if (current === "fish") {
        addMenuItem(el, "取消「是鱼」标记", () => updateMark(state, null));
      } else {
        addMenuItem(el, "🐟 是鱼：以后总是隐藏这个账号", () => updateMark(state, "fish"));
      }
      addMenuItem(el, "🙋 误判：这是真人，不再标记", () => updateMark(state, "human"));
    } else {
      const note = document.createElement("div");
      note.className = "bai-menu-note";
      note.textContent = "读不到这个账号的 ID，暂时不能标记";
      el.appendChild(note);
    }

    el.hidden = false;
    menuBadge = badge;

    // 默认放在徽章下方，放不下就放到上方
    const rect = badge.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = rect.bottom + 4;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    first.focus();
  }

  function closeMenu() {
    if (menu) menu.hidden = true;
    menuBadge = null;
  }

  function listenForMenuDismiss() {
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!menuBadge) return;
        const path = event.composedPath();
        if (path.includes(menu) || path.includes(menuBadge)) return;
        closeMenu();
      },
      true
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (menuBadge && event.key === "Escape") closeMenu();
      },
      true
    );
    // 只听页面本身的滚动：弹幕列表这类内部区域一直在自动滚，不能因为它关菜单
    window.addEventListener("scroll", () => menuBadge && closeMenu(), { passive: true });
    window.addEventListener("resize", () => menuBadge && closeMenu());
  }

  function toggleCollapse(el) {
    if (collapsedEls.has(el)) {
      setCollapsed(el, false);
      userExpanded.add(el);
    } else {
      userExpanded.delete(el);
      setCollapsed(el, true, "manual");
    }
  }

  /* ------------------------------------------------------------------ *
   * 显示状态
   * ------------------------------------------------------------------ */

  /**
   * 评论元素在线上是 display: inline，max-height 对行内元素无效，
   * 折叠时必须切成 block；隐藏优先于折叠，两种状态都没有时恢复原样。
   */
  function syncDisplay(el) {
    if (blockedEls.has(el)) {
      el.style.setProperty("display", "none", "important");
    } else if (collapsedEls.has(el)) {
      el.style.setProperty("display", "block", "important");
    } else {
      el.style.removeProperty("display");
    }
  }

  function setBlocked(el, blocked) {
    if (!el || blocked === blockedEls.has(el)) return;

    if (blocked) {
      blockedEls.add(el);
      el.classList.add(BLOCK_CLASS);
      el.setAttribute("data-bai-blocked", "1");
    } else {
      blockedEls.delete(el);
      el.classList.remove(BLOCK_CLASS);
      el.removeAttribute("data-bai-blocked");
    }
    syncDisplay(el);
  }

  function setCollapsed(el, collapsed, reason) {
    if (!el) return;

    if (collapsed) {
      collapsedEls.set(el, reason || "manual");
      el.classList.add(COLLAPSE_CLASS);
      syncDisplay(el);
      el.style.setProperty("max-height", "38px", "important");
      el.style.setProperty("overflow", "hidden", "important");
      el.style.setProperty("opacity", "0.35", "important");
      el.style.setProperty("filter", "grayscale(0.85)", "important");
      el.setAttribute("data-bai-collapsed", "1");
      return;
    }

    if (!collapsedEls.has(el)) return;
    collapsedEls.delete(el);
    el.classList.remove(COLLAPSE_CLASS);
    syncDisplay(el);
    el.style.removeProperty("max-height");
    el.style.removeProperty("overflow");
    el.style.removeProperty("opacity");
    el.style.removeProperty("filter");
    el.removeAttribute("data-bai-collapsed");
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
    closeMenu();
    for (const badge of Array.from(badges)) {
      if (badge.isConnected) badge.remove();
    }
    badges.clear();

    for (const el of Array.from(blockedEls)) setBlocked(el, false);
    for (const el of Array.from(collapsedEls.keys())) setCollapsed(el, false);
    for (const el of Array.from(hiddenSummaries)) setSummaryHidden(el, false);
    userExpanded = new WeakSet();
  }

  /* ------------------------------------------------------------------ *
   * 评论处理
   * ------------------------------------------------------------------ */

  function collectItems() {
    const items = [];

    const visit = (root, thread, depth) => {
      if (!root || depth > MAX_SHADOW_DEPTH) return;

      root.querySelectorAll(COMMENT_SELECTOR).forEach((node) => {
        const isThread = node.tagName === "BILI-COMMENT-THREAD-RENDERER";
        const owner = isThread ? node : thread;
        try {
          const item = readItem(node, owner, isThread);
          if (item) items.push(item);
        } catch (error) {
          // 单条评论结构异常只跳过它自己，不影响同一轮里的其他评论
        }
        if (node.shadowRoot) {
          observeNode(node.shadowRoot);
          visit(node.shadowRoot, owner, depth + 1);
        }
      });

      root.querySelectorAll(REPLIES_SELECTOR).forEach((node) => {
        if (!node.shadowRoot) return;
        observeNode(node.shadowRoot);
        visit(node.shadowRoot, thread, depth + 1);
      });
    };

    const hosts = Array.from(document.querySelectorAll("bili-comments"));
    if (hosts.length === 0) {
      // 兜底：某些页面（或旧版结构）没有 bili-comments 包裹层
      if (document.querySelector(COMMENT_SELECTOR)) {
        syncSummaries(document);
        visit(document, null, 0);
      }
      return items;
    }

    for (const host of hosts) {
      observeNode(host);
      observeNode(host.shadowRoot);
      const target = host.shadowRoot || host;
      syncSummaries(target);
      visit(target, null, 0);
    }
    return items;
  }

  /** 楼中楼里点名「人机 / 大肥鱼」的回复：记到被回复的那条头上 */
  function computeCallouts(items) {
    const counts = new Map();
    const byRpid = new Map();
    for (const item of items) if (item.rpid) byRpid.set(item.rpid, item);

    for (const item of items) {
      if (item.isThread || !isCallout(item.content)) continue;

      let target = null;
      if (item.parent && byRpid.has(item.parent)) {
        target = byRpid.get(item.parent);
      } else {
        const sameThread = items.filter((other) => other.thread === item.thread && other !== item);
        const prefix = item.content.match(/^\s*回复\s*@([^:：\s]{1,40}?)\s*[:：]/);
        target = prefix
          ? sameThread.find((other) => other.name === prefix[1]) || null
          : sameThread.find((other) => other.isThread) || null;
      }

      if (!target || target === item || (target.mid && target.mid === item.mid)) continue;
      counts.set(target, (counts.get(target) || 0) + 1);
    }
    return counts;
  }

  /** 第一轮：按指纹缓存的单条判定（含被点名次数、手动标记、头像颜色） */
  function evaluateItem(item, calledOut) {
    const mark = item.mid ? markOf(marks, item.mid) : null;
    const avatarBlue = avatarBlueOf(item, false);
    const contentKey = `${item.name}\u0000${item.content}`;
    const signature = [contentKey, item.level, item.mid, item.sign, calledOut, mark, avatarBlue].join(
      "\u0000"
    );

    const record = processed.get(item.node);
    if (record && record.generation === configGeneration && record.signature === signature) {
      return record.result;
    }

    // 同一个节点被复用来显示另一条评论时，旧的折叠状态不应该带过去
    const sameComment = record && record.contentKey === contentKey;
    if (record && !sameComment) {
      setCollapsed(item.own, false);
      userExpanded.delete(item.own);
    }

    // 角标区域 = 渲染器内除正文以外的文本，避免正文里提到「AI 生成」就判满
    const labelText = sameComment ? record.labelText : collectText(item.scope, item.contentEl);

    const result = evaluate({
      userName: item.name,
      content: item.content,
      sign: item.sign,
      labelText,
      level: item.level,
      avatarBlue,
      config,
      context: { calledOut, mark }
    });

    // 头像单独不够判定：已经有可疑信号、还没看过头像的，才排队去看
    if (avatarBlue === undefined && !mark && (calledOut > 0 || hasFishSignal(result))) {
      avatarBlueOf(item, true);
    }

    processed.set(item.node, { generation: configGeneration, signature, contentKey, labelText, result });
    return result;
  }

  function applyItem(item, result) {
    const { node, own } = item;

    if (result.score <= 0) {
      removeBadge(node);
      setBlocked(own, false);
      if (collapsedEls.get(own) === "auto") setCollapsed(own, false);
      return;
    }

    const created = injectBadge(item, result);
    const action = actionFor(config, result);
    setBlocked(own, action === "hide");
    if (action === "collapse") {
      if (!collapsedEls.has(own) && !userExpanded.has(own)) setCollapsed(own, true, "auto");
    } else if (collapsedEls.get(own) === "auto") {
      setCollapsed(own, false);
    }

    if (created && !countedHosts.has(node)) {
      countedHosts.add(node);
      bumpCount();
    }
  }

  function syncSummaries(root) {
    root.querySelectorAll(SUMMARY_SELECTOR).forEach((el) => {
      setSummaryHidden(el, config.blockOfficialAISummary);
    });
  }

  function scanAll() {
    if (!ready || !config.enabled) return;

    let items;
    try {
      items = collectItems();
    } catch (error) {
      // 容器层结构异常时跳过本轮，下一轮兜底扫描会重试
      return;
    }

    const callouts = computeCallouts(items);
    for (const item of items) {
      try {
        item.result = evaluateItem(item, callouts.get(item) || 0);
      } catch (error) {
        item.result = null;
      }
    }

    // 第二轮：同一账号本页已有一条确认是鱼、或者之前浏览时被记住了，其它评论跟着处理
    const pageBest = new Map();
    for (const item of items) {
      const result = item.result;
      if (!item.mid || !result || !result.isWhale || result.marked) continue;
      if (result.score < CONFIRMED_SCORE) continue;
      pageBest.set(item.mid, Math.max(pageBest.get(item.mid) || 0, result.score));
    }

    for (const item of items) {
      if (!item.result) continue;
      try {
        const fromPage = item.mid ? pageBest.get(item.mid) || 0 : 0;
        const fromMemory = item.mid && memory[item.mid] ? memory[item.mid].s : 0;
        // 本页刚确认的优先注明「同账号」，免得刚记住的账号被说成「之前就识别过」
        const result =
          fromPage >= fromMemory
            ? applyKnown(item.result, fromPage, "page", config)
            : applyKnown(item.result, fromMemory, "memory", config);
        applyItem(item, result);
        if (result.isWhale && !result.marked && result.score >= CONFIRMED_SCORE) {
          rememberFish(item.mid, item.name, result.score);
        }
      } catch (error) {
        // 同上：只跳过出错的这一条
      }
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
   * 配置 / 名单 / 记忆 / 计数 / 生命周期
   * ------------------------------------------------------------------ */

  function hasChromeStorage() {
    return typeof chrome !== "undefined" && Boolean(chrome.storage && chrome.storage.local);
  }

  /** 读 → 改 → 写，尽量不覆盖别的标签页刚写进去的内容 */
  function updateStored(key, update) {
    if (!hasChromeStorage()) return;
    try {
      chrome.storage.local.get([key], (result) => {
        try {
          chrome.storage.local.set({ [key]: update(result && result[key]) });
        } catch (error) {
          // 扩展被更新 / 卸载时 context 会失效，忽略即可
        }
      });
    } catch (error) {
      // 同上
    }
  }

  function updateMark(state, kind) {
    marks = setMark(marks, state.mid, kind, state.name, Date.now());
    updateStored(STORAGE_KEYS.marks, (stored) => setMark(stored, state.mid, kind, state.name, Date.now()));

    // 认定是真人后，账号记忆里也不该再留着
    if (kind === "human" && memory[state.mid]) {
      const next = { ...memory };
      delete next[state.mid];
      memory = next;
      pendingMemory.delete(state.mid);
      updateStored(STORAGE_KEYS.memory, (stored) => {
        const out = normalizeMemory(stored);
        delete out[state.mid];
        return out;
      });
    }
    scheduleScan();
  }

  function rememberFish(mid, name, score) {
    if (!mid) return;
    const now = Date.now();
    const old = memory[mid];
    if (old && old.s >= score && now - old.t < MEMORY_REFRESH_MS) return;

    const item = { s: Math.max(score, old ? old.s : 0), n: name || (old && old.n) || "", t: now };
    memory = { ...memory, [mid]: item };
    pendingMemory.set(mid, item);

    if (memoryTimer !== null) return;
    memoryTimer = setTimeout(() => {
      memoryTimer = null;
      const batch = Object.fromEntries(pendingMemory);
      pendingMemory.clear();
      updateStored(STORAGE_KEYS.memory, (stored) => mergeMemory(stored, batch));
    }, 2000);
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

  function listenForStorageChanges() {
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

      if (changes[STORAGE_KEYS.marks]) {
        marks = normalizeMarks(changes[STORAGE_KEYS.marks].newValue);
        scheduleScan();
      }

      if (changes[STORAGE_KEYS.memory]) {
        const next = normalizeMemory(changes[STORAGE_KEYS.memory].newValue);
        if (Object.keys(next).length === 0) {
          // 面板里清空了记忆
          memory = next;
          pendingMemory.clear();
        } else {
          // 别的标签页记住的鱼也合并进来
          memory = mergeMemory(memory, next);
        }
        scheduleScan();
      }

      if (changes[STORAGE_KEYS.config]) {
        applyConfig(changes[STORAGE_KEYS.config].newValue);
      }
    });
  }

  function loadState(callback) {
    if (!hasChromeStorage()) {
      ready = true;
      callback();
      return;
    }

    const keys = [STORAGE_KEYS.config, STORAGE_KEYS.count, STORAGE_KEYS.marks, STORAGE_KEYS.memory];
    const onLoaded = (result) => {
      const stored = result || {};
      if (typeof stored[STORAGE_KEYS.count] === "number" && stored[STORAGE_KEYS.count] >= 0) {
        detectedCount = stored[STORAGE_KEYS.count];
      }

      config = normalizeConfig(stored[STORAGE_KEYS.config]);
      marks = normalizeMarks(stored[STORAGE_KEYS.marks]);
      memory = normalizeMemory(stored[STORAGE_KEYS.memory]);
      configGeneration += 1;
      ready = true;
      callback();
    };

    try {
      chrome.storage.local.get(keys, onLoaded);
    } catch (error) {
      // 扩展 context 失效时退回默认配置，至少不会卡在未初始化状态
      ready = true;
      callback();
    }
  }

  function init() {
    mutationObserver = new MutationObserver(() => scheduleScan());

    listenForStorageChanges();
    listenForMenuDismiss();
    loadState(() => {
      if (config.enabled) scheduleScan();
    });

    // 1.5s 兜底：新评论容器 / 迟到的 shadowRoot 都能被发现；没变化的评论直接用缓存
    setInterval(discoveryTick, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();

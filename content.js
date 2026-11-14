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
  // 没被识别的评论上那个淡淡的「标记」按钮：和徽章是同一个元素，只是换了类名和外观
  const MARK_CLASS = "bai-mark";
  const NOTE_CLASS = "bai-hidden-note";
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
  const AVATAR_RETRY_MS = 30000;
  const MAX_AVATAR_JOBS = 4;
  const MAX_AVATAR_CACHE = 3000;

  let config = normalizeConfig(null);
  let marks = normalizeMarks(null);
  let memory = normalizeMemory(null);
  let configGeneration = 0;
  let ready = false;
  let pendingCount = 0;
  let countTimer = null;
  let memoryTimer = null;
  const pendingMemory = new Map();
  // 头像颜色：图片地址 → 鲸鱼蓝占比（取不到记 null，不再重试）
  const avatarCache = new Map();
  const avatarQueue = [];
  const avatarQueued = new Set();
  const avatarRetried = new Set();
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
  // 被隐藏后用户点「显示」临时看的评论
  let revealed = new WeakSet();
  const noteByOwn = new WeakMap();
  const notes = new Set();
  const hoverBound = new WeakSet();
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
        if (
          node.classList &&
          (node.classList.contains(BADGE_CLASS) ||
            node.classList.contains(MARK_CLASS) ||
            node.classList.contains(NOTE_CLASS))
        ) {
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
        .catch(() => {
          // 第一次失败可能只是网络抖动，过一会儿再试一次；还不行就不再看这张头像
          if (avatarRetried.has(key)) {
            rememberAvatar(key, null);
            return;
          }
          avatarRetried.add(key);
          avatarQueued.add(key);
          setTimeout(() => {
            avatarQueue.push(key);
            pumpAvatars();
          }, AVATAR_RETRY_MS);
        })
        .finally(() => {
          avatarJobs -= 1;
          if (!avatarRetried.has(key) || avatarCache.has(key)) avatarQueued.delete(key);
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
      .${MARK_CLASS} { opacity: 0; transition: opacity 0.15s; }
      .${MARK_CLASS}[data-show] { opacity: 0.6; }
      .${MARK_CLASS}[data-pin] { opacity: 0.85; }
      .${MARK_CLASS}:hover, .${MARK_CLASS}:focus-visible, .${MARK_CLASS}[data-open] { opacity: 1; }
      .${MARK_CLASS}:focus-visible { outline: 2px solid #00aeec; outline-offset: 1px; }
    `;
    root.appendChild(style);
  }

  function paletteFor(result) {
    if (result.isWhale) return { bg: "#e0f2fe", border: "#bae6fd", color: "#0284c7" };
    if (result.score >= 80) return { bg: "#fee2e2", border: "#fca5a5", color: "#dc2626" };
    return { bg: "#fef3c7", border: "#fde68a", color: "#d97706" };
  }

  function applyBadgeLook(badge, result, ghost) {
    // 每轮扫描都会调用，结果没变就别反复写样式
    const key = ghost
      ? "ghost"
      : `${result.badgeText}\u0000${result.isWhale}\u0000${result.reasons.join("、")}`;
    if (badgeLook.get(badge) === key) return;
    badgeLook.set(badge, key);

    const textEl = badge.querySelector(".bai-badge-text");
    badge.className = ghost ? MARK_CLASS : BADGE_CLASS;

    if (ghost) {
      // 不写 opacity：显隐由注入到 shadow root 的样式按悬停状态控制
      badge.style.cssText = `
        display: inline-flex !important;
        align-items: center !important;
        margin-left: 8px !important;
        padding: 0 6px !important;
        font-size: 11px !important;
        line-height: 16px !important;
        font-weight: 400 !important;
        color: #9499a0 !important;
        background-color: transparent !important;
        border: 1px dashed #c9ccd0 !important;
        border-radius: 4px !important;
        cursor: pointer !important;
        user-select: none !important;
        vertical-align: middle !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        white-space: nowrap !important;
      `;
      if (textEl) textEl.textContent = "标记";
      badge.title = "点击可折叠这条评论，或把这个账号标记为鱼";
      badge.setAttribute("aria-label", "标记或折叠这条评论");
      return;
    }

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

  /** ghost = 这条评论没被识别，放一个悬停才出现的「标记」按钮，菜单和徽章共用 */
  function injectBadge(item, result, ghost) {
    const { node } = item;
    let badge = badgeByHost.get(node);

    if (!badge || !badge.isConnected) {
      if (badge) badges.delete(badge);
      badge = createBadge();
      badgeByHost.set(node, badge);
      badges.add(badge);
    }

    applyBadgeLook(badge, result, ghost);
    badgeState.set(badge, { own: item.own, mid: item.mid, name: item.name, result });
    return badge;
  }

  /**
   * 徽章放在昵称后面；「标记」按钮放在操作栏的「回复」后面，这样平时看不见的它不会在昵称旁留空。
   * 折叠着的评论操作栏被裁掉了，这时「标记」按钮也回到昵称后面。
   */
  function placeBadge(badge, item, inFooter) {
    if (inFooter) {
      const actions = item.scope.querySelector("bili-comment-action-buttons-renderer");
      const reply = actions && actions.shadowRoot ? actions.shadowRoot.querySelector("#reply") : null;
      if (reply) {
        if (badge.previousElementSibling !== reply) reply.insertAdjacentElement("afterend", badge);
        ensureShadowStyle(badge);
        return;
      }
    }

    const anchor = item.nameEl || item.contentEl;
    if (anchor && anchor.parentNode) {
      if (badge.previousElementSibling !== anchor) anchor.insertAdjacentElement("afterend", badge);
    } else if (!badge.isConnected) {
      if (item.node.shadowRoot) item.node.shadowRoot.prepend(badge);
      else item.node.prepend(badge);
    }
    ensureShadowStyle(badge);
  }

  /** 鼠标移到评论上才显出「标记」按钮 */
  function bindHover(item) {
    const { own, node } = item;
    if (hoverBound.has(own)) return;
    hoverBound.add(own);
    const set = (show) => {
      const badge = badgeByHost.get(node);
      if (!badge) return;
      if (show) badge.setAttribute("data-show", "1");
      else badge.removeAttribute("data-show");
    };
    own.addEventListener("pointerenter", () => set(true));
    own.addEventListener("pointerleave", () => set(false));
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

    const tagged = state.result.score > 0;
    const current = state.mid ? markOf(marks, state.mid) : null;

    const reasons = document.createElement("div");
    reasons.className = "bai-menu-reasons";
    if (tagged) reasons.textContent = `判定依据：${state.result.reasons.join("、")}`;
    else if (current === "human") reasons.textContent = "你标记过这个账号是真人，不再识别";
    else reasons.textContent = "这条评论没有被识别为鱼";
    el.appendChild(reasons);

    const collapsed = collapsedEls.has(state.own);
    const first = addMenuItem(el, collapsed ? "展开这条评论" : "折叠这条评论", () =>
      toggleCollapse(state.own)
    );

    if (state.mid) {
      if (current === "fish") {
        addMenuItem(el, "取消「是鱼」标记", () => updateMark(state, null));
      } else {
        addMenuItem(el, "🐟 是鱼：以后总是隐藏这个账号", () => updateMark(state, "fish"));
      }
      if (current === "human") {
        addMenuItem(el, "取消「这是真人」标记", () => updateMark(state, null));
      } else if (tagged) {
        addMenuItem(el, "🙋 误判：这是真人，不再标记", () => updateMark(state, "human"));
      }
    } else {
      const note = document.createElement("div");
      note.className = "bai-menu-note";
      note.textContent = "读不到这个账号的 ID，暂时不能标记";
      el.appendChild(note);
    }

    el.hidden = false;
    menuBadge = badge;
    badge.setAttribute("data-open", "1");

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
    if (menuBadge) menuBadge.removeAttribute("data-open");
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
    scheduleScan();
  }

  /* ------------------------------------------------------------------ *
   * 隐藏后的提示行
   * ------------------------------------------------------------------ */

  function noteText(item, result, shown) {
    const who = item.name ? `「${item.name.slice(0, 16)}」` : "";
    if (shown) return `正在临时显示被隐藏的评论 ${who}`;
    if (result.marked) return `🐟 已隐藏你标记为鱼的账号 ${who} 的评论`;
    return result.isWhale
      ? `🐟 已隐藏一条疑似鱼灾评论 ${who} ${result.score}%`
      : `🤖 已隐藏一条疑似 AI 评论 ${who} ${result.score}%`;
  }

  /** 在被隐藏的评论原位置留一行提示，点「显示」可以临时看一眼，确认有没有误杀 */
  function syncNote(item, result, shown) {
    const { own } = item;
    let note = noteByOwn.get(own);

    if (!note || !note.isConnected) {
      if (note) notes.delete(note);
      // 和正文左边对齐（要在评论被隐藏之前量）
      const ownRect = own.getBoundingClientRect();
      // 楼主对齐正文；楼中楼的正文跟在昵称后面，对齐头像那一列
      const anchor = item.isThread
        ? item.contentEl || item.nameEl
        : item.scope.querySelector("bili-comment-user-info") || item.nameEl;
      const indent =
        anchor && ownRect.width > 0
          ? Math.max(0, Math.min(120, Math.round(anchor.getBoundingClientRect().left - ownRect.left)))
          : 0;

      note = document.createElement("div");
      note.className = NOTE_CLASS;
      note.style.cssText = `
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        box-sizing: border-box !important;
        padding: 4px 0 4px ${indent}px !important;
        font-size: 12px !important;
        line-height: 18px !important;
        color: #9499a0 !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      `;

      const text = document.createElement("span");
      text.className = "bai-hidden-note-text";
      const button = document.createElement("button");
      button.type = "button";
      button.style.cssText = `
        flex: none !important;
        margin: 0 !important;
        padding: 0 4px !important;
        border: 0 !important;
        background: none !important;
        color: #00aeec !important;
        font: inherit !important;
        cursor: pointer !important;
      `;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (revealed.has(own)) revealed.delete(own);
        else revealed.add(own);
        // 马上生效，不等下一轮扫描
        scanAll();
      });

      note.append(text, button);
      own.insertAdjacentElement("beforebegin", note);
      noteByOwn.set(own, note);
      notes.add(note);
    }

    const text = noteText(item, result, shown);
    const textEl = note.firstChild;
    if (textEl.textContent !== text) textEl.textContent = text;
    const label = shown ? "重新隐藏" : "显示";
    if (note.lastChild.textContent !== label) note.lastChild.textContent = label;
  }

  function removeNote(own) {
    const note = noteByOwn.get(own);
    if (!note) return;
    if (note.isConnected) note.remove();
    notes.delete(note);
    noteByOwn.delete(own);
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
  function clearDecorations(keepManual) {
    closeMenu();
    for (const badge of Array.from(badges)) {
      if (badge.isConnected) badge.remove();
    }
    badges.clear();
    for (const note of Array.from(notes)) {
      if (note.isConnected) note.remove();
    }
    notes.clear();

    for (const el of Array.from(blockedEls)) setBlocked(el, false);
    // 只是改了设置时，用户自己折叠 / 展开过的评论保持原样
    for (const [el, reason] of Array.from(collapsedEls)) {
      if (!keepManual || reason !== "manual") setCollapsed(el, false);
    }
    for (const el of Array.from(hiddenSummaries)) setSummaryHidden(el, false);
    if (!keepManual) {
      userExpanded = new WeakSet();
      revealed = new WeakSet();
    }
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
    const voters = new Map();
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
      // 按回复人去重：同一个人连回几条「人机」只算一次
      if (!voters.has(target)) voters.set(target, new Set());
      voters.get(target).add(item.mid || `name:${item.name}`);
    }

    const counts = new Map();
    for (const [target, people] of voters) counts.set(target, people.size);
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
      revealed.delete(item.own);
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
    const tagged = result.score > 0;

    // 没被识别的评论也放一个悬停才出现的「标记」按钮，认不出来的鱼可以手动标
    const badge = injectBadge(item, result, !tagged);
    bindHover(item);

    const action = tagged ? actionFor(config, result) : "none";
    const hide = action === "hide";
    const shown = hide && revealed.has(own);

    if (hide && config.showHiddenNote) {
      // 提示行要在隐藏之前插入，才能量到正文的缩进
      syncNote(item, result, shown);
    } else {
      removeNote(own);
      if (!hide) revealed.delete(own);
    }
    setBlocked(own, hide && !shown);

    if (action === "collapse") {
      if (!collapsedEls.has(own) && !userExpanded.has(own)) setCollapsed(own, true, "auto");
    } else if (collapsedEls.get(own) === "auto") {
      setCollapsed(own, false);
    }

    // 折叠着的评论，「标记」按钮一直显示在昵称后面，不然找不到地方展开
    const pinned = !tagged && collapsedEls.has(own);
    if (pinned) badge.setAttribute("data-pin", "1");
    else badge.removeAttribute("data-pin");
    placeBadge(badge, item, !tagged && !pinned);

    if (tagged && !countedHosts.has(node)) {
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
      const fishScore = Number(result.fishScore) || 0;
      if (fishScore < CONFIRMED_SCORE) continue;
      pageBest.set(item.mid, Math.max(pageBest.get(item.mid) || 0, fishScore));
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
        // 只有这次真的又被认出来才刷新记忆；单靠记忆命中的不续期，免得误判的账号永远留着
        if (fromPage >= CONFIRMED_SCORE && !result.marked && !result.trusted) {
          rememberFish(item.mid, item.name, fromPage);
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
    // 标签页在后台时不扫描，切回来时补扫一次
    if (!ready || !config.enabled || scanTimer !== null || document.hidden) return;
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
    if (!ready || !config.enabled || document.hidden) return;

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
    clearDecorations(config.enabled);

    if (!config.enabled) {
      if (scanTimer !== null) {
        clearTimeout(scanTimer);
        scanTimer = null;
      }
      return;
    }
    scheduleScan();
  }

  /** 多个标签页各自累加：写回时读出最新值再加上这段时间新增的条数 */
  function bumpCount() {
    pendingCount += 1;
    if (countTimer !== null) return;
    countTimer = setTimeout(() => {
      countTimer = null;
      const delta = pendingCount;
      pendingCount = 0;
      updateStored(STORAGE_KEYS.count, (stored) => {
        const base = Number(stored);
        return (Number.isFinite(base) && base >= 0 ? base : 0) + delta;
      });
    }, 1000);
  }

  function listenForStorageChanges() {
    if (!hasChromeStorage() || !chrome.storage.onChanged) return;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;

      if (changes[STORAGE_KEYS.marks]) {
        marks = normalizeMarks(changes[STORAGE_KEYS.marks].newValue);
        scheduleScan();
      }

      if (changes[STORAGE_KEYS.memory]) {
        const before = normalizeMemory(changes[STORAGE_KEYS.memory].oldValue);
        const next = normalizeMemory(changes[STORAGE_KEYS.memory].newValue);
        // 面板里移除 / 清空的账号，这里也要忘掉；别的标签页新记住的合并进来
        const kept = { ...memory };
        for (const mid of Object.keys(before)) {
          if (next[mid]) continue;
          delete kept[mid];
          pendingMemory.delete(mid);
        }
        memory = mergeMemory(kept, next);
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

    const keys = [STORAGE_KEYS.config, STORAGE_KEYS.marks, STORAGE_KEYS.memory];
    const onLoaded = (result) => {
      const stored = result || {};
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
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleScan();
    });
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

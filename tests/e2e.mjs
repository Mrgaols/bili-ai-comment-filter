#!/usr/bin/env node
/**
 * 可选端到端冒烟测试：在真实的 Chrome 里加载本扩展，打开一个复刻 B 站线上评论区
 * 结构的页面（含多层 Shadow DOM、replies-renderer 里的楼中楼、图片形式的等级、
 * 挂在 .data 上的评论 JSON、异步渲染的评论、置顶 AI 总结），检查：
 *   - 昵称 / 正文 / 签名 / 头像颜色 / 官方 AI 角标 / 楼中楼 / 晚到的评论是否都打上标签；
 *   - 等级从 level_N.svg 读出，签名由主环境脚本从 .data 读出；
 *   - 楼中楼点名「鱼灾」会给楼主加分，同账号的其它评论跟着处理；
 *   - 普通人类评论（含楼中楼里的真人）是否保持干净；
 *   - 徽章菜单能真正把这条评论折叠到 40px 以内，再展开；
 *   - 仅打标 / 自动隐藏 / 自动折叠三种模式，自动隐藏不连带楼中楼；
 *   - 手动标记「是鱼 / 真人」与账号记忆通过 storage 生效；
 *   - 置顶 AI 总结是否按配置隐藏。
 *
 * 运行：npm run test:e2e
 * 需要 Chrome 130+（使用 CDP 的 Extensions.loadUnpacked 加载本地扩展）；
 * 找不到 Chrome 时自动跳过。可用 CHROME_PATH 指定浏览器可执行文件。
 */

import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const VISIT_ALL = `const visit = (scope, out) => {
    for (const el of scope.querySelectorAll("*")) {
      out.push(el);
      if (el.shadowRoot) visit(el.shadowRoot, out);
    }
    return out;
  };`;

/** 打开某个标签的菜单并点其中一项，返回这条评论本身前后的高度 */
const menuActionExpression = (badgeText, itemText) => `(async () => {
  ${VISIT_ALL}
  const badge = visit(document, []).find(
    (el) => el.classList && el.classList.contains("bai-badge") && el.textContent.includes(${JSON.stringify(badgeText)})
  );
  if (!badge) return JSON.stringify({ error: "badge not found" });

  let own = badge;
  while (own && !/^BILI-COMMENT-(RENDERER|REPLY-RENDERER)$/.test(own.tagName || "")) {
    own = own.parentNode || (own.getRootNode && own.getRootNode().host) || null;
  }
  if (!own) return JSON.stringify({ error: "comment not found" });

  const before = own.getBoundingClientRect().height;
  badge.click();
  await new Promise((done) => setTimeout(done, 50));
  const menu = document.querySelector(".bai-menu");
  if (!menu || menu.hidden) return JSON.stringify({ error: "menu not open" });

  const buttons = [...menu.querySelectorAll("button")];
  const item = buttons.find((button) => button.textContent.includes(${JSON.stringify(itemText)}));
  if (!item) return JSON.stringify({ error: "menu item not found: " + buttons.map((b) => b.textContent).join(" / ") });
  item.click();
  await new Promise((done) => setTimeout(done, 50));

  return JSON.stringify({
    before,
    after: own.getBoundingClientRect().height,
    collapsed: own.getAttribute("data-bai-collapsed") === "1",
    menuClosed: menu.hidden
  });
})()`;

/** 某个昵称那条评论的宿主元素现在的高度（0 = 被藏起来了） */
const heightOfExpression = (name) => `(() => {
  ${VISIT_ALL}
  const host = visit(document, []).find(
    (el) => el.data && el.data.member && el.data.member.uname === ${JSON.stringify(name)}
  );
  return JSON.stringify({ found: Boolean(host), height: host ? host.getBoundingClientRect().height : 0 });
})()`;

const COLLECT_EXPRESSION = `(() => {
  const all = [];
  const visit = (scope) => {
    for (const el of scope.querySelectorAll("*")) {
      all.push(el);
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(document);

  const badges = all.filter((el) => el.classList && el.classList.contains("bai-badge"));
  return JSON.stringify({
    badgeTexts: badges.map((badge) => badge.textContent.trim()),
    badgeTitles: badges.map((badge) => badge.title),
    blocked: all.filter((el) => el.getAttribute("data-bai-blocked") === "1").length,
    collapsed: all.filter((el) => el.getAttribute("data-bai-collapsed") === "1").length,
    summaryHidden: all.some(
      (el) =>
        el.tagName === "BILI-COMMENT-SUMMARY-RENDERER" &&
        el.getAttribute("data-bai-summary") === "1"
    )
  });
})()`;

function findChrome() {
  return CHROME_CANDIDATES.find((path) => existsSync(path)) || null;
}

function freePort() {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

async function waitFor(task, { timeout = 20000, interval = 200 } = {}) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeout) {
    try {
      const value = await task();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }

  throw lastError || new Error("等待超时");
}

/** 极简 CDP 客户端（Node 22+ 自带 WebSocket，无需第三方依赖） */
function connectCdp(wsUrl) {
  return new Promise((done, fail) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();

    socket.addEventListener("open", () => {
      socket.addEventListener("close", () => {
        for (const waiter of pending.values()) waiter.reject(new Error("CDP 连接已关闭"));
        pending.clear();
      });

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (!message.id || !pending.has(message.id)) return;

        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      });

      done({
        send(method, params = {}, sessionId = null) {
          return new Promise((resolveSend, rejectSend) => {
            const id = ++nextId;
            pending.set(id, { resolve: resolveSend, reject: rejectSend });

            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            socket.send(JSON.stringify(payload));

            setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              rejectSend(new Error(`CDP 调用超时: ${method}`));
            }, 15000).unref();
          });
        },
        close() {
          socket.close();
        }
      });
    });

    socket.addEventListener("error", () => fail(new Error("无法连接 CDP WebSocket")), {
      once: true
    });
  });
}

function startServer() {
  return new Promise((done) => {
    const server = createServer(async (request, response) => {
      // 假头像：i0.hdslb.com 被解析到这里，地址后面会带「@48w_48h.webp」尺寸后缀
      if (request.url.startsWith("/avatar/")) {
        const fill = request.url.startsWith("/avatar/blue") ? "#3b82f6" : "#9ca3af";
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="${fill}"/></svg>`;
        response
          .writeHead(200, { "Content-Type": "image/svg+xml", "Access-Control-Allow-Origin": "*" })
          .end(svg);
        return;
      }
      if (request.url === "/" || request.url === "/fixture.html") {
        const html = await readFile(join(here, "fixture.html"));
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
        return;
      }
      response.writeHead(204).end();
    });

    server.listen(0, "127.0.0.1", () => {
      done({ server, port: server.address().port });
    });
  });
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("⚠️  未找到 Chrome / Chromium，跳过 E2E（可用 CHROME_PATH 指定）");
    return;
  }

  const { server, port: pagePort } = await startServer();
  const profile = await mkdtemp(join(tmpdir(), "bili-ai-e2e-"));
  const debugPort = await freePort();
  const url = `http://test.bilibili.com:${pagePort}/`;

  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-proxy-server",
      "--disable-background-networking",
      "--enable-unsafe-extension-debugging",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--host-resolver-rules=MAP test.bilibili.com 127.0.0.1, MAP i0.hdslb.com 127.0.0.1",
      "about:blank"
    ],
    { stdio: "ignore" }
  );

  let browserCdp = null;

  try {
    const version = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      return response.ok ? response.json() : null;
    });

    browserCdp = await connectCdp(version.webSocketDebuggerUrl);

    // 正式版 Chrome 已禁用 --load-extension，改用 CDP 加载本地扩展
    const loaded = await browserCdp.send("Extensions.loadUnpacked", { path: root });
    assert.ok(loaded && loaded.id, "扩展加载失败（manifest 可能有误）");

    const target = await browserCdp.send("Target.createTarget", { url });
    const attached = await browserCdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true
    });
    const sessionId = attached.sessionId;

    const readState = async (session) => {
      const evaluated = await browserCdp.send(
        "Runtime.evaluate",
        { expression: COLLECT_EXPRESSION, returnByValue: true },
        session
      );
      if (!evaluated || !evaluated.result || !evaluated.result.value) return null;
      return JSON.parse(evaluated.result.value);
    };

    const waitForState = (session, predicate, description) =>
      waitFor(
        async () => {
          const state = await readState(session);
          return state && predicate(state) ? state : null;
        },
        { timeout: 15000, interval: 300 }
      ).catch(() => {
        throw new Error(`等待状态超时：${description}`);
      });

    const evaluateIn = async (session, expression) => {
      const evaluated = await browserCdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        session
      );
      return JSON.parse(evaluated.result.value);
    };

    // 阶段 1：默认配置（tag_only）。「大肥鱼」那条 2.5s 后才渲染，等它出现
    const data = await waitForState(sessionId, (state) => state.badgeTexts.length >= 10, "首轮打标");

    const texts = data.badgeTexts;
    const count = (needle) => texts.filter((text) => text.includes(needle)).length;
    assert.equal(texts.length, 10, `期望 10 个标签，实际 ${texts.length}: ${JSON.stringify(texts)}`);
    assert.equal(count("官方AI 100%"), 1, "缺少官方 AI 标签");
    assert.equal(count("疑似鱼灾 58%"), 1, "缺少昵称命中标签");
    assert.equal(count("疑似鱼灾 99%"), 2, "正文人设 + 被点名、异步渲染的评论都应判 99");
    assert.equal(count("疑似鱼灾 74%"), 1, "楼中楼未打标签");
    assert.equal(count("疑似鱼灾 61%"), 1, "等级没有从 level_N.svg 读出");
    assert.equal(count("疑似鱼灾 66%"), 1, "签名没有读出来（主环境脚本没生效？）");
    assert.equal(count("疑似鱼灾 78%"), 2, "同账号的第二条评论没有跟着处理");
    assert.equal(count("疑似鱼灾 75%"), 1, "头像颜色没有算进去");

    assert.equal(data.blocked, 0, "tag_only 模式不应隐藏任何评论");
    assert.equal(data.collapsed, 0, "初始状态不应有折叠");
    assert.equal(data.summaryHidden, true, "置顶 AI 总结应被隐藏");
    const titles = data.badgeTitles.join("\n");
    assert.ok(titles.includes("签名自曝"), "标签依据里应有签名");
    assert.ok(titles.includes("被回复点名"), "楼中楼点名应给楼主加分");
    assert.ok(titles.includes("同账号"), "同账号的评论应注明原因");
    assert.ok(titles.includes("鲸鱼蓝"), "头像颜色应写进判定依据");

    // 阶段 1.5：用徽章菜单折叠这条评论，高度必须真的缩到 40px 左右，再展开
    const folded = await evaluateIn(sessionId, menuActionExpression("疑似鱼灾 58%", "折叠这条评论"));
    assert.ok(!folded.error, folded.error);
    assert.ok(folded.menuClosed, "点完菜单项后菜单应关闭");
    assert.ok(folded.collapsed, "选「折叠」后应进入折叠状态");
    assert.ok(folded.before > 40, `折叠前高度异常：${folded.before}`);
    assert.ok(folded.after <= 40, `折叠后高度应 ≤ 40px，实际 ${folded.after}`);

    const unfolded = await evaluateIn(sessionId, menuActionExpression("疑似鱼灾 58%", "展开这条评论"));
    assert.ok(!unfolded.error, unfolded.error);
    assert.equal(unfolded.collapsed, false, "选「展开」后应恢复");
    assert.ok(unfolded.after > 40, "展开后应恢复原高度");

    // 阶段 2：改配置（auto_block + 放开置顶总结），验证 storage.onChanged 链路
    const popupTarget = await browserCdp.send("Target.createTarget", {
      url: `chrome-extension://${loaded.id}/popup.html`
    });
    const popupAttached = await browserCdp.send("Target.attachToTarget", {
      targetId: popupTarget.targetId,
      flatten: true
    });
    const popupSession = popupAttached.sessionId;

    const setStorage = (items) =>
      waitFor(async () => {
        const evaluated = await browserCdp.send(
          "Runtime.evaluate",
          {
            expression: `(async () => {
              if (!(globalThis.chrome && chrome.storage && chrome.storage.local)) return "no-api";
              await chrome.storage.local.set(${JSON.stringify(items)});
              return "ok";
            })()`,
            awaitPromise: true,
            returnByValue: true
          },
          popupSession
        );
        return evaluated && evaluated.result && evaluated.result.value === "ok";
      });
    const setConfig = (patch) => setStorage({ biliAiConfig: patch });

    await setConfig({
      enabled: true,
      actionType: "auto_block",
      blockThreshold: 70,
      blockOfficialAISummary: false
    });

    const blockedState = await waitForState(
      sessionId,
      (state) => state.blocked >= 7 && state.summaryHidden === false,
      "自动隐藏生效 + 置顶总结恢复"
    );
    assert.equal(blockedState.blocked, 7, "阈值 70 时应隐藏 99% ×2 / 74% / 75% / 78% ×2 / 100% 七条");
    assert.equal(blockedState.badgeTexts.length, 10, "自动隐藏后标签仍然保留");
    const bystander = await evaluateIn(sessionId, heightOfExpression("路人甲"));
    assert.ok(bystander.found && bystander.height > 0, "楼主被隐藏时，楼中楼里的真人回复应该还看得见");

    // 阶段 3：自动折叠，同样七条，变成折叠而不是隐藏
    await setConfig({ enabled: true, actionType: "auto_collapse", blockThreshold: 70 });
    const collapsedState = await waitForState(
      sessionId,
      (state) => state.collapsed >= 7 && state.blocked === 0,
      "自动折叠生效"
    );
    assert.equal(collapsedState.collapsed, 7, "阈值 70 时应折叠七条");

    // 阶段 4：切回 tag_only，隐藏 / 折叠状态必须被完整恢复
    await setConfig({ enabled: true, actionType: "tag_only", blockOfficialAISummary: true });
    const restored = await waitForState(
      sessionId,
      (state) => state.blocked === 0 && state.collapsed === 0 && state.summaryHidden === true,
      "切回 tag_only 后恢复显示"
    );
    assert.equal(restored.badgeTexts.length, 10, "恢复后标签数量不应变化");

    // 阶段 5：手动标记 —— 「真人」的标签消失，「是鱼」的总是隐藏（即使是 tag_only）
    const now = Date.now();
    await setStorage({
      biliAiMarks: {
        fish: { 1010: { n: "普通路人丙", t: now } },
        human: { 1001: { n: "欧鲸鲸", t: now } }
      }
    });
    const marked = await waitForState(
      sessionId,
      (state) => state.blocked === 1 && !state.badgeTexts.some((text) => text.includes("58%")),
      "手动标记生效"
    );
    assert.ok(marked.badgeTexts.some((text) => text.includes("已标记为鱼")), "标记为鱼的评论应带标签");

    // 阶段 6：账号记忆 —— 之前被记住的账号，正文再普通也按记住的分数处理
    await setStorage({ biliAiMemory: { 1011: { s: 85, n: "另一位路人", t: now } } });
    const remembered = await waitForState(
      sessionId,
      (state) => state.badgeTexts.some((text) => text.includes("疑似鱼灾 85%")),
      "账号记忆生效"
    );
    assert.ok(remembered.badgeTitles.join("\n").includes("之前被识别为鱼"), "记忆命中应注明原因");

    // 阶段 7：停用插件，所有装饰都应被撤掉
    await setConfig({ enabled: false });
    const disabled = await waitForState(
      sessionId,
      (state) => state.badgeTexts.length === 0 && state.blocked === 0 && state.summaryHidden === false,
      "停用后清除所有标签与隐藏"
    );
    assert.equal(disabled.collapsed, 0);

    console.log("✅ E2E 通过：", JSON.stringify(texts));
  } finally {
    if (browserCdp) browserCdp.close();
    child.kill("SIGKILL");
    server.close();
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("❌ E2E 失败:", error.message);
  process.exitCode = 1;
});

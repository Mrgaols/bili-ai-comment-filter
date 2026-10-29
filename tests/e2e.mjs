#!/usr/bin/env node
/**
 * 可选端到端冒烟测试：在真实的 Chrome 里加载本扩展，打开一个复刻 B 站线上评论区
 * 结构的页面（含多层 Shadow DOM、replies-renderer 里的楼中楼、图片形式的等级、
 * 异步渲染的评论、置顶 AI 总结），检查：
 *   - 昵称命中 / 正文特征 / 官方 AI 角标 / 楼中楼 / 晚到的评论是否都打上标签；
 *   - 等级是否从 level_N.svg 正确读出；
 *   - 普通人类评论（含楼中楼里的真人）是否保持干净；
 *   - 点徽章能真正把评论折叠到 40px 以内；
 *   - tag_only 模式下不隐藏任何评论；
 *   - 置顶 AI 总结是否按默认配置隐藏。
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

/** 点击指定分数的徽章，返回所属评论宿主折叠前后的高度 */
const toggleBadgeExpression = (badgeText) => `(async () => {
  const visit = (scope, out) => {
    for (const el of scope.querySelectorAll("*")) {
      out.push(el);
      if (el.shadowRoot) visit(el.shadowRoot, out);
    }
    return out;
  };
  const badge = visit(document, []).find(
    (el) => el.classList && el.classList.contains("bai-badge") && el.textContent.includes(${JSON.stringify(badgeText)})
  );
  if (!badge) return JSON.stringify({ error: "badge not found" });

  let host = badge;
  while (host && !/^BILI-COMMENT-(THREAD|REPLY)-RENDERER$/.test(host.tagName || "")) {
    host = host.parentNode || (host.getRootNode && host.getRootNode().host) || null;
  }
  if (!host) return JSON.stringify({ error: "host not found" });

  const before = host.getBoundingClientRect().height;
  badge.click();
  await new Promise((done) => setTimeout(done, 50));
  const after = host.getBoundingClientRect().height;
  return JSON.stringify({ before, after, collapsed: host.getAttribute("data-bai-collapsed") === "1" });
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
      "--host-resolver-rules=MAP test.bilibili.com 127.0.0.1",
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

    // 阶段 1：默认配置（tag_only）。第 6 条评论 2.5s 后才渲染，等它出现
    const data = await waitForState(sessionId, (state) => state.badgeTexts.length >= 6, "首轮打标");

    const texts = data.badgeTexts;
    assert.equal(texts.length, 6, `期望 6 个标签，实际 ${texts.length}: ${JSON.stringify(texts)}`);
    assert.ok(texts.some((text) => text.includes("官方AI 100%")), "缺少官方 AI 标签");
    assert.ok(texts.some((text) => text.includes("疑似鱼灾 50%")), "缺少昵称命中 50% 标签");
    assert.ok(texts.some((text) => text.includes("疑似鱼灾 99%")), "缺少正文特征 99% 标签");
    assert.ok(texts.some((text) => text.includes("疑似鱼灾 95%")), "楼中楼未打标签");
    assert.ok(texts.some((text) => text.includes("疑似鱼灾 75%")), "等级没有从 level_N.svg 读出");
    assert.ok(texts.some((text) => text.includes("疑似鱼灾 85%")), "异步渲染的评论没有被识别");

    assert.equal(data.blocked, 0, "tag_only 模式不应隐藏任何评论");
    assert.equal(data.collapsed, 0, "初始状态不应有折叠");
    assert.equal(data.summaryHidden, true, "置顶 AI 总结应被隐藏");
    assert.ok(
      data.badgeTitles.some((title) => title.includes("人设")),
      "标签应带有判定依据"
    );

    // 阶段 1.5：点徽章折叠，高度必须真的缩到 40px 左右，再点一次恢复
    const toggle = async () => {
      const evaluated = await browserCdp.send(
        "Runtime.evaluate",
        { expression: toggleBadgeExpression("疑似鱼灾 50%"), awaitPromise: true, returnByValue: true },
        sessionId
      );
      return JSON.parse(evaluated.result.value);
    };

    const folded = await toggle();
    assert.ok(!folded.error, folded.error);
    assert.ok(folded.collapsed, "点击徽章后应进入折叠状态");
    assert.ok(folded.before > 40, `折叠前高度异常：${folded.before}`);
    assert.ok(folded.after <= 40, `折叠后高度应 ≤ 40px，实际 ${folded.after}`);

    const unfolded = await toggle();
    assert.equal(unfolded.collapsed, false, "再次点击应展开");
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

    const setConfig = (patch) =>
      waitFor(async () => {
        const evaluated = await browserCdp.send(
          "Runtime.evaluate",
          {
            expression: `(async () => {
              if (!(globalThis.chrome && chrome.storage && chrome.storage.local)) return "no-api";
              await chrome.storage.local.set({ biliAiConfig: ${JSON.stringify(patch)} });
              return "ok";
            })()`,
            awaitPromise: true,
            returnByValue: true
          },
          popupSession
        );
        return evaluated && evaluated.result && evaluated.result.value === "ok";
      });

    await setConfig({
      enabled: true,
      actionType: "auto_block",
      blockThreshold: 70,
      blockOfficialAISummary: false
    });

    const blockedState = await waitForState(
      sessionId,
      (state) => state.blocked >= 5 && state.summaryHidden === false,
      "自动屏蔽生效 + 置顶总结恢复"
    );
    assert.equal(blockedState.blocked, 5, "阈值 70 时应隐藏 99% / 95% / 100% / 75% / 85% 五条");
    assert.equal(blockedState.badgeTexts.length, 6, "自动屏蔽后标签仍然保留");

    // 阶段 3：切回 tag_only，隐藏状态必须被完整恢复
    await setConfig({ enabled: true, actionType: "tag_only", blockOfficialAISummary: true });
    const restored = await waitForState(
      sessionId,
      (state) => state.blocked === 0 && state.summaryHidden === true,
      "切回 tag_only 后恢复显示"
    );
    assert.equal(restored.badgeTexts.length, 6, "恢复后标签数量不应变化");

    // 阶段 4：停用插件，所有装饰都应被撤掉
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

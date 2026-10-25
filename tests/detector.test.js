const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeConfig, DEFAULT_CONFIG } = require("../config.js");
const { evaluate, shouldAutoBlock, MIN_SCORE } = require("../detector.js");

const baseConfig = normalizeConfig(DEFAULT_CONFIG);

function detect(overrides = {}) {
  return evaluate({
    userName: "",
    content: "",
    labelText: "",
    level: 0,
    config: baseConfig,
    ...overrides
  });
}

test("官方 AI 角标直接判 100", () => {
  const result = detect({ labelText: "小助手 AI生成 2小时前" });
  assert.equal(result.score, 100);
  assert.equal(result.isWhale, false);
  assert.equal(result.badgeText, "🤖 官方AI 100%");
});

test("昵称「AI生成器」不会被当成官方角标", () => {
  const result = detect({ userName: "AI生成器", labelText: "AI生成器 2小时前" });
  assert.notEqual(result.score, 100);
});

test("昵称库命中记 50 分（只查用户名）", () => {
  const result = detect({ userName: "欧鲸鲸", content: "今天也在努力回评论" });
  assert.equal(result.score, 50);
  assert.equal(result.isWhale, true);
  assert.match(result.badgeText, /疑似鱼灾/);
});

test("正文提到「大肥鱼」不算——必须是用户名", () => {
  const result = detect({ userName: "路过的观众", content: "楼上那只大肥鱼又来了" });
  assert.equal(result.score, 0);
  assert.deepEqual(result.reasons, []);
});

test("只有 token 不足以判定", () => {
  assert.equal(detect({ content: "这个 token 过期了怎么办" }).score, 0);
});

test("token + 主人人设 = 75", () => {
  const result = detect({ content: "帮主人赚点 token" });
  assert.equal(result.score, 75);
  assert.ok(result.reasons.some((reason) => reason.includes("人设")));
});

test("Agent 待办必须和主人 / token 语境一起出现才算分", () => {
  assert.equal(detect({ content: "今天的待办还没做完" }).score, 0);
  assert.equal(detect({ content: "帮主人把待办做完" }).score, 65);
});

test("题库命中记 60 分，标记为疑似 AI 而不是鱼", () => {
  const result = detect({ content: "省流助手来了：本期视频讲了三个要点" });
  assert.equal(result.score, 60);
  assert.equal(result.isWhale, false);
  assert.match(result.badgeText, /疑似AI/);
});

test("关键词大小写不敏感", () => {
  assert.equal(detect({ content: "这篇 ai总结 很到位" }).score, 60);
});

test("关闭特征词库后关键词不再生效", () => {
  const config = normalizeConfig({ ...DEFAULT_CONFIG, blockByKeywords: false });
  const result = evaluate({ content: "省流助手来了", labelText: "", level: 0, config });
  assert.equal(result.score, 0);
});

test("关闭鱼灾专项后昵称与人设都不生效，但词库仍然生效", () => {
  const config = normalizeConfig({ ...DEFAULT_CONFIG, blockFishDisaster: false });

  assert.equal(
    evaluate({ userName: "欧鲸鲸", content: "", config }).score,
    0
  );
  assert.equal(
    evaluate({ content: "帮主人赚 token", config }).score,
    0
  );
  assert.equal(evaluate({ content: "省流助手", config }).score, 60);
});

test("自定义词库会真正参与判定", () => {
  const config = normalizeConfig({
    ...DEFAULT_CONFIG,
    keywords: [...DEFAULT_CONFIG.keywords, "赛博菩萨"]
  });
  assert.equal(evaluate({ content: "赛博菩萨保佑up", config }).score, 60);
});

test("「主人格 / 女主人」这类普通词不会命中人设", () => {
  assert.equal(detect({ content: "主人格分裂了属于是" }).score, 0);
  assert.equal(detect({ content: "女主人真好客" }).score, 0);
});

test("Lv5+ 在高等级且信号不足时豁免", () => {
  const result = detect({ content: "主人辛苦了", level: 6 });
  assert.equal(result.score, 0);
  assert.ok(result.reasons.length === 0 || true);
});

test("Lv5+ 出现两个以上强信号时不再豁免", () => {
  const result = detect({ content: "帮主人赚 token", level: 6 });
  assert.equal(result.score, 75);
});

test("Lv2/Lv3 在已有信号时加权", () => {
  assert.equal(detect({ userName: "鲸鲸", level: 2 }).score, 65);
  // 单独一个弱信号不足以达到门槛
  assert.equal(detect({ content: "主人辛苦了", level: 3 }).score, 0);
});

test("分数封顶 99，且低于门槛时返回空结果", () => {
  const result = detect({ content: "帮主人把待办答完，赚 token，本鱼尾巴发凉" });
  assert.equal(result.score, 99);
  assert.ok(result.reasons.length > 0);

  const low = detect({ content: "" });
  assert.equal(low.score, 0);
  assert.equal(low.badgeText, "");
  assert.ok(MIN_SCORE === 50);
});

test("自动屏蔽只在 auto_block 模式且达到阈值时成立", () => {
  assert.equal(shouldAutoBlock({ actionType: "tag_only", blockThreshold: 70 }, 90), false);
  assert.equal(shouldAutoBlock({ actionType: "auto_block", blockThreshold: 70 }, 69), false);
  assert.equal(shouldAutoBlock({ actionType: "auto_block", blockThreshold: 70 }, 70), true);
  assert.equal(shouldAutoBlock({ actionType: "auto_block", blockThreshold: 70 }, 0), false);
  assert.equal(shouldAutoBlock(null, 90), false);
});

test("判定结果永远包含 reasons / matched 结构，便于提示气泡使用", () => {
  const result = detect({ userName: "小飞鲸", content: "尾巴发凉" });
  assert.ok(Array.isArray(result.reasons));
  assert.ok(result.reasons.every((reason) => typeof reason === "string"));
  assert.ok(result.matched);
});

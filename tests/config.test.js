const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_CONFIG,
  THRESHOLD_MIN,
  THRESHOLD_MAX,
  normalizeConfig
} = require("../config.js");

test("normalizeConfig 空输入全部回落到默认值", () => {
  const config = normalizeConfig(undefined);
  assert.deepEqual(config, {
    enabled: DEFAULT_CONFIG.enabled,
    actionType: DEFAULT_CONFIG.actionType,
    blockThreshold: DEFAULT_CONFIG.blockThreshold,
    blockFishDisaster: DEFAULT_CONFIG.blockFishDisaster,
    blockOfficialAISummary: DEFAULT_CONFIG.blockOfficialAISummary,
    blockByKeywords: DEFAULT_CONFIG.blockByKeywords,
    checkAvatar: DEFAULT_CONFIG.checkAvatar,
    whaleNames: DEFAULT_CONFIG.whaleNames,
    keywords: DEFAULT_CONFIG.keywords
  });
});

test("normalizeConfig 拒绝非法枚举与类型", () => {
  const config = normalizeConfig({
    actionType: "delete_everything",
    enabled: "yes",
    blockFishDisaster: 0,
    blockThreshold: "abc"
  });
  assert.equal(config.actionType, "tag_only");
  assert.equal(config.enabled, DEFAULT_CONFIG.enabled);
  assert.equal(config.blockFishDisaster, DEFAULT_CONFIG.blockFishDisaster);
  assert.equal(config.blockThreshold, DEFAULT_CONFIG.blockThreshold);
});

test("阈值被限制在 50-95", () => {
  assert.equal(normalizeConfig({ blockThreshold: 10 }).blockThreshold, THRESHOLD_MIN);
  assert.equal(normalizeConfig({ blockThreshold: 1000 }).blockThreshold, THRESHOLD_MAX);
  assert.equal(normalizeConfig({ blockThreshold: 72.6 }).blockThreshold, 73);
});

test("昵称库会去空白、去重、忽略大小写重复", () => {
  const config = normalizeConfig({
    whaleNames: ["  大肥鱼 ", "", "大肥鱼", "Fish", "fish", 42, null, "鲸鲸"]
  });
  assert.deepEqual(config.whaleNames, ["大肥鱼", "Fish", "鲸鲸"]);
});

test("列表全部被删空时回落到默认值，不会变成空数组", () => {
  const config = normalizeConfig({ whaleNames: [], keywords: ["   "] });
  assert.deepEqual(config.whaleNames, DEFAULT_CONFIG.whaleNames);
  assert.deepEqual(config.keywords, DEFAULT_CONFIG.keywords);
});

test("单个词条长度与总量有上限", () => {
  const long = "鱼".repeat(80);
  const many = Array.from({ length: 500 }, (_, index) => `词${index}`);
  const config = normalizeConfig({ keywords: [long, ...many] });
  assert.equal(config.keywords[0].length, 40);
  assert.equal(config.keywords.length, 200);
});

test("默认昵称库包含欧鲸鲸（曾因两份默认值漂移而丢失）", () => {
  assert.ok(DEFAULT_CONFIG.whaleNames.includes("欧鲸鲸"));
});

test("存储键名保持稳定（升级时不能悄悄换 key）", () => {
  const { STORAGE_KEYS } = require("../config.js");
  assert.equal(STORAGE_KEYS.config, "biliAiConfig");
  assert.equal(STORAGE_KEYS.count, "detectedCount");
});

test("处理方式支持仅打标 / 自动折叠 / 自动隐藏，其它值回落到仅打标", () => {
  assert.equal(normalizeConfig({ actionType: "auto_collapse" }).actionType, "auto_collapse");
  assert.equal(normalizeConfig({ actionType: "auto_block" }).actionType, "auto_block");
  assert.equal(normalizeConfig({ actionType: "nuke" }).actionType, "tag_only");
});

test("手动标记名单：丢掉非法 UID，同一账号两边都有时以「真人」为准", () => {
  const { normalizeMarks } = require("../config.js");
  const marks = normalizeMarks({
    fish: { 123: { n: "阿喵家的肥鱼", t: 1 }, abc: { n: "x" }, 456: { n: "两边都有", t: 2 } },
    human: { 456: { n: "两边都有", t: 3 } }
  });
  assert.deepEqual(Object.keys(marks.fish), ["123"]);
  assert.deepEqual(Object.keys(marks.human), ["456"]);
});

test("setMark 会把账号从另一边挪过来，传 null 则取消标记", () => {
  const { setMark, markOf } = require("../config.js");
  let marks = setMark({}, "123", "fish", "阿喵家的肥鱼", 1);
  assert.equal(markOf(marks, "123"), "fish");

  marks = setMark(marks, "123", "human", "阿喵家的肥鱼", 2);
  assert.equal(markOf(marks, "123"), "human");
  assert.equal(marks.fish["123"], undefined);

  marks = setMark(marks, "123", null);
  assert.equal(markOf(marks, "123"), null);
  assert.equal(markOf(setMark(marks, "not-a-mid", "fish"), "not-a-mid"), null);
});

test("账号记忆：分数低于 50 的丢掉，超过上限时保留最近的", () => {
  const { normalizeMemory, MAX_MEMORY } = require("../config.js");
  const memory = normalizeMemory({ 1: { s: 120, n: "a", t: 5 }, 2: { s: 30, t: 6 }, x: { s: 80, t: 7 } });
  assert.deepEqual(memory, { 1: { s: 99, n: "a", t: 5 } });

  const many = {};
  for (let i = 1; i <= MAX_MEMORY + 10; i++) many[i] = { s: 80, t: i };
  const pruned = normalizeMemory(many);
  assert.equal(Object.keys(pruned).length, MAX_MEMORY);
  assert.equal(pruned["1"], undefined);
  assert.ok(pruned[String(MAX_MEMORY + 10)]);
});

test("mergeMemory 合并多个标签页写入的记忆：取更高分和更晚时间", () => {
  const { mergeMemory } = require("../config.js");
  const merged = mergeMemory({ 1: { s: 70, n: "a", t: 1 } }, { 1: { s: 90, n: "", t: 5 }, 2: { s: 75, n: "b", t: 3 } });
  assert.deepEqual(merged, { 1: { s: 90, n: "a", t: 5 }, 2: { s: 75, n: "b", t: 3 } });
});

test("头像识别默认开启，可以关掉", () => {
  assert.equal(normalizeConfig(undefined).checkAvatar, true);
  assert.equal(normalizeConfig({ checkAvatar: false }).checkAvatar, false);
  assert.equal(normalizeConfig({ checkAvatar: "no" }).checkAvatar, true);
});

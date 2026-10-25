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

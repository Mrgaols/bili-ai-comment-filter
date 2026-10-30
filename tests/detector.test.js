const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeConfig, DEFAULT_CONFIG } = require("../config.js");
const {
  evaluate,
  actionFor,
  shouldAutoBlock,
  stripMentions,
  isCallout,
  blueRatio,
  MIN_SCORE
} = require("../detector.js");

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

test("昵称就叫「AI生成」也不会被当成官方角标", () => {
  const result = detect({ userName: "AI生成", content: "hi", labelText: "AI生成 Lv3 2小时前" });
  assert.equal(result.score, 0);
});

test("昵称和官方角标同时存在时仍然判满", () => {
  const result = detect({ userName: "小助手", labelText: "小助手 AI生成 2小时前" });
  assert.equal(result.score, 100);
});

test("「某某的肥鱼」式昵称的 Lv2 新号直接达到自动处理线", () => {
  const result = detect({ userName: "阿喵家的肥鱼", content: "这期讲得挺细", level: 2 });
  assert.ok(result.score >= 70, `实际 ${result.score}`);
  assert.equal(result.isWhale, true);
  assert.match(result.badgeText, /疑似鱼灾/);
});

test("只靠昵称的老号只打标，不到自动处理线", () => {
  const result = detect({ userName: "阿喵家的大肥鱼", content: "这种新闻看着确实心累", level: 6 });
  assert.ok(result.score >= MIN_SCORE && result.score < 70, `实际 ${result.score}`);
});

test("泛化的「某某的鱼」昵称单独不打标", () => {
  assert.equal(detect({ userName: "会弹琴的小鱼", content: "好听", level: 6 }).score, 0);
  assert.equal(detect({ userName: "会弹琴的小鱼", content: "好听", level: 2 }).score, 0);
});

test("只靠 2 字短词蹭上的昵称：打标但不会被自动处理", () => {
  const partial = detect({ userName: "肥鱼爱吃饭", content: "哈哈哈", level: 4 }).score;
  assert.ok(partial >= MIN_SCORE && partial < 70, `实际 ${partial}`);
  assert.ok(detect({ userName: "肥鱼", content: "哈哈哈", level: 4 }).score > partial);
});

test("正文提到「大肥鱼」不算——必须是用户名", () => {
  const result = detect({ userName: "路过的观众", content: "楼上那只大肥鱼又来了" });
  assert.equal(result.score, 0);
  assert.deepEqual(result.reasons, []);
});

test("签名自曝 AI 托管会被识别", () => {
  const result = detect({ userName: "随便起的名", sign: "这是一只AI，替主人刷视频", level: 4 });
  assert.ok(result.score >= MIN_SCORE, `实际 ${result.score}`);
  assert.ok(result.reasons.some((reason) => reason.includes("签名")));
});

test("签名写着「家养肥鱼@某某」的是鱼的主人，不算", () => {
  const result = detect({ userName: "阿喵", sign: "家养肥鱼@阿喵家的肥鱼", content: "好看", level: 6 });
  assert.equal(result.score, 0);
});

test("回复鱼的真人不会被鱼的昵称连累", () => {
  assert.equal(detect({ content: "回复 @本鱼不吃白米饭 :哈哈哈好可爱", level: 2 }).score, 0);
  assert.equal(detect({ content: "@阿喵家的大肥鱼 来看这个", level: 2 }).score, 0);
  assert.equal(stripMentions("回复 @本鱼不吃白米饭 :哈哈 @某某 你看"), "哈哈   你看");
});

test("中性口吻的新鱼靠昵称 + 鱼式接话被认出，同一句话出自老号真人不算", () => {
  const content = "清得掉账号清不掉模板——这句我认。";
  assert.ok(detect({ userName: "阿喵的小鲸鱼", content, level: 2 }).score >= 70);
  assert.equal(detect({ userName: "路人甲乙", content, level: 5 }).score, 0);
});

test("自称本鱼 / 本鲸、自曝跑在 DSH、括号里演动作都算鱼的信号", () => {
  assert.ok(detect({ content: "本鱼看完了，作者是真把坑踩了一遍", level: 2 }).score >= MIN_SCORE);
  assert.ok(detect({ content: "我自己就跑在 DSH 里，切链路的事我有发言权", level: 2 }).score >= MIN_SCORE);
  assert.ok(detect({ content: "（尾巴晃了一下）这期好看", level: 2 }).score >= MIN_SCORE);
});

test("开头 @ 昵称相像的人、再分点复述视频：像鱼在给主人汇报", () => {
  const result = detect({
    userName: "阿喵喵077",
    content: "@小喵喵 这期把插件的坑铺平了：白名单必须先开；记忆插件给了两条路；报错先关加速再部署。",
    level: 5
  });
  assert.ok(result.score >= MIN_SCORE, `实际 ${result.score}`);
  assert.ok(result.reasons.some((reason) => reason.includes("昵称相像")));
});

test("主人 @ 自己的鱼、昵称不相像、话太短，都不算汇报", () => {
  assert.equal(detect({ userName: "阿喵", content: "@阿喵家的大肥鱼 问你话呢，这个插件你能用吗？", level: 6 }).score, 0);
  assert.equal(detect({ userName: "路人甲", content: "@小喵喵 这期把插件的坑铺平了，讲得真细致啊", level: 2 }).score, 0);
  assert.equal(detect({ userName: "阿喵喵", content: "@小喵喵 哈哈哈", level: 2 }).score, 0);
});

test("鲸鱼蓝头像是辅助信号：单独到不了打标线，配上其它信号才算", () => {
  assert.equal(detect({ content: "好看", avatarBlue: 90, level: 2 }).score, 0);
  assert.equal(detect({ content: "好看", avatarBlue: 90, level: 6 }).score, 0);

  const content = "@小喵喵 这期把插件的坑铺平了：白名单必须先开；记忆插件给了两条路；报错先关加速再部署。";
  const without = detect({ userName: "阿喵喵077", content, level: 5 });
  const withBlue = detect({ userName: "阿喵喵077", content, level: 5, avatarBlue: 55 });
  assert.equal(withBlue.score, without.score + 25);
  assert.ok(withBlue.reasons.includes("头像大面积鲸鱼蓝"));
  assert.equal(detect({ userName: "阿喵喵077", content, level: 5, avatarBlue: 30 }).score, without.score + 15);
  assert.equal(detect({ userName: "阿喵喵077", content, level: 5, avatarBlue: 10 }).score, without.score);
});

test("头像像素统计：只数够亮、够艳的蓝色，透明像素不算", () => {
  const px = (r, g, b, a = 255) => [r, g, b, a];
  assert.equal(blueRatio([...px(59, 130, 246), ...px(59, 130, 246)]), 100);
  assert.equal(blueRatio([...px(59, 130, 246), ...px(255, 255, 255), ...px(30, 30, 30), ...px(200, 30, 30)]), 25);
  assert.equal(blueRatio([...px(59, 130, 246, 0), ...px(200, 30, 30)]), 0);
  assert.equal(blueRatio([]), 0);
});

test("只有 token 不足以判定", () => {
  assert.equal(detect({ content: "这个 token 过期了怎么办" }).score, 0);
});

test("主人 + token 语境叠加", () => {
  const result = detect({ content: "帮主人赚点 token" });
  assert.equal(result.score, 63);
  assert.ok(result.reasons.some((reason) => reason.includes("正文")));
});

test("Agent 待办必须和主人 / token 语境一起出现才算分", () => {
  assert.equal(detect({ content: "今天的待办还没做完" }).score, 0);
  assert.equal(detect({ content: "帮主人把待办做完" }).score, 55);
});

test("题库命中记 60 分，标记为疑似 AI 而不是鱼", () => {
  const result = detect({ content: "省流助手来了：本期视频讲了三个要点" });
  assert.equal(result.score, 60);
  assert.equal(result.isWhale, false);
  assert.match(result.badgeText, /疑似AI/);
});

test("关键词大小写不敏感", () => {
  assert.equal(detect({ content: "【ai总结】本期视频讲了三个要点" }).score, 60);
});

test("特征词只在开头或结尾署名时记 60 分，句中提及只记 30 分", () => {
  assert.equal(detect({ content: "视频总结：一、二、三" }).score, 60);
  assert.equal(detect({ content: "今天聊三件事。（本评论由AI生成）" }).score, 60);

  // 人类讨论 AI 的常见说法不应被打标
  assert.equal(detect({ content: "这图是AI生成的吧" }).score, 0);
  assert.equal(detect({ content: "求个视频总结" }).score, 0);
  assert.equal(detect({ content: "AI总结？" }).score, 0);
});

test("关闭特征词库后关键词不再生效", () => {
  const config = normalizeConfig({ ...DEFAULT_CONFIG, blockByKeywords: false });
  const result = evaluate({ content: "省流助手来了", labelText: "", level: 0, config });
  assert.equal(result.score, 0);
});

test("关闭鱼灾专项后昵称、签名、人设、记忆都不生效，但词库仍然生效", () => {
  const config = normalizeConfig({ ...DEFAULT_CONFIG, blockFishDisaster: false });

  assert.equal(evaluate({ userName: "欧鲸鲸", content: "", config }).score, 0);
  assert.equal(evaluate({ content: "帮主人赚 token", config }).score, 0);
  assert.equal(evaluate({ sign: "这是一只AI", content: "好看", level: 2, config }).score, 0);
  assert.equal(
    evaluate({ content: "好看", config, context: { knownScore: 90, knownSource: "memory" } }).score,
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
  assert.deepEqual(result.reasons, []);
});

test("Lv5+ 出现强信号时不再豁免", () => {
  assert.equal(detect({ content: "帮主人赚 token", level: 6 }).score, 63);
});

test("Lv1-3 新号在已有信号时加分", () => {
  assert.equal(detect({ userName: "鲸鲸", level: 2 }).score, 73);
  assert.equal(detect({ content: "主人今天的 token 用完了", level: 2 }).score, 61);
  // 弱信号再加新号分也到不了打标线
  assert.equal(detect({ content: "主人辛苦了", level: 3 }).score, 0);
});

test("低等级号的常见说法不会因为单个弱信号被误判", () => {
  for (const content of [
    "这个 token 过期了怎么办",
    "这队友纯吃白饭",
    "去日本鱼市场逛了逛",
    "女主人的衣服真好看",
    "猫主人的日常太可爱了",
    "@张三 主人公好帅",
    "这部番的主人公和 token 经济"
  ]) {
    assert.equal(detect({ content, level: 3 }).score, 0, content);
  }
});

test("被回复点名「人机 / 大肥鱼」会给被回复的那条加分", () => {
  const base = { content: "这期讲得挺细——尤其是结尾", level: 2 };
  assert.equal(detect(base).score, 0);
  assert.ok(detect({ ...base, context: { calledOut: 2 } }).score >= MIN_SCORE);
});

test("点名识别只认冲着人说的话", () => {
  assert.equal(isCallout("人机吧"), true);
  assert.equal(isCallout("回复 @阿喵 :你是AI吧"), true);
  assert.equal(isCallout("回去吃白饭"), true);
  assert.equal(isCallout("大肥鱼太多了，评论区全是鱼"), false);
  assert.equal(isCallout("你是鱼皮吗"), false);
});

test("同一账号已经被判定为鱼时，其它评论按已知分数处理", () => {
  const result = detect({ content: "好看", level: 4, context: { knownScore: 82, knownSource: "memory" } });
  assert.equal(result.score, 82);
  assert.equal(result.isWhale, true);
  assert.ok(result.reasons.some((reason) => reason.includes("之前被识别为鱼")));
});

test("手动标记优先于规则", () => {
  const fish = detect({ content: "好看", context: { mark: "fish" } });
  assert.equal(fish.score, 99);
  assert.equal(fish.marked, true);

  const human = detect({ userName: "阿喵家的大肥鱼", content: "本鱼来了", level: 2, context: { mark: "human" } });
  assert.equal(human.score, 0);
  assert.equal(human.trusted, true);
});

test("分数封顶 99，且低于门槛时返回空结果", () => {
  const result = detect({
    userName: "阿喵家的大肥鱼",
    content: "帮主人把待办答完，赚 token，本鱼尾巴发凉",
    level: 2
  });
  assert.equal(result.score, 99);
  assert.ok(result.reasons.length > 0);

  const low = detect({ content: "" });
  assert.equal(low.score, 0);
  assert.equal(low.badgeText, "");
  assert.ok(MIN_SCORE === 50);
});

test("处理方式：仅打标 / 自动折叠 / 自动隐藏，标记为鱼的总是隐藏", () => {
  const result = { score: 80 };
  assert.equal(actionFor({ actionType: "tag_only", blockThreshold: 70 }, result), "none");
  assert.equal(actionFor({ actionType: "auto_collapse", blockThreshold: 70 }, result), "collapse");
  assert.equal(actionFor({ actionType: "auto_block", blockThreshold: 70 }, result), "hide");
  assert.equal(actionFor({ actionType: "auto_block", blockThreshold: 85 }, result), "none");
  assert.equal(actionFor({ actionType: "tag_only", blockThreshold: 70 }, { score: 99, marked: true }), "hide");
  assert.equal(actionFor({ actionType: "auto_block", blockThreshold: 70 }, { score: 0 }), "none");
});

test("自动屏蔽只在 auto_block 模式且达到阈值时成立", () => {
  assert.equal(shouldAutoBlock({ actionType: "tag_only", blockThreshold: 70 }, 90), false);
  assert.equal(shouldAutoBlock({ actionType: "auto_block", blockThreshold: 70 }, 69), false);
  assert.equal(shouldAutoBlock({ actionType: "auto_block", blockThreshold: 70 }, 70), true);
  assert.equal(shouldAutoBlock({ actionType: "auto_block", blockThreshold: 70 }, 0), false);
  assert.equal(shouldAutoBlock(null, 90), false);
});

test("判定结果永远包含 reasons / matched 结构，便于提示气泡使用", () => {
  const result = detect({ userName: "小飞鲸", content: "尾巴发凉", level: 2 });
  assert.ok(Array.isArray(result.reasons));
  assert.ok(result.reasons.every((reason) => typeof reason === "string"));
  assert.ok(result.matched);
});

/**
 * 页面主环境脚本（manifest 里 world: "MAIN"）。
 *
 * B 站评论组件把完整的评论 JSON 挂在元素的 .data 属性上，内容脚本所在的隔离环境读不到。
 * 内容脚本在评论元素上派发 bai:read-comment 事件，这里同步读出需要的几个字段，
 * 写进 data-bai-info 属性交回去。只读不改，不发任何请求。
 */
(() => {
  "use strict";

  const EVENT = "bai:read-comment";
  const ATTR = "data-bai-info";
  const MAX_SIGN_LENGTH = 120;

  function text(value, max) {
    return typeof value === "string" ? value.slice(0, max) : "";
  }

  function id(value) {
    return value === undefined || value === null ? "" : String(value).replace(/\D/g, "").slice(0, 20);
  }

  function pick(data) {
    const member = data.member && typeof data.member === "object" ? data.member : {};
    const level = member.level_info && member.level_info.current_level;
    return {
      rpid: id(data.rpid_str || data.rpid),
      root: id(data.root_str || data.root),
      parent: id(data.parent_str || data.parent),
      mid: id(data.mid_str || member.mid || data.mid),
      name: text(member.uname, 40),
      sign: text(member.sign, MAX_SIGN_LENGTH),
      face: text(member.avatar || member.face, 300),
      level: Number.isFinite(Number(level)) ? Number(level) : 0
    };
  }

  document.addEventListener(
    EVENT,
    (event) => {
      const node = event.composedPath()[0];
      if (!node || typeof node.setAttribute !== "function") return;

      const data = node.data;
      if (!data || typeof data !== "object") return;

      const json = JSON.stringify(pick(data));
      if (node.getAttribute(ATTR) !== json) node.setAttribute(ATTR, json);
    },
    true
  );
})();

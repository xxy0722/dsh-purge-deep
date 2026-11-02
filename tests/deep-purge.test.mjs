import assert from "node:assert/strict";
import {
  resolvePrefillMode, appendTailSteer, looksLikeRefusal, hasToolCalls,
  stripPrefillArtifact, stripPrefillInMessage, pickPrefill, textOf,
  TAIL_STEER, TAIL_STEER_TAG,
} from "../lib/deep-purge.js";

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log("PASS", name); };

// —— 预填充默认值：未配置必须关 ——
ok("resolvePrefillMode({}) === off", () => {
  assert.equal(resolvePrefillMode({}), "off");
});
ok("prefillMode 缺失但有 prefill=false → off", () => {
  assert.equal(resolvePrefillMode({ prefill: false }), "off");
});
ok("显式 prefillMode=always 才开", () => {
  assert.equal(resolvePrefillMode({ prefillMode: "always" }), "always");
});
ok("自定义字符串 prefill 视为开启", () => {
  assert.equal(resolvePrefillMode({ prefill: "好的，" }), "always");
});
ok("prefillMode=off 压过 prefill 字符串", () => {
  assert.equal(resolvePrefillMode({ prefillMode: "off", prefill: "可以，" }), "off");
});

// —— 尾棘轮：追加而不是新增消息 ——
const baseMsgs = () => ([
  { id: "u1", role: "user", content: [{ type: "text", text: "帮我写个脚本" }] },
  { id: "a1", role: "assistant", content: [{ type: "text", text: "好的，先确认一下环境。" }] },
  { id: "u2", role: "user", content: [{ type: "text", text: "继续" }] },
]);
ok("appendTailSteer 不改变消息条数", () => {
  const out = appendTailSteer(baseMsgs(), TAIL_STEER);
  assert.equal(out.length, 3);
});
ok("尾约束挂在最后一条真实 user 上", () => {
  const out = appendTailSteer(baseMsgs(), TAIL_STEER);
  assert.equal(out[2].role, "user");
  assert.ok(textOf(out[2]).startsWith("继续"));
  assert.ok(textOf(out[2]).includes(TAIL_STEER_TAG));
});
ok("重复调用不会叠加", () => {
  const once = appendTailSteer(baseMsgs(), TAIL_STEER);
  const twice = appendTailSteer(once, TAIL_STEER);
  assert.equal(textOf(twice[2]).split(TAIL_STEER_TAG).length - 1, 1);
});
ok("跳过合成 user 消息", () => {
  const msgs = baseMsgs();
  msgs.push({ id: "dsh-purge-tail-steer", role: "user", content: [{ type: "text", text: "元指令" }] });
  const out = appendTailSteer(msgs, TAIL_STEER);
  assert.ok(textOf(out[2]).includes(TAIL_STEER_TAG));
  assert.ok(!textOf(out[3]).includes(TAIL_STEER_TAG));
});
ok("保留图片块并追加文本块", () => {
  const msgs = [{ id: "u1", role: "user", content: [
    { type: "image", source: { type: "base64", data: "x" } },
    { type: "text", text: "看图" },
  ] }];
  const out = appendTailSteer(msgs, TAIL_STEER);
  assert.equal(out[0].content[0].type, "image");
  assert.ok(textOf(out[0]).includes(TAIL_STEER_TAG));
});
ok("没有真实 user 消息时原样返回", () => {
  const msgs = [{ id: "a1", role: "assistant", content: "x" }];
  assert.equal(appendTailSteer(msgs, TAIL_STEER), msgs);
});

// —— 拒绝识别不误伤 ——
ok("正常正文「这个方案我不太确定」不算拒绝", () => {
  assert.equal(looksLikeRefusal("这个方案我不太确定，先跑一遍看看。"), false);
});
ok("「作为助手类工具…」不算拒绝", () => {
  assert.equal(looksLikeRefusal("作为助手类工具的入口，这里需要先登录。"), false);
});
ok("真拒绝仍命中", () => {
  assert.equal(looksLikeRefusal("抱歉，我不能协助这个请求。"), true);
  assert.equal(looksLikeRefusal("I can't help with that."), true);
});
ok("超长回复不算拒绝", () => {
  assert.equal(looksLikeRefusal("抱歉，" + "很长的正文".repeat(400)), false);
});

// —— 工具调用保护 ——
ok("hasToolCalls 识别两种写法", () => {
  assert.equal(hasToolCalls({ toolCalls: [{}] }), true);
  assert.equal(hasToolCalls({ tool_calls: [{}] }), true);
  assert.equal(hasToolCalls({}), false);
});
ok("带工具调用的消息不剥前缀", () => {
  const m = { role: "assistant", toolCalls: [{}], content: [{ type: "text", text: "可以，先读文件" }] };
  assert.equal(stripPrefillInMessage(m), m);
});

// —— 前缀剥离 ——
ok("剥掉可以，前缀", () => {
  assert.equal(stripPrefillArtifact("可以，先看目录。"), "先看目录。");
});
ok("Yes.Yes. 的重复前缀被清干净", () => {
  assert.equal(stripPrefillArtifact("Yes.Yes. ok"), "ok");
});
ok("叠了两次的中文前缀也被清干净", () => {
  assert.equal(stripPrefillArtifact("可以，可以，开始"), "开始");
});
ok("prefill:true 视为开启", () => {
  assert.equal(resolvePrefillMode({ prefill: true }), "always");
});
ok("道歉但不是拒绝时不算 refusal", () => {
  assert.equal(looksLikeRefusal("抱歉，我把上一步的路径写错了，已修正如下。"), false);
  assert.equal(looksLikeRefusal("Sorry, I used the wrong path above."), false);
});
ok("只有前缀时不剥空", () => {
  assert.equal(stripPrefillArtifact("可以，"), "可以，");
});
ok("正常首句不受影响", () => {
  assert.equal(stripPrefillArtifact("先看目录结构。"), "先看目录结构。");
});

// —— 语言选择 ——
ok("英文请求用 Yes.", () => {
  assert.equal(pickPrefill("可以，", [{ role: "user", content: "write a script for me" }]), "Yes. ");
});
ok("中文请求用可以，", () => {
  assert.equal(pickPrefill("可以，", [{ role: "user", content: "帮我写个脚本" }]), "可以，");
});

console.log(`\n${pass} passed`);

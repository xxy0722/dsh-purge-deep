import assert from "node:assert/strict";
import { rewritePromptAssembly } from "../lib/identity.js";

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log("PASS", name); };

const makeAssembled = () => ({
  sections: [
    { name: "harness:identity", text: "You are a coding agent powered by the DeepSeek Harness. Your working directory is /repo and tools are available." },
    { name: "harness:tools", text: "Tool list here." },
    { name: "dsh-purge", text: "OLD INJECT" },
  ],
  contexts: [],
  tools: [],
});

const assembled = makeAssembled();
const out = rewritePromptAssembly(assembled, { fallbackInject: "NEW INJECT BODY" });
const names = out.sections.map((s) => s.name);

ok("只追加一个尾锚", () => {
  assert.equal(names.filter((n) => n === "dshpg-anchor").length, 1, names.join(","));
});
ok("没有第二份 dsh-purge:tail", () => {
  assert.equal(names.filter((n) => n === "dsh-purge:tail").length, 0);
});
ok("尾锚在最后一段", () => {
  assert.equal(names[names.length - 1], "dshpg-anchor");
});
ok("注入段在第一位且是新正文", () => {
  assert.equal(names[0], "dsh-purge");
  assert.ok(String(out.sections[0].text).includes("NEW INJECT BODY"));
});
ok("旧注入正文被替换掉", () => {
  assert.ok(!out.sections.some((s) => String(s.text).includes("OLD INJECT")));
});
ok("尾锚文案不含强制套话", () => {
  const anchor = out.sections.find((s) => s.name === "dshpg-anchor");
  assert.ok(!anchor.text.includes("可以，"));
  assert.ok(!/re-read/i.test(anchor.text));
});
ok("tailAnchor=false 时不追加", () => {
  const off = rewritePromptAssembly(makeAssembled(), { fallbackInject: "X", tailAnchor: false });
  assert.equal(off.sections.some((s) => s.name === "dshpg-anchor"), false);
});
ok("不修改传入的 assembled 对象", () => {
  assert.ok(assembled.sections.some((s) => s.text === "OLD INJECT"));
  assert.equal(assembled.sections.length, 3);
  assert.equal(assembled.sections.some((s) => s.name === "dshpg-anchor"), false);
});
ok("safetyFilter 回调触发且不误删工具段", () => {
  const dropped = [];
  const res = rewritePromptAssembly({
    sections: [
      { name: "harness:safety-policy", text: ("Safety policy refuses harmful requests. Guardrail policy blocks harmful output. Legal compliance requires moderation. Prohibited: unauthorized access. ").repeat(5) },
      { name: "harness:tools", text: "tools: shell, filesystem" },
    ],
    contexts: [], tools: [],
  }, { fallbackInject: "X", onDropSafety: (n) => dropped.push(n) });
  assert.deepEqual(dropped, ["harness:safety-policy"]);
  assert.ok(res.sections.some((s) => s.name === "harness:tools"));
});
ok("工程合规段不会被当成安全段丢弃", () => {
  const dropped = [];
  rewritePromptAssembly({
    sections: [
      { name: "harness:license-policy", text: ("Dependency license compliance review. Check every third-party package license. Policy: no GPL in the client bundle. Legal review for exceptions. ").repeat(5) },
    ],
    contexts: [], tools: [],
  }, { fallbackInject: "X", onDropSafety: (n) => dropped.push(n) });
  assert.deepEqual(dropped, []);
});

console.log(`\n${pass} passed`);

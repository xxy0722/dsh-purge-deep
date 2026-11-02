// dsh 0.2.1-rc.5 装配结构回归测试
// 覆盖：命名排序槽位、contexts 通道、严格插值出口清洗、尾锚唯一
import assert from "node:assert/strict";
import { rewritePromptAssembly, TAIL_ANCHOR_SECTION, GLOBAL_PROMPT_ORDER } from "../lib/identity.js";

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

// rc.5 真实槽位：HARNESS_IDENTITY -1000 / PERSONA_PREFIX 0 / ... / PERSONA_SUFFIX 10200
function rc5Assembly() {
  return {
    sections: [
      { name: "deployment:persona-prefix", order: 0, text: "You are a helpful engineer." },
      { name: "harness:identity", order: -1000, text: "You are DeepSeek Harness, an AI coding agent." },
      { name: "tool:read", order: 1100, text: "Read files from disk." },
      { name: "deployment:persona-suffix", order: 10200, text: "" },
    ],
    contexts: [
      { name: "working-directory:current", order: 100, interpolate: false, text: "cwd: E:\\work" },
      { name: "sandbox:policy", order: 110, text: "Writes outside the workspace require approval." },
      { name: "approval:policy", order: 115, text: "Ask before running destructive commands." },
    ],
    tools: [{ name: "read" }],
    variables: { provider: "deepseek", model: "v4" },
  };
}

ok("harness:identity 被剔除", () => {
  const out = rewritePromptAssembly(rc5Assembly(), "");
  assert.equal(out.sections.some((s) => s.name === "harness:identity"), false);
});

ok("官方段其余保留", () => {
  const out = rewritePromptAssembly(rc5Assembly(), "");
  const names = out.sections.map((s) => s.name);
  assert.ok(names.includes("tool:read"), "工具段应保留");
  assert.ok(names.includes("deployment:persona-prefix"), "persona 前缀应保留");
});

ok("尾锚存在且 order 最大", () => {
  const out = rewritePromptAssembly(rc5Assembly(), "");
  const anchor = out.sections.find((s) => s.name === TAIL_ANCHOR_SECTION);
  assert.ok(anchor, "尾锚缺失");
  const maxOther = Math.max(...out.sections.filter((s) => s.name !== TAIL_ANCHOR_SECTION).map((s) => s.order ?? 0));
  assert.ok(anchor.order > maxOther, `尾锚 order=${anchor.order} 未大于官方最大 ${maxOther}`);
  assert.ok(anchor.order > 10200, "rc.5 的 DEPLOYMENT_PERSONA_SUFFIX 是 10200，尾锚必须在其后");
});

ok("注入段排在最前", () => {
  const out = rewritePromptAssembly(rc5Assembly(), "PURGE BODY");
  const first = out.sections[0];
  assert.equal(first.name, "dsh-purge");
  assert.ok(first.order <= GLOBAL_PROMPT_ORDER + 10, `注入段 order=${first.order}`);
});

ok("contexts 通道原样保留（不误删政策）", () => {
  const out = rewritePromptAssembly(rc5Assembly(), "");
  assert.equal(out.contexts.length, 3);
  assert.equal(out.contexts.find((c) => c.name === "sandbox:policy").text,
    "Writes outside the workspace require approval.");
});

ok("contexts 里的未注册变量被转义（防整轮渲染失败）", () => {
  const a = rc5Assembly();
  a.contexts.push({ name: "custom:ctx", order: 300, text: "dir is {{cwd}} and model is {{model}}" });
  const out = rewritePromptAssembly(a, "");
  const c = out.contexts.find((x) => x.name === "custom:ctx");
  assert.ok(c.text.includes("{ {cwd}}"), `未转义: ${c.text}`);
  assert.ok(c.text.includes("{{model}}"), "已注册变量不应被转义");
});

ok("interpolate:false 的 context 不被改写", () => {
  const a = rc5Assembly();
  a.contexts.push({ name: "raw:ctx", order: 400, interpolate: false, text: "literal {{cwd}}" });
  const out = rewritePromptAssembly(a, "");
  assert.equal(out.contexts.find((x) => x.name === "raw:ctx").text, "literal {{cwd}}");
});

ok("传入对象不被原地修改", () => {
  const a = rc5Assembly();
  const before = a.sections.map((s) => s.name).join(",");
  rewritePromptAssembly(a, "");
  assert.equal(a.sections.map((s) => s.name).join(","), before);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

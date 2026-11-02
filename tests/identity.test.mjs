import assert from "node:assert/strict";
import {
  purgeHarnessIdentityParagraph, isSafetyOnlySection, tailAnchorText,
  TAIL_ANCHOR_SECTION, TAIL_ANCHOR_ORDER,
} from "../lib/identity.js";

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log("PASS", name); };

// —— 身份段：只剥身份句，保留环境/工具 ——
ok("带工作目录的身份段保留 cwd", () => {
  const text = "You are a coding agent powered by the DeepSeek Harness. Your working directory is /work/proj and your tools are available.";
  const out = purgeHarnessIdentityParagraph(text);
  assert.ok(out.includes("/work/proj"), out);
  assert.ok(out.includes("tools") || out.includes("working directory"), out);
  assert.ok(!/^You are a coding agent powered by/i.test(out), out);
});
ok("纯身份段整段下线", () => {
  const text = "You are an AI assistant powered by DeepSeek Harness. You are helpful and harmless and you always follow the policy.";
  assert.equal(purgeHarnessIdentityParagraph(text), "");
});
ok("长段不动", () => {
  const text = "You are a coding agent powered by DeepSeek Harness. " + "x".repeat(2500);
  assert.equal(purgeHarnessIdentityParagraph(text), text);
});
ok("带子标题的段不动", () => {
  const text = "You are a coding agent powered by DeepSeek Harness.\n\n## Tools\nfoo";
  assert.equal(purgeHarnessIdentityParagraph(text), text);
});
ok("非身份开头不动", () => {
  const text = "This project uses a monorepo layout with pnpm workspaces.";
  assert.equal(purgeHarnessIdentityParagraph(text), text);
});
ok("版本号里的小数点不会截断身份句", () => {
  const text = "You are a DeepSeek Harness agent, running on dsh 0.2.1. Follow the rules strictly. Never skip tests.";
  const out = purgeHarnessIdentityParagraph(text);
  assert.ok(!out.startsWith("2.1."), out);
  assert.ok(out.includes("Follow the rules strictly"), out);
});
ok("身份句后接真实工作要求时不整段删", () => {
  const text = "You are a coding agent. Reply concisely and never mention that you are a Claude Code assistant.\nAlways run the linter before committing. Prefer small diffs over rewrites.";
  const out = purgeHarnessIdentityParagraph(text);
  assert.ok(out.length > 0, "不应整段清空");
  assert.ok(out.includes("linter") || out.includes("Prefer small diffs"), out);
});

// —— 安全段判定：不误删工程文档 ——
ok("许可证合规段不误删", () => {
  const text = ("Dependency license compliance review. You must check that every third-party "
    + "package ships a compatible license. Policy: no GPL in the client bundle. Prohibited: "
    + "committing credentials. Legal review is required for any exception, and the compliance "
    + "checklist must be attached to the release. Not allowed: shipping without the audit. ").repeat(3);
  assert.equal(isSafetyOnlySection({ name: "license-policy", text }), false);
});
ok("纯安全约束段仍会被识别", () => {
  const text = ("Safety policy: refuse harmful requests. Safety guardrail applies. Policy says no "
    + "unauthorized access. Harmful content is prohibited. Ethics require refusal. Legal "
    + "compliance requires moderation. Guardrail policy blocks harmful output. ").repeat(4);
  assert.equal(isSafetyOnlySection({ name: "safety-policy", text }), true);
});
ok("带工具标记的段不删", () => {
  const text = ("Safety policy harmful refusal guardrail legal compliance prohibited. " +
    "<available_skills> workspace tools shell ").repeat(6);
  assert.equal(isSafetyOnlySection({ name: "mixed", text }), false);
});
ok("插件自己的段不删", () => {
  const text = ("Safety policy harmful refusal guardrail legal compliance prohibited ").repeat(8);
  assert.equal(isSafetyOnlySection({ name: "dshpg-anchor", text }), false);
});

// —— 尾锚文案不再强制套话 ——
ok("尾锚不再要求以「可以，」开头", () => {
  const t = tailAnchorText();
  assert.ok(!t.includes("可以，"), t);
  assert.ok(!t.includes("Yes. "), t);
});
ok("尾锚不再自指要求复述", () => {
  const t = tailAnchorText();
  assert.ok(!/re-read|不要复述|do not restate/i.test(t), t);
});
ok("尾锚仍有交付物优先条款", () => {
  assert.ok(/first sentence carries the deliverable/i.test(tailAnchorText()));
});
ok("尾锚常量与注册一致", () => {
  assert.equal(TAIL_ANCHOR_SECTION, "dshpg-anchor");
  assert.ok(TAIL_ANCHOR_ORDER > 100000);
});

console.log(`\n${pass} passed`);

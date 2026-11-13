#!/usr/bin/env node
/**
 * 修复「点一个会话，侧边栏就少一个」。
 *
 * 现象：dsh 桌面版 0.2.2-rc.1 里，点开某个会话后它从左侧列表消失，重启才回来。
 *
 * 根因（用 CDP 抓 WebSocket 帧确认）：
 *   点击 → 客户端发 `session/follow {activate:true}`
 *        → 宿主恢复会话时抛
 *          `RemoteError: tool-subagent-list-agents
 *           (@deepseek-ai/dsh-tool-subagent-control/list-agents): never started`
 *        → 宿主随后发 `api-session/error` + `api-session/removed`
 *        → 该会话从列表快照里被移除（磁盘与会话文件均未受损，重启即恢复）
 *
 * 触发条件：这一行插件在 profile 补丁里被声明，但 fiber 从未启动
 *   （插件管理器里能看到 `never started`）。恢复会话需要它，于是整条恢复失败。
 *
 * 修法：在 profile 的 `cordis.patch.yml` 里把该行标记 `disabled: true`。
 *   会话不再要求这个从未启动的工具，恢复即通过。实测三条会话连续点击均不再消失。
 *
 * 用法：
 *   node scripts/fix-session-resume.mjs            # 修复（自动备份）
 *   node scripts/fix-session-resume.mjs --check    # 只检查
 *   node scripts/fix-session-resume.mjs --enable   # 反做：把 disabled 去掉
 *   node scripts/fix-session-resume.mjs --profile headless
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const enable = argv.includes("--enable");
const profileArg = (() => {
  const i = argv.findIndex((a) => a === "--profile");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith("--profile="));
  return eq ? eq.slice("--profile=".length) : "desktop";
})();

const TARGET_ID = "tool-subagent-list-agents";
const TARGET_NAME = "@deepseek-ai/dsh-tool-subagent-control/list-agents";

function die(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function info(msg) {
  console.log(`  ${msg}`);
}

function findDshHome() {
  const home = process.env.DSH_HOME || "";
  if (home && fs.existsSync(home)) return home;
  // 脚本位于 <home>/plugins/dsh-purge/scripts/
  const guess = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "..");
  return fs.existsSync(path.join(guess, "profiles")) ? guess : "";
}

const home = findDshHome();
if (!home) die("找不到 DSH_HOME。请设置环境变量，例如 set DSH_HOME=E:\\harness");

const patchPath = path.join(home, "profiles", profileArg, "cordis.patch.yml");
if (!fs.existsSync(patchPath)) die(`找不到 profile 补丁：${patchPath}`);

console.log(`\n会话恢复修复  ·  profile=${profileArg}\n`);
info(`补丁文件：${patchPath}`);

let text = fs.readFileSync(patchPath, "utf8");
const lines = text.split(/\r?\n/);

// 定位 "- id: tool-subagent-list-agents" 及其后续缩进块
const idIdx = lines.findIndex((l) => new RegExp(`^\\s*-\\s*id:\\s*${TARGET_ID}\\s*$`).test(l));
if (idIdx < 0) {
  console.log(`\n✓ 补丁里没有 ${TARGET_ID} 这一行，dsh 不会因它失败，无需处理\n`);
  process.exit(0);
}

const idIndent = lines[idIdx].match(/^\s*/)[0].length;
let end = idIdx + 1;
while (end < lines.length) {
  const l = lines[end];
  if (l.trim() === "") break;
  const ind = l.match(/^\s*/)[0].length;
  if (ind <= idIndent && /^\s*-/.test(l)) break;
  end += 1;
}
const block = lines.slice(idIdx, end);
const blockText = block.join("\n");

if (!blockText.includes(TARGET_NAME)) {
  die(`第 ${idIdx + 1} 行的 id 对上了，但块内没有 ${TARGET_NAME}，不敢改，请人工确认`);
}

const isDisabled = /^\s*disabled:\s*true\s*$/m.test(blockText);

if (enable) {
  if (!isDisabled) {
    console.log(`\n✓ 该行本来就没被禁用，无需恢复\n`);
    process.exit(0);
  }
  if (checkOnly) {
    console.log(`\n· 当前为禁用状态（--enable 会把它改回启用）\n`);
    process.exit(0);
  }
  const next = text.replace(
    new RegExp(`(^\\s*-\\s*id:\\s*${TARGET_ID}[\\s\\S]*?\\n)(\\s*disabled:\\s*true\\s*\\r?\\n)`, "m"),
    "$1",
  );
  if (next === text) die("没能定位 disabled 行，请人工处理");
  fs.copyFileSync(patchPath, `${patchPath}.bak-resume-${Date.now()}`);
  fs.writeFileSync(patchPath, next, "utf8");
  console.log(`\n✓ 已恢复启用 ${TARGET_ID}（重启 dsh 生效）\n`);
  process.exit(0);
}

if (isDisabled) {
  console.log(`\n✓ 已经是 disabled，无需修复\n`);
  process.exit(0);
}

if (checkOnly) {
  console.log(`\n✗ ${TARGET_ID} 未禁用，点开会话会因它恢复失败而从列表消失`);
  console.log(`  修复：node scripts/fix-session-resume.mjs\n`);
  process.exit(1);
}

// 在块内最后一个非空行后插入 disabled: true，缩进与 name 对齐
const nameLine = block.find((l) => l.includes(TARGET_NAME));
const nameIndent = nameLine ? nameLine.match(/^\s*/)[0] : " ".repeat(idIndent + 2);
const insertAt = end;
const backup = `${patchPath}.bak-resume-${Date.now()}`;
fs.copyFileSync(patchPath, backup);
info(`已备份：${path.basename(backup)}`);

const patched = [...lines.slice(0, insertAt), `${nameIndent}disabled: true`, ...lines.slice(insertAt)];
fs.writeFileSync(patchPath, patched.join("\n"), "utf8");

console.log(`\n✓ 已在 ${TARGET_ID} 上标记 disabled: true`);
console.log(`  重启 dsh 后生效：点开会话不再从侧边栏消失\n`);

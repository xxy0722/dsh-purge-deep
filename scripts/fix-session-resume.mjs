#!/usr/bin/env node
/**
 * 修复「点一个会话，侧边栏就少一个」（dsh 桌面版 0.2.2 起）。
 *
 * 根因
 *   客户端点击 → `session/follow {activate:true}` → 宿主恢复会话时抛
 *     RemoteError: tool-subagent-list-agents
 *     (@deepseek-ai/dsh-tool-subagent-control/list-agents): never started
 *   → 宿主连发 `api-session/error` + `api-session/removed`，该会话被移出列表快照。
 *   磁盘上的会话文件与工作区登记都没变，所以重启即恢复。
 *
 * 为什么会 never started
 *   profile 补丁里那一行声明的是子路径 `@deepseek-ai/dsh-tool-subagent-control/list-agents`，
 *   但从 0.2.2 起该包的 package.json `exports` 只剩
 *     "."、"./src/*"、"./package.json"、"./locale/*.json"
 *   没有 `./list-agents` → 模块解析失败 → 这一行永远起不来。
 *
 * 工具并没有消失
 *   `list_agents` 已经并入主入口 `@deepseek-ai/dsh-tool-subagent-control`
 *   （见其 lib/index.js 里的 name: "list_agents"），所以删掉这行**不会丢功能**。
 *
 * 用法
 *   node scripts/fix-session-resume.mjs           # 修复：删除这条死行（先备份）
 *   node scripts/fix-session-resume.mjs --check   # 只检查
 *   node scripts/fix-session-resume.mjs --profile headless
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const profileArg = (() => {
  const i = argv.findIndex((a) => a === "--profile");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith("--profile="));
  return eq ? eq.slice("--profile=".length) : "desktop";
})();

const TARGET_ID = "tool-subagent-list-agents";

function die(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function findDshHome() {
  if (process.env.DSH_HOME && fs.existsSync(process.env.DSH_HOME)) return process.env.DSH_HOME;
  // 脚本位于 <home>/plugins/dsh-purge/scripts/
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const guess = path.resolve(here, "..", "..", "..");
  return fs.existsSync(path.join(guess, "profiles")) ? guess : "";
}

const home = findDshHome();
if (!home) die("找不到 DSH_HOME。请先设置环境变量，例如 set DSH_HOME=E:\\harness");

const patchPath = path.join(home, "profiles", profileArg, "cordis.patch.yml");
if (!fs.existsSync(patchPath)) die(`找不到 profile 补丁：${patchPath}`);

console.log(`\n会话恢复修复  ·  profile=${profileArg}\n`);
console.log(`  补丁文件：${patchPath}`);

const text = fs.readFileSync(patchPath, "utf8");
const lines = text.split("\n");

// 定位该 id 的整块（含 name / disabled 等子行）
const start = lines.findIndex((l) => new RegExp(`^\\s*-\\s*id:\\s*${TARGET_ID}\\s*$`).test(l));
if (start < 0) {
  console.log(`\n✓ 补丁里已没有 ${TARGET_ID}，会话恢复不会再因它失败\n`);
  process.exit(0);
}

const indent = lines[start].match(/^\s*/)[0].length;
let end = start + 1;
while (end < lines.length) {
  const l = lines[end];
  if (l.trim() === "") break;
  const ind = l.match(/^\s*/)[0].length;
  if (ind <= indent && l.trim().startsWith("-")) break;
  end += 1;
}

const block = lines.slice(start, end);
const blockText = block.join("\n");
if (!blockText.includes("@deepseek-ai/dsh-tool-subagent-control/list-agents")) {
  die(`第 ${start + 1} 行 id 对上了，但块内不是 list-agents 子路径，不敢改，请人工确认`);
}

if (checkOnly) {
  console.log(`\n✗ 第 ${start + 1}~${end} 行仍是死行：`);
  for (const l of block) console.log(`    ${l.trim()}`);
  console.log(`\n  该子路径在 0.2.2+ 已不存在（工具并入主入口），这行永远起不来，`);
  console.log(`  会让打开过的会话被宿主移出列表。`);
  console.log(`  修复：node scripts/fix-session-resume.mjs\n`);
  process.exit(1);
}

const backup = `${patchPath}.bak-resume-${Date.now()}`;
fs.copyFileSync(patchPath, backup);
const next = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
fs.writeFileSync(patchPath, next, "utf8");

console.log(`  已备份：${path.basename(backup)}`);
console.log(`\n✓ 已删除死行 ${TARGET_ID}（第 ${start + 1}~${end} 行）`);
console.log(`  list_agents 工具仍由 @deepseek-ai/dsh-tool-subagent-control 主入口提供，功能不丢`);
console.log(`  重启 dsh 生效：点开会话不再从侧边栏消失，插件清单里也不再有一条永远起不来的项\n`);

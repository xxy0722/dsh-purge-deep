#!/usr/bin/env node
/**
 * 一键发版：校验 CHANGELOG → 跑测试 → 提版本号 → 提交 → 打标签 → 推送。
 *
 *   node scripts/release.mjs 2.0.4 "feat: 一句话说明"
 *   node scripts/release.mjs 2.0.4 "..." --dry-run   只检查不落盘、不推送
 *
 * 设计原则：宁可拒绝执行，也不发出半成品。任何一步失败都停下并说明原因。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const version = (args[0] || "").replace(/^v/, "");
const message = args[1] || "";
const dryRun = args.includes("--dry-run");

function die(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function info(msg) {
  console.log(`  ${msg}`);
}

function git(...argv) {
  return execFileSync("git", argv, { cwd: ROOT, encoding: "utf8" }).trim();
}

// ── 1. 参数与前置检查 ────────────────────────────────────────────────
if (!/^\d+\.\d+\.\d+$/.test(version)) die("用法：node scripts/release.mjs <x.y.z> [\"提交说明\"] [--dry-run]");

const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const current = pkg.version;

console.log(`\n发版 ${current} → ${version}${dryRun ? "（dry-run）" : ""}\n`);

// 两种进入方式都支持：① 只写了 CHANGELOG，由脚本提版本号；
// ② 版本号已经自己改好 —— 此时在 tag 尚未存在的前提下按「发布当前版本」处理。
const alreadyAtTarget = version === current;
if (alreadyAtTarget) info(`package.json 已是 ${version}，按「发布当前版本」处理`);

const cmp = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};
if (!alreadyAtTarget && cmp(version, current) <= 0) die(`新版本 ${version} 必须大于当前 ${current}`);

let branch = "";
try {
  branch = git("rev-parse", "--abbrev-ref", "HEAD");
} catch {
  die("当前目录不是 git 仓库");
}
if (branch !== "main") die(`当前分支是 ${branch}，发版只允许在 main 上`);

// CHANGELOG 必须先写好这一版
const changelogPath = path.join(ROOT, "CHANGELOG.md");
if (!fs.existsSync(changelogPath)) die("找不到 CHANGELOG.md");
const changelog = fs.readFileSync(changelogPath, "utf8");
const heading = new RegExp(`^##\\s+${version.replace(/\./g, "\\.")}\\b`, "m");
if (!heading.test(changelog)) {
  die(`CHANGELOG.md 里没有 "## ${version}" 这一节。先写变更记录，再发版。`);
}
info(`CHANGELOG 已包含 ${version}`);

// 有未提交的改动是正常的（本次发版的内容）；但不能有未解决的冲突
if (fs.existsSync(path.join(ROOT, ".git", "MERGE_HEAD"))) die("仓库处于合并中，先解决冲突");
if (/^(<<<<<<<|=======|>>>>>>>)/m.test(changelog)) die("CHANGELOG.md 里还有冲突标记");

// ── 2. 跑测试 ────────────────────────────────────────────────────────
console.log("\n跑测试…");
const testRun = spawnSync(process.execPath, [path.join(ROOT, "tests", "run.mjs")], {
  cwd: ROOT,
  encoding: "utf8",
});
const testOut = `${testRun.stdout || ""}${testRun.stderr || ""}`.trimEnd();
console.log(testOut.split(/\r?\n/).slice(-9).join("\n"));
if (testRun.status !== 0) die("测试未通过，拒绝发版");

// ── 3. 提版本号 ──────────────────────────────────────────────────────
if (!alreadyAtTarget) {
  pkg.version = version;
  if (!dryRun) fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  info(`package.json version → ${version}`);
} else {
  info(`package.json version 保持 ${version}`);
}

// 运行时副本同步（plugins/<name> 与 profiles/*/node_modules/<name> 常与仓库互为硬链接）
const name = pkg.name;
const dshHome = process.env.DSH_HOME || "E:\\harness";
const mirrors = [
  path.join(dshHome, "plugins", name),
  path.join(dshHome, "profiles", "desktop", "node_modules", name),
];
for (const mirror of mirrors) {
  if (!fs.existsSync(mirror)) continue;
  for (const rel of ["package.json", "CHANGELOG.md", "README.md"]) {
    const src = path.join(ROOT, rel);
    const dst = path.join(mirror, rel);
    if (!fs.existsSync(src)) continue;
    if (dryRun) continue;
    try {
      fs.copyFileSync(src, dst);
      info(`同步 ${rel} → ${path.relative(dshHome, dst)}`);
    } catch (e) {
      info(`同步失败 ${rel} → ${dst}（${e.message}）`);
    }
  }
}

// ── 4. 提交 + 打标签 ─────────────────────────────────────────────────
const subject = message || `release: v${version}`;
if (dryRun) {
  console.log(`\n[dry-run] 将提交：${subject}`);
  console.log(`[dry-run] 将打标签：v${version}`);
  console.log("\n✓ dry-run 通过，没有写入任何东西");
  process.exit(0);
}

git("add", "-A");
const staged = git("diff", "--cached", "--name-only");
if (!staged) die("没有可提交的改动");
info(`待提交文件 ${staged.split(/\r?\n/).length} 个`);

git(
  "-c", "user.name=xxy0722",
  "-c", "user.email=xxy0722@users.noreply.github.com",
  "commit", "-q", "-m", `${subject}`,
);
info(`已提交 ${git("rev-parse", "--short", "HEAD")}`);

if (git("tag", "--list", `v${version}`)) die(`标签 v${version} 已存在`);
git("tag", `v${version}`);
info(`已打标签 v${version}`);

// ── 5. 推送 ──────────────────────────────────────────────────────────
console.log("\n推送…");
const push = (argv) =>
  spawnSync("git", ["-c", "http.schannelCheckRevoke=false", ...argv], { cwd: ROOT, encoding: "utf8" });

const pushMain = push(["push", "origin", "main"]);
if (pushMain.status !== 0) {
  console.error(`${pushMain.stdout || ""}${pushMain.stderr || ""}`.trim());
  die("推送 main 失败。本地提交与标签已保留，网络恢复后执行：\n    git push origin main && git push origin v" + version);
}
info("main 已推送");

const pushTag = push(["push", "origin", `v${version}`]);
if (pushTag.status !== 0) {
  console.error(`${pushTag.stdout || ""}${pushTag.stderr || ""}`.trim());
  die("标签推送失败，执行：git push origin v" + version);
}
info(`标签 v${version} 已推送`);

console.log(`\n✓ ${name} ${version} 已发布`);
console.log(`  https://github.com/xxy0722/dsh-purge-deep/releases/tag/v${version}\n`);

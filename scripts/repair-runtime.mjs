#!/usr/bin/env node
/**
 * 修复 dsh 桌面版更新后 `resources\runtime` 为空导致的启动 fatal。
 *
 *   ENOENT: no such file or directory, open '...\resources\runtime\office-skills\office\SKILL.md'
 *
 * 原理：桌面版自动更新只替换 app.asar，不总是把 runtime 载荷写回安装目录。
 * 脚本从升级缓存里的**同版本安装包**中抽出 `resources\runtime` 子树再回填。
 *
 *   node scripts/repair-runtime.mjs            # 自动探测并修复
 *   node scripts/repair-runtime.mjs --check    # 只检查
 *   node scripts/repair-runtime.mjs --force    # 版本不一致也强行修复
 *   node scripts/repair-runtime.mjs --app "D:\DSH"
 *
 * 依赖：本机安装 7-Zip（默认 C:\Program Files\7-Zip\7z.exe）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const force = argv.includes("--force");
const appArg = (() => {
  const i = argv.findIndex((a) => a === "--app");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith("--app="));
  return eq ? eq.slice("--app=".length) : "";
})();

const MIN_RUNTIME_FILES = 5000;

function die(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function info(msg) {
  console.log(`  ${msg}`);
}

/** 从卸载注册表读安装目录（新版只写 DisplayIcon / UninstallString，没有 InstallLocation）。 */
function readInstallInfo() {
  const keys = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  for (const key of keys) {
    let out = "";
    try {
      out = execFileSync("reg", ["query", key, "/s", "/f", "DeepSeek Harness"], {
        encoding: "latin1",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue;
    }
    const icon = out.match(/DisplayIcon\s+REG_[A-Z_]+\s+([^\r\n]+)/);
    const uninst = out.match(/UninstallString\s+REG_[A-Z_]+\s+(?:"([^"]+)"|([^\r\n]+))/);
    const loc = out.match(/InstallLocation\s+REG_[A-Z_]+\s+([^\r\n]+)/);
    let dir = "";
    if (loc) dir = loc[1].trim();
    else if (icon) dir = path.dirname(icon[1].trim().replace(/,\d+$/, ""));
    else if (uninst) dir = path.dirname((uninst[1] || uninst[2] || "").trim());
    if (dir) return { dir };
  }
  return null;
}

/** 从 app.asar 根 package.json 读已安装版本（不依赖注册表）。 */
function installedVersion(appDir) {
  const asar = path.join(appDir, "resources", "app.asar");
  if (!fs.existsSync(asar)) return "";
  try {
    const fd = fs.openSync(asar, "r");
    try {
      const pre = Buffer.alloc(16);
      fs.readSync(fd, pre, 0, 16, 0);
      if (pre.readUInt32LE(0) !== 4) return "";
      const headerSize = pre.readUInt32LE(4);
      const jsonSize = pre.readUInt32LE(12);
      const jsonBuf = Buffer.alloc(jsonSize);
      fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
      const header = JSON.parse(jsonBuf.toString("utf8"));
      const entry = header.files && header.files["package.json"];
      if (!entry || entry.unpacked) return "";
      const buf = Buffer.alloc(entry.size);
      fs.readSync(fd, buf, 0, entry.size, 8 + headerSize + Number(entry.offset));
      return JSON.parse(buf.toString("utf8")).version || "";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function find7z() {
  const candidates = [
    "C:\\Program Files\\7-Zip\\7z.exe",
    "C:\\Program Files (x86)\\7-Zip\\7z.exe",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return "";
}

function findPendingInstaller() {
  const dir = path.join(os.homedir(), "AppData", "Local", "@deepseek-aidsh-desktop-updater", "pending");
  if (!fs.existsSync(dir)) return null;
  const exes = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".exe"))
    .map((f) => {
      const full = path.join(dir, f);
      return { name: f, full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return exes[0] || null;
}

function runtimeStats(runtimeDir) {
  if (!fs.existsSync(runtimeDir)) return { files: 0, skill: false, version: "" };
  let files = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else files += 1;
    }
  };
  walk(runtimeDir);
  const skill = fs.existsSync(path.join(runtimeDir, "office-skills", "office", "SKILL.md"));
  let version = "";
  const rj = path.join(runtimeDir, "primary-runtime", "runtime.json");
  if (fs.existsSync(rj)) {
    try {
      version = JSON.parse(fs.readFileSync(rj, "utf8")).desktopVersion || "";
    } catch {
      version = "";
    }
  }
  return { files, skill, version };
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTree(from, to);
    else if (ent.isFile()) fs.copyFileSync(from, to);
  }
}

// ── 1. 定位安装目录 ─────────────────────────────────────────────────
console.log("\ndsh runtime 修复\n");

const regInfo = readInstallInfo();
const appDir = appArg || (regInfo && regInfo.dir) || "";
if (!appDir) die("找不到安装目录，请用 --app 指定（例如 --app \"E:\\DeepSeekHarness\"）");
const runtimeDir = path.join(appDir, "resources", "runtime");
const installed = installedVersion(appDir);
info(`安装目录：${appDir}`);
info(`已安装版本：${installed || "(未读到，请确认 resources/app.asar 存在)"}`);

// ── 2. 现状检查 ─────────────────────────────────────────────────────
const before = runtimeStats(runtimeDir);
info(`runtime：${before.files} 个文件${before.skill ? "，SKILL.md 就位" : "，SKILL.md 缺失"}`);

if (before.files >= MIN_RUNTIME_FILES && before.skill) {
  console.log(`\n✓ runtime 完整（${before.files} 个文件），无需修复`);
  process.exit(0);
}

if (checkOnly) {
  console.log(`\n✗ runtime 不完整：需要修复`);
  console.log(`  修复：node ${path.relative(process.cwd(), process.argv[1]) || "scripts/repair-runtime.mjs"}`);
  process.exit(1);
}

// ── 3. 找同版本安装包 ───────────────────────────────────────────────
const installer = findPendingInstaller();
if (!installer) {
  die("升级缓存里没有安装包。\n  路径：%LOCALAPPDATA%\\@deepseek-aidsh-desktop-updater\\pending\\\n  没有的话请重新运行一次官方安装程序，再执行本脚本。");
}
const verInName = (installer.name.match(/(\d+\.\d+\.\d+(?:-[a-z]+\.[0-9]+)?)/i) || [])[1] || "";
info(`安装包：${installer.name}`);
info(`包内版本：${verInName || "(无法识别)"}`);

if (verInName && installed && verInName !== installed && !force) {
  die(`安装包版本(${verInName}) 与已安装版本(${installed}) 不一致。\n  确认真的是同一版本后加 --force 再跑。`);
}

const sevenZip = find7z();
if (!sevenZip) die("找不到 7-Zip（C:\\Program Files\\7-Zip\\7z.exe），请先安装或手工解包");

// ── 4. 解包 → 回填 ──────────────────────────────────────────────────
const tmp = path.join(os.tmpdir(), `dsh-runtime-repair-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
console.log("\n解包中（约 290MB 安装包，需要几十秒）…");

try {
  execFileSync(sevenZip, ["e", installer.full, `-o${tmp}`, "$PLUGINSDIR\\app-64.7z", "-y"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const inner = path.join(tmp, "app-64.7z");
  if (!fs.existsSync(inner)) die("安装包里没有 $PLUGINSDIR\\app-64.7z，可能不是 NSIS 打包");

  execFileSync(sevenZip, ["x", inner, "resources\\runtime\\*", `-o${path.join(tmp, "payload")}`, "-y"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const src = path.join(tmp, "payload", "resources", "runtime");
  if (!fs.existsSync(src)) die("解包结果里没有 resources\\runtime");

  const srcStats = runtimeStats(src);
  info(`解出 ${srcStats.files} 个文件，SKILL.md ${srcStats.skill ? "就位" : "缺失"}`);
  if (srcStats.files < MIN_RUNTIME_FILES) die(`解出的文件数异常（${srcStats.files}），中止以免写坏安装`);

  console.log("\n回填中…");
  copyTree(src, runtimeDir);
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 临时目录留一份不影响运行 */
  }
}

// ── 5. 校验 ─────────────────────────────────────────────────────────
const after = runtimeStats(runtimeDir);
console.log("");
info(`修复后：${after.files} 个文件`);
info(`SKILL.md：${after.skill ? "就位" : "缺失"}`);
info(`runtime.json desktopVersion：${after.version || "(未读到)"}`);

if (after.files < MIN_RUNTIME_FILES || !after.skill) {
  die("修复后仍不完整，请重跑官方安装程序后再试");
}
if (installed && after.version && after.version !== installed) {
  console.log(`  ⚠ runtime 版本(${after.version}) 与程序版本(${installed}) 不一致，建议重跑官方安装程序`);
}

console.log(`\n✓ runtime 已修复，现在可以启动 DeepSeek Harness\n`);

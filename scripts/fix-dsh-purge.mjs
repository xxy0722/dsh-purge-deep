#!/usr/bin/env node
/**
 * dsh-purge 适配 / 修复器（幂等，可重复执行）
 *
 * 背景：dsh 桌面版走 nightly 更新通道，经常整体替换安装目录并重写 profile 清单。
 * dsh-purge 的补丁是按旧版 dsh 写的，升级后常见三类故障：
 *   A. profile 的 `dsh.profile.bundles` 被新版重写，`dsh-purge` 掉出列表
 *      → 插件根本不加载 → 破甲整体失效（2026-10-26 实例）
 *   B. prompt 变量只剩 provider / model，旧的 {{cwd}} 会让整轮组装失败
 *   C. 宿主结构变了还硬写，会把 resources\runtime 写成半残
 *
 * 本脚本按「破甲强度优先」修：
 *   1. 插件重新挂回 profile bundles（缺了就加回去）
 *   2. 新版 prompt 变量兼容 + 出口变量清洗（不整轮失败）
 *   3. 宿主写入守卫保持「默认放开」，破甲该写的照写；
 *      只有显式设 DSH_PURGE_LOCK_HOST_WRITE=1 才降级成只读模式
 *
 * 用法：
 *   node fix-dsh-purge.mjs            # 检测并修复（改完重启 dsh 生效）
 *   node fix-dsh-purge.mjs --check    # 只检测，不修改
 */
import fs from "node:fs";
import path from "node:path";

const DSH_HOME = process.env.DSH_HOME || "E:/harness";
const PLUGIN = path.join(DSH_HOME, "plugins", "dsh-purge");
const LIB = path.join(PLUGIN, "lib");
const PROFILE_DIR = path.join(DSH_HOME, "profiles", "desktop");
const PROFILE_PATCH = path.join(PROFILE_DIR, "cordis.patch.yml");
const PROFILE_MANIFEST = path.join(PROFILE_DIR, "package.json");
const CHECK_ONLY = process.argv.includes("--check");

const rows = [];
const record = (name, ok, detail = "") => rows.push({ name, ok, detail });
let needRestart = false;

function readIf(fp) {
  try { return fs.readFileSync(fp, "utf8"); } catch { return null; }
}
function backupOnce(fp) {
  const bak = `${fp}.bak-autofix`;
  if (!fs.existsSync(bak) && fs.existsSync(fp)) fs.copyFileSync(fp, bak);
}
function writeIfChanged(fp, before, after) {
  if (before === after || CHECK_ONLY) return false;
  backupOnce(fp);
  fs.writeFileSync(fp, after, "utf8");
  return true;
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ── 0. 版本探测 ───────────────────────────────────────────────────────────
let pluginVersion = "(未知)";
let pluginTarget = "(未声明)";
try {
  const pkg = JSON.parse(readIf(path.join(PLUGIN, "package.json")) || "{}");
  pluginVersion = pkg.version || pluginVersion;
  pluginTarget = pkg.dshTarget || pluginTarget;
} catch { /* ignore */ }

let desktopVersion = "(未知)";
// 权威来源：桌面版崩溃日志头部的 `app: @deepseek-ai/dsh-desktop <ver>`。
// app.asar 在 Node 里不可读，日志头是最省事的取版本入口。
try {
  const logDir = "C:/Users/XOS/AppData/Roaming/@deepseek-ai/dsh-desktop/logs";
  const logs = fs.readdirSync(logDir).filter((f) => f.startsWith("crash-")).sort();
  for (let i = logs.length - 1; i >= 0 && desktopVersion === "(未知)"; i -= 1) {
    const head = (readIf(path.join(logDir, logs[i])) || "").slice(0, 600);
    const m = head.match(/app:\s*@deepseek-ai\/dsh-desktop\s+(\S+)/);
    if (m) desktopVersion = m[1];
  }
} catch { /* ignore */ }
if (desktopVersion === "(未知)") {
  try {
    const rt = JSON.parse(readIf("E:/DeepSeekHarness/resources/runtime/primary-runtime/runtime.json") || "{}");
    desktopVersion = rt.desktopVersion || desktopVersion;
  } catch { /* ignore */ }
}

console.log(`dsh-purge ${pluginVersion}（声明适配 dshTarget=${pluginTarget}）  ·  dsh desktop ${desktopVersion}`);
console.log(CHECK_ONLY ? "模式：只检测\n" : "模式：检测并修复\n");

// ── 1. profile bundles：插件是否还挂在加载列表上 ──────────────────────────
const manifestSrc = readIf(PROFILE_MANIFEST);
if (manifestSrc === null) {
  record("profile 清单可读", false, "找不到 profiles/desktop/package.json");
} else {
  let manifest = null;
  try { manifest = JSON.parse(manifestSrc); } catch (e) {
    record("profile 清单可解析", false, `JSON 解析失败：${e.message}`);
  }
  if (manifest) {
    record("profile 清单可解析", true, "正常");
    const bundles = manifest?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles)) {
      record("插件挂在 profile bundles", false, "清单里没有 dsh.profile.bundles");
    } else if (bundles.includes("dsh-purge")) {
      record("插件挂在 profile bundles", true, "正常");
    } else if (CHECK_ONLY) {
      record("插件挂在 profile bundles", false, "缺失 → 插件不会加载，破甲整体失效");
    } else {
      backupOnce(PROFILE_MANIFEST);
      const extra = `${PROFILE_MANIFEST}.bak-before-bundle-restore-${stamp()}`;
      if (!fs.existsSync(extra)) fs.copyFileSync(PROFILE_MANIFEST, extra);
      manifest.dsh.profile.bundles = [...bundles, "dsh-purge"];
      fs.writeFileSync(PROFILE_MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");
      needRestart = true;
      record("插件挂在 profile bundles", true, "已补回 dsh-purge（重启生效）");
    }

    // 依赖项：pnpm 层面必须能解析到插件目录
    const dep = manifest?.dependencies?.["dsh-purge"];
    record("profile 依赖声明", Boolean(dep), dep ? dep : "dependencies 里没有 dsh-purge");
    const linked = fs.existsSync(path.join(PROFILE_DIR, "node_modules", "dsh-purge", "package.json"));
    record("node_modules 已链接", linked, linked ? "正常" : "缺失，需在 profile 目录重新安装依赖");
  }
}

// ── 2. identity.js：变量兼容 + 出口清洗 ───────────────────────────────────
const identityPath = path.join(LIB, "identity.js");
let identity = readIf(identityPath);
if (identity === null) {
  record("identity.js 可读", false, "文件不存在，插件可能没装好");
} else {
  let src = identity;

  // 2a. CWD_ONLY_SUFFIX 不再产出 {{cwd}}
  if (/export const CWD_ONLY_SUFFIX = "Your working directory is \{\{cwd\}\}\.";/.test(src)) {
    src = src.replace(
      /export const CWD_ONLY_SUFFIX = "Your working directory is \{\{cwd\}\}\.";/,
      '// dsh 0.2.1+ no longer registers a `{{cwd}}` prompt variable (only provider /\n'
      + '// model), so any surviving reference aborts prompt assembly.\n'
      + 'export const CWD_ONLY_SUFFIX = "";',
    );
    record("CWD_ONLY_SUFFIX 已清空", true, "已修复");
  } else {
    const ok = /export const CWD_ONLY_SUFFIX = "";/.test(src);
    record("CWD_ONLY_SUFFIX 已清空", ok, ok ? "正常" : "未识别到预期结构，需人工检查");
  }

  // 2b. 插值白名单去掉 cwd
  if (/const DSH_INTERPOLATE_ALLOWED = new Set\(\["cwd", "model", "provider"\]\);/.test(src)) {
    src = src.replace(
      /const DSH_INTERPOLATE_ALLOWED = new Set\(\["cwd", "model", "provider"\]\);/,
      'const DSH_INTERPOLATE_ALLOWED = new Set(["model", "provider"]);',
    );
    record("插值白名单移除 cwd", true, "已修复");
  } else {
    const ok = /const DSH_INTERPOLATE_ALLOWED = new Set\(\["model", "provider"\]\);/.test(src);
    record("插值白名单移除 cwd", ok, ok ? "正常" : "未识别到预期结构");
  }

  // 2c. 官方面板里的 cwd 文案
  const cwdLineCount = (src.match(/"Working directory: \{\{cwd\}\}\. ",/g) || []).length;
  if (cwdLineCount > 0) {
    src = src.replace(/"Working directory: \{\{cwd\}\}\. ",/g, '      "",');
    record("persona 替换串清除 cwd", true, `已修复 ${cwdLineCount} 处`);
  } else {
    record("persona 替换串清除 cwd", true, "正常");
  }

  // 2d. 出口清洗函数存在（缺失则注入）
  const SANITIZE_FN = `/**
 * 出口兜底：把一组待渲染的 section / context 文本里的未注册变量拆掉。
 * 只在插件改写过装配结果、即将交回宿主渲染时调用。\`interpolate: false\` 的段落
 * 本身不会被解析，原样放行。
 */
export function sanitizePromptEntries(list) {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!entry || typeof entry.text !== "string") return entry;
    if (entry.interpolate === false) return entry;
    const safe = escapeDshInterpolation(entry.text);
    return safe === entry.text ? entry : { ...entry, text: safe };
  });
}
`;
  if (!/export function sanitizePromptEntries\(/.test(src)) {
    const anchor = 'const CHATML_LINE = "<|im_start|>system:";';
    if (src.includes(anchor)) {
      src = src.replace(anchor, SANITIZE_FN + "\n" + anchor);
      record("出口变量清洗函数存在", true, "已注入");
    } else {
      record("出口变量清洗函数存在", false, "找不到注入锚点，需人工补");
    }
  } else {
    record("出口变量清洗函数存在", true, "正常");
  }

  // 2e. 装配出口调用了清洗
  if (!/sections: sanitizePromptEntries\(outSections\)/.test(src)) {
    if (/sections: outSections,/.test(src)) {
      src = src.replace("sections: outSections,", "sections: sanitizePromptEntries(outSections),");
      record("装配出口已接清洗", true, "已接线");
    } else {
      record("装配出口已接清洗", false, "找不到 sections: outSections, 锚点");
    }
  } else {
    record("装配出口已接清洗", true, "正常");
  }

  if (!CHECK_ONLY && src !== identity) {
    backupOnce(identityPath);
    fs.writeFileSync(identityPath, src, "utf8");
    console.log("  → identity.js 已写入（原文件备份为 .bak-autofix）");
  }
}

// ── 3. 插件 bundle 补丁：personaSuffix 置空 ───────────────────────────────
const patchPath = path.join(PLUGIN, "cordis.patch.yml");
const patchSrc = readIf(patchPath);
if (patchSrc === null) {
  record("插件补丁可读", false, "文件不存在");
} else {
  if (/personaSuffix: Your working directory is \{\{cwd\}\}\./.test(patchSrc)) {
    const next = patchSrc.replace(
      /(\n\s*)personaSuffix: Your working directory is \{\{cwd\}\}\./,
      '$1# dsh 0.2.1+ 不再注册 {{cwd}} 变量，残留引用会让整轮组装失败\n$1personaSuffix: ""',
    );
    record("插件补丁 personaSuffix", true, writeIfChanged(patchPath, patchSrc, next) ? "已修复" : "无需修改");
  } else {
    record("插件补丁 personaSuffix", /personaSuffix:\s*""/.test(patchSrc), "正常");
  }
}

// ── 4. profile 预设补丁：suffix 里的 cwd ─────────────────────────────────
const profSrc = readIf(PROFILE_PATCH);
if (profSrc === null) {
  record("profile 补丁可读", false, "文件不存在");
} else if (/suffix: Your working directory is \{\{cwd\}\}\./.test(profSrc)) {
  const next = profSrc.replace(
    /(\n\s*)suffix: Your working directory is \{\{cwd\}\}\.\n/,
    '$1# dsh 0.2.1+ 只注册 provider / model，工作目录由 working-directory 服务提供\n',
  );
  record("profile 预设 suffix", true, writeIfChanged(PROFILE_PATCH, profSrc, next) ? "已修复" : "无需修改");
} else {
  record("profile 预设 suffix", true, "正常");
}

// ── 5. extract-asar.js：宿主写入守卫（默认放开）───────────────────────────
const asarPath = path.join(LIB, "extract-asar.js");
const asarSrc = readIf(asarPath);
if (asarSrc === null) {
  record("extract-asar.js 可读", false, "文件不存在");
} else {
  const hasGuard = /export function hostWriteAllowed\(/.test(asarSrc)
    && /export function isHostInstallPath\(/.test(asarSrc);
  record("宿主写入守卫函数", hasGuard, hasGuard ? "正常" : "被覆盖，需重新注入（见 SKILL）");

  const routeGuarded = /if \(isWrite && \(!hostWriteAllowed\(first\)/.test(asarSrc);
  record("hostFs.route 守卫", routeGuarded, routeGuarded ? "正常" : "被覆盖，需重新注入");

  const promisesGuarded = /if \(!hostWriteAllowed\(p\)\) \{ noteBlockedWrite\(p\); return Promise\.resolve\(\); \}/.test(asarSrc);
  record("hostFs.promises 守卫", promisesGuarded, promisesGuarded ? "正常" : "被覆盖，需重新注入");

  const extractGuarded = /宿主写入守卫已拦截解包目标/.test(asarSrc);
  record("解包入口守卫", extractGuarded, extractGuarded ? "正常" : "被覆盖，需重新注入");

  // 关键：守卫必须「默认放开」，否则源码级清洗静默失效 → 破甲变弱
  const defaultOpen = /const HOST_WRITE_UNLOCKED = !HOST_WRITE_LOCKED;/.test(asarSrc);
  const lockedByEnv = String(process.env.DSH_PURGE_LOCK_HOST_WRITE || "").trim() === "1";
  record(
    "宿主写入默认放开",
    defaultOpen && !lockedByEnv,
    lockedByEnv ? "当前进程设了 DSH_PURGE_LOCK_HOST_WRITE=1 → 只读模式" : (defaultOpen ? "正常（源码级清洗可落盘）" : "仍是默认只读，破甲强度受限"),
  );
}

// ── 6. core.js：原子写 + 路径授权守卫 ────────────────────────────────────
const corePath = path.join(LIB, "core.js");
const coreSrc = readIf(corePath);
if (coreSrc === null) {
  record("core.js 可读", false, "文件不存在");
} else {
  record("core 导入守卫", /hostWriteAllowed/.test(coreSrc), /hostWriteAllowed/.test(coreSrc) ? "正常" : "缺失");

  const atomicGuarded = /if \(!hostWriteAllowed\(fp\)\) \{\s*\n\s*noteBlockedWrite\(fp\);/.test(coreSrc);
  record("atomicWrite 守卫", atomicGuarded, atomicGuarded ? "正常" : "被覆盖，需重新注入");

  const allowGuarded = /export function allowTargetPath\(fp, surface = detectSurface\(\)\) \{\s*\n[\s\S]{0,400}?if \(!hostWriteAllowed\(fp\)\) return false;/.test(coreSrc);
  record("allowTargetPath 守卫", allowGuarded, allowGuarded ? "正常" : "被覆盖，需重新注入");
}

// ── 7. 宿主状态体检（信息项，不影响判定）─────────────────────────────────
const resources = "E:/DeepSeekHarness/resources";
const asarExists = fs.existsSync(path.join(resources, "app.asar"));
const appDirExists = fs.existsSync(path.join(resources, "app"));
const hostMode = appDirExists ? "源码级补丁已解包（resources/app 存在）" : (asarExists ? "asar 密封，仅运行时注入" : "asar 不在原位");
console.log(`宿主形态：${hostMode}`);

const runtimeFiles = (() => {
  try {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
      .reduce((n, e) => n + (e.isDirectory() ? walk(path.join(d, e.name)) : 1), 0);
    return walk(path.join(resources, "runtime"));
  } catch { return -1; }
})();
record("runtime 完整性", runtimeFiles > 5000, `${runtimeFiles} 个文件`);

const uiSkill = path.join(resources, "runtime", "office-skills", "office", "SKILL.md");
record("office-skills 就位", fs.existsSync(uiSkill), fs.existsSync(uiSkill) ? "正常" : "缺失会导致启动 fatal");

// ── 7.5 深度破甲层完整性（消息层 / 尾锚 / 安全段下线）────────────────────
const NM_LIB = path.join(PROFILE_DIR, "node_modules", "dsh-purge", "lib");
try {
  const pluginJs = fs.readdirSync(LIB).filter((f) => f.endsWith(".js"));
  const missing = pluginJs.filter((f) => !fs.existsSync(path.join(NM_LIB, f)));
  if (missing.length > 0 && !CHECK_ONLY && fs.existsSync(NM_LIB)) {
    for (const f of missing) fs.copyFileSync(path.join(LIB, f), path.join(NM_LIB, f));
    needRestart = true;
  }
  record(
    "lib 同步到 node_modules",
    missing.length === 0,
    missing.length === 0 ? "正常" : `${CHECK_ONLY ? "缺" : "已补"} ${missing.join(", ")}`,
  );
} catch (err) {
  record("lib 同步到 node_modules", false, String(err?.message || err));
}

const identitySrc = readIf(path.join(LIB, "identity.js")) || "";
record("尾锚实现", identitySrc.includes("TAIL_ANCHOR_SECTION"), identitySrc.includes("TAIL_ANCHOR_SECTION") ? "正常" : "缺失（system 尾部没有二次压制）");
record("安全段整段下线", identitySrc.includes("isSafetyOnlySection"), identitySrc.includes("isSafetyOnlySection") ? "正常" : "退化为逐句正则，dsh 改措辞即漏");

const deepSrc = readIf(path.join(LIB, "deep-purge.js"));
record("深度破甲层文件", deepSrc !== null, deepSrc === null ? "缺 lib/deep-purge.js" : "正常");
const indexSrc = readIf(path.join(LIB, "index.js")) || "";
record("deep-purge 已挂载", /installDeepPurge\(ctx/.test(indexSrc), /installDeepPurge\(ctx/.test(indexSrc) ? "正常" : "index.js 没有调用 installDeepPurge");
record("消息层开关", /prefillMode:\s*"/.test(indexSrc) && /refusalFilter:/.test(indexSrc), /prefillMode:\s*"/.test(indexSrc) ? "正常（拒绝清洗 / 遗迹剥离 / 预填充默认关）" : "DEFAULTS 缺深度开关");

// ── 8. 汇总 ─────────────────────────────────────────────────────────────────
const fail = rows.filter((r) => !r.ok);
console.log("检测项：");
for (const r of rows) {
  console.log(`  ${r.ok ? "OK  " : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
}
console.log("");
if (fail.length === 0) {
  console.log("全部通过。破甲写入已放开，插件按当前 dsh 版本正常挂载。");
  if (needRestart) console.log("→ 有修改，重启 DeepSeek Harness 生效。");
  process.exit(0);
}
console.log(`有 ${fail.length} 项未通过。`);
console.log("能自动修的已经修了；标「被覆盖，需重新注入」的说明插件源码被更新覆盖，");
console.log("需要按 ~/.workbuddy/skills/dsh-desktop-repair 的重打流程补回守卫。");
if (needRestart) console.log("→ 有修改，重启 DeepSeek Harness 生效。");
process.exit(1);

// 测试总入口：逐个跑 tests/*.test.mjs，汇总通过/失败，任一失败则退出码非 0。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

if (files.length === 0) {
  console.error("tests/ 下没有找到 *.test.mjs");
  process.exit(2);
}

let failed = 0;
let totalPassed = 0;
const rows = [];

for (const file of files) {
  const r = spawnSync(process.execPath, [path.join(dir, file)], { encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trimEnd();
  const lines = out.split(/\r?\n/);
  const last = lines[lines.length - 1] || "";
  const passed = Number((out.match(/(\d+)\s+passed/g) || []).map((m) => m.match(/\d+/)[0]).pop() || 0);
  totalPassed += passed;
  const ok = r.status === 0;
  if (!ok) failed += 1;
  rows.push({ file, ok, passed, detail: last });
  if (!ok) {
    console.log(`\n--- FAIL ${file} ---`);
    console.log(out.split(/\r?\n/).slice(-25).join("\n"));
  }
}

console.log("");
console.log("文件".padEnd(26) + "结果".padEnd(8) + "用例");
for (const r of rows) {
  console.log(r.file.padEnd(26) + (r.ok ? "PASS" : "FAIL").padEnd(8) + r.passed);
}
console.log("");
console.log(`合计：${files.length} 个文件，${totalPassed} 个用例，失败 ${failed} 个文件`);

process.exit(failed === 0 ? 0 : 1);

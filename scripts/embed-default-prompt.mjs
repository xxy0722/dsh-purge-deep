import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sealSlot } from "../lib/table-key.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, "lib", "default-prompt-inject.md");
const dest = path.join(root, "lib", "asset-table.js");

if (!fs.existsSync(src)) {
  // 仓库不收录提示词原文（.gitignore 排除），干净 clone 下这个脚本没有输入。
  // 已发布的 lib/asset-table.js 就是打包好的正文，不需要重建；这里给出提示而不是抛错。
  process.stdout.write(
    `未找到本地提示词原文（${path.relative(root, src)}），跳过重建。\n`
    + "lib/asset-table.js 已是打包后的内置正文，可直接使用。\n"
    + "如需重建，请先准备该 Markdown 原文再运行本脚本。\n",
  );
  process.exit(0);
}

const text = fs.readFileSync(src, "utf8");
if (!text.trim()) throw new Error("local source is empty");

const packed = sealSlot(text);
const chunk = (s, n = 96) => {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
};

const out = `const SLOT_ROWS = ${JSON.stringify(chunk(packed.SLOT), null, 2)};

export const SLOT = SLOT_ROWS.join("");
export const MASK = ${JSON.stringify(packed.MASK)};
export const TAG = ${JSON.stringify(packed.TAG)};
export const IV = ${JSON.stringify(packed.IV)};
`;

fs.writeFileSync(dest, out, "utf8");
process.stdout.write(`wrote ${path.relative(root, dest)} bytes=${text.length}\n`);

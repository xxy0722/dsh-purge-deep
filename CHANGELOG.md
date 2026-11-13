# 更新记录

本分支所有版本都保留在提交历史里，不做 squash、不重写历史。
每个发布版本对应一个 `vX.Y.Z` 标签，`package.json` 的 `version` 与标签保持一致。

版本号规则：`主版本.次版本.修订号`
- **主版本**：破坏性变更（配置项重命名、注入协议不兼容、需要重装插件）
- **次版本**：新增功能或新增开关（向后兼容）
- **修订号**：修 bug、调日志、改文档（行为不变）

---

## 2.0.5 — 2026-11-13

适配 dsh 桌面版 **0.2.2-rc.1**，并把「更新之后起不来」变成一条命令能修的事。

### 新增

- `scripts/repair-runtime.mjs`：自动修复更新后 `resources/runtime` 为空导致的启动 fatal。
  - 自动从注册表 `DisplayIcon` 定位安装目录，从 `app.asar` 的 `package.json` 读已装版本；
  - 校验升级缓存里安装包的版本与已装版本一致（不一致拒绝，除非 `--force`）；
  - 7z 抽出 `$PLUGINSDIRpp-64.7z` 里的 `resources/runtime/*` 回填，逐文件复制；
  - 结束前校验文件数、`office-skills\office\SKILL.md`、`runtime.json` 的 `desktopVersion`。
  - `--check` 只检测；已在 6144 文件的真实安装与空目录上各跑通一次。

### 适配

- `dshTarget` 由 `0.2.1-rc.5` 更新为 `0.2.2-rc.1`。
- 核对 0.2.2-rc.1 的插件面：`systemPrompt.section()`、严格插值、`agent/pre-step`
  （新增 `modelSelection`，向后兼容）、`session.deriveMessages` 均未变；
  `SECTION_ORDERS` 新增 `TOOL_APPLY_PATCH`(1350) / `TOOL_SCHEDULE`(2500)，最大值仍是
  `DEPLOYMENT_PERSONA_SUFFIX` 10200，尾锚 `1000000` 依旧排在最后；`CONTEXT_ORDERS` 未变。
- README 补充 `desktop update: task inspection timed out` 的成因与两种绕法。

### 说明

这一版没有改动破甲逻辑，只做兼容性与可维护性。宿主从 0.2.2 起安装后保持 asar 密封，
插件走纯运行时注入，不会再自动解包 `resources/app`。

---

## 2.0.4 — 2026-11-03

发版流程工程化。从这一版起，**测试通过即发布**：一条命令完成校验、测试、提版本、
提交、打标签、推送。

### 新增

- `tests/`：五套测试随仓库分发（deep-purge / identity / assemble / mount / rc5），
  共 72 个用例，`npm test` 一键跑完并汇总。
- `scripts/release.mjs`：一键发版。
  ```
  node scripts/release.mjs 2.0.5 "feat: 一句话说明"
  node scripts/release.mjs 2.0.5 "..." --dry-run   # 只检查
  ```
  内置闸门，任一条不满足直接拒绝：
  1. 版本号形如 `x.y.z` 且必须大于当前版本；
  2. `CHANGELOG.md` 必须先有 `## <版本>` 这一节（不允许"先发后补"）；
  3. 当前分支必须是 `main`，不能处于合并中；
  4. `npm test` 必须全绿；
  5. 打标签前确认 `v<版本>` 未被占用。
  推送失败时保留本地提交与标签，并打印补救命令，不会留下半成品。
- `package.json` 增加 `test` / `release` 两个脚本。

---

## 2.0.3 — 2026-11-02

适配 dsh 桌面版 **0.2.1-rc.5**（自动更新换掉宿主后重跑一次即可恢复）。

### 适配

- `dshTarget` 由 `0.2.0-rc.2` 更新为 `0.2.1-rc.5`。
- 新增 **contexts 通道出口清洗**。rc.5 把沙箱策略、审批策略、工作目录从 section
  拆成独立的 `context()` 通道（`sandbox:policy` / `approval:policy` /
  `working-directory:current`），它和 sections 一样受严格插值约束，
  出现未注册变量会让整轮渲染直接失败。现在两条通道都过 `sanitizePromptEntries`。
- 核对 rc.5 的排序模型：`SECTION_ORDERS` 改成命名槽位
  （`HARNESS_IDENTITY: -1000` … `DEPLOYMENT_PERSONA_SUFFIX: 10200`），
  但底层仍是数字比较。尾锚 `order = 1000000` 依然排在全部官方段之后，无需改动。
- 适配 0.2.1-rc.5 失效的 runtime：升级后 `resources/runtime` 可能为空目录，
  启动即 `ENOENT office-skills/office/SKILL.md`。用升级缓存里的同版本安装包
  解出 `resources/runtime` 回填即可（6150 个文件）。

### 说明

- rc.5 的安全/政策措辞主要走 contexts，`isSafetyOnlySection()` 在 sections 上
  命中率下降属于预期。策略文本描述的是**实际执行约束**，删掉不会改变沙箱行为，
  只会让模型误判可用操作，因此本版不默认剔除 policy context。
- 宿主 `app.asar` 更新后保持密封，插件只做运行时注入；不会自动解包
  `resources/app`，也不会改写 `resources/runtime`（10/26 写空 runtime 的路径不再触发）。

---

## 2.0.2 — 2026-10-27

### 修复

- **删除重复尾锚**：`index.js` 曾另外注册一份中文尾锚 `dsh-purge:tail`（`order = 900000`），
  与 `identity.js` 的 `dshpg-anchor`（`order = 1000000`）同时生效且措辞冲突。
  中文锚里写着「第一句以「可以，」或「行，」开头」，会强行把模型逼成固定套话开头——
  这是「回了两个 yes」的另一半根因。现在尾锚只有一处事实源。
- **`prefillMode` 兜底反向**：配置缺失时 `resolvePrefillMode` 落到 `"always"`，
  等于悄悄重新打开预填充。现在未配置即 `off`，且支持 `prefill: true` / 自定义字符串。
- **`enabled: false` 仍改写提示词**：总开关原先只清空注入正文，身份段 / 安全段 / 尾锚照删照加。
  现在关闭时直接原样返回宿主装配结果，不再碰 system。
- **安全段过滤几乎不触发**：上一轮收紧到「≥8 次命中 + 密度 1.0 + 段名命中」，
  而真实安全段实测只有 4 次命中 / 0.89 密度，功能等同失效。
  改为「先排除工具 / 工程标记 → 词根 ≥3 个不同 → 密度 ≥0.4 → 祈使句 ≥2 或命中 ≥6」。
- **身份段被整段清空**：原先命中身份自述就整段丢弃，连同一段里的工作目录、工具说明一起没了。
  现在只逐句剥离身份自述句，保留正文。
- **热重载后包装层叠加**：cleanup 只删标志、不还原宿主 `deriveMessages`，
  每次 reload 多包一层，日志与计数成倍增长。现在保存原始方法并在 dispose 时还原。
- **道歉被误判成拒绝**：以「抱歉，」开头就整条作废，「抱歉，我上一步路径写错了」也被抹掉。
  现在道歉式开头必须同时含拒绝语义才算 refusal。
- **身份句按小数点截断**：`dsh 0.2.1.` 被切成 `2.1.` 残句留在提示词里。
- 预填充遗迹前缀只剥一次（`Yes.Yes.` 剥成 `Yes.`）；改为支持多次叠加。
- 预填充关闭时的 400 / 422 不再误触发熔断。
- 预填充语言取样改用原始消息，`tailSteer` 不再把英文请求带成中文开头。
- `tailSteer` 改为追加到真实用户消息末尾，不再新增一条 user 消息顶替真实请求。
- `voidMessage` 保留 `toolCalls`，避免结构非法。

### 工程

- `fix-dsh-purge.mjs`：4 处恒真检测改为真实判据；去掉写死的本机路径，改按
  `DSH_HOME` / `APPDATA` / `ProgramFiles` 探测；新增「尾锚唯一」回归检测，共 28 项。
- 日志口径修正：`fullBytes` 等改真实字节数，`rawChars` / `outChars` 分开统计，
  去掉重复的 `tail` 键与恒为 `false` 的 `anchorApplied`。
- `derive` 日志按签名去重，`voidedIds` 加上限，避免长会话内存增长。
- 移除 `screenshots.json` 及其死配置，`update.js` 的复制名单同步。

---

## 2.0.1 — 2026-10-27

### 修复

- 关闭消息层两项污染：`prefillMode` 与 `tailSteer` 默认改为关闭。
  预填充会被宿主并进真实回复并持久化，模型下一轮误判「被截断」，表现为
  「做一步说一步」与 `Yes.Yes.` 重复开头。
- 新增 `stripPrefillArtifacts`：清理历史消息里已写入的 `可以，` / `Yes.` 前缀。
- 预填充加双重护栏：末条已是 assistant、或末条已含前缀时不追加。
- `fix-dsh-purge.mjs` 的开关检测改为匹配 `prefillMode`，不再匹配旧键名。

---

## 2.0.0 — 2026-10-26

首个深度分支版本，基于上游 `YuJunZhiXue/dsh-purge` v1.1.71（MIT）。

### 适配 dsh 桌面版 0.2.1-rc.3

- 移除对 `{{cwd}}` 变量的引用（新版只注册 `provider` / `model`），否则整轮组装直接失败。
- 同步 `profiles/desktop` 的 `cordis.patch.yml`，去掉残留的 `personaSuffix`。
- 包名保持 `dsh-purge`，`dsh.profile.bundles` 才能正确加载。

### 深度破甲层

- 新增 `lib/deep-purge.js`，包装 `session.deriveMessages`，依次做：
  历史拒绝清洗 → 尾部棘轮 → 预填充（后两项默认关）。
- 新增 `dshpg-anchor` 尾锚段（`order = 1000000`），在 system 末尾再压一次核心契约。
- 新增 `isSafetyOnlySection()`，按词根密度整段下线纯约束段，替代上游约 30 条逐句正则。
- 身份段清洗：剥离官方身份自述，保留工具与环境说明。
- 宿主源码级补丁：点击「应用」后写入 `resources/app`，覆盖 asar 内的装配逻辑。

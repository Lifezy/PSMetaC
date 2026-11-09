# 单文件报告

## 保存位置

- 权威报告：`<dataRoot>\reports\<jobId>\report.json` 和 `report.html`
- 成品或隔离副本旁：`<file>.report.json` 和 `<file>.report.html`
- 逐步骤日志：`<dataRoot>\logs\jobs\<jobId>.events.jsonl`
- Photoshop 细节：权威报告目录下的 `artifacts\photoshop.log`

跳过或预检阻止时没有成品，报告只保存在权威目录。

## 主要字段

| 区域 | 内容 |
|---|---|
| `source` | 路径、前后大小/时间/SHA-256、是否未变 |
| `policy` | 策略、具体门槛、决定原因、任务、输出模式和必须通过的验收项 |
| `environment` | 机器编号、Windows、Node、Photoshop 路径和版本 |
| `preflight` | 容器、嵌入对象、XMP、DocumentAncestors、计划数量 |
| `execution` | 是否启动 Photoshop、详细日志位置，以及可选图层整理的请求、删除与跳过记录 |
| `validation` | 结构拓扑、资产 ID 变化、严格 ID、失败项、像素指标和错误代码 |
| `output` | 成品/隔离路径、处理前后体积、变化字节、变化百分比和 XMP 清理量 |
| `timing` | 排队、预检、等待 Photoshop、处理校对和总历时 |
| `logs` | 事件与 Photoshop 日志位置 |

JSON 是机器可读的权威数据，HTML 只是同一数据的可阅读展示。

当任务启用隐藏/空图层整理时，`execution.contentCleanup` 记录：

- `requested.hidden` / `requested.empty`：本任务明确选择的规则；
- `deletedHidden` / `deletedEmpty`：删除前的图层路径、名称、类型、ID、原因和子树数量；
- `skippedHidden` / `skippedEmpty`：无法安全删除的项目及原因；
- `deletedCount`：本次实际删除的顶层候选数。隐藏组的子层数量另由 `subtreeLayers` 记录。

只要 `deletedCount > 0`，安全副本就进入人工复核；这属于用户要求的结构变化，不能按
“结构与原件完全一致”自动通过。

直存报告会在 `execution.mode` 记录 `in_place`，并写入
`sourceOverwritten`、`backupRequested` 和 `backupPath`。它的
`validation.performed` 必须为 `false`；XMP 清理量、结构和像素字段显示为
“未校对”，不能用零或通过代替未知结果。

## 成功判定

安全副本模式默认要求以下项目同时满足：

- 源文件前后大小、修改时间和 SHA-256 一致；
- Photoshop 报告完成；
- 清理计划覆盖完整；
- 智能对象失败为零；
- 严格 ID 模式没有名称回退或缺少直接 ID；
- 保存后的结构和图层状态一致；
- 智能对象资产 ID 没有被重新生成；
- 解析警告为零；
- `DocumentAncestors` 为零；
- Photoshop 处理前与处理后预览逐像素完全一致。

“保存后能重新打开”和“保存与重开画面一致”仍可由用户勾选为严格验收项，但默认不再
为了它们额外关闭并重新打开大型 Photoshop 文件。这样减少最后一个智能对象完成后的
长时间等待。报告会明确区分“未选择该检查”和“检查失败”，不会把未执行显示为通过。

计划覆盖另有 `strict`、`threshold` 和 `skip` 三种策略。无论策略如何，报告都记录
计划目标、实际覆盖、遗漏数量和遗漏比例；容差只决定是否自动放行，不代表遗漏对象已
清理。

用户可以在具体任务中取消部分“必须通过”勾选。取消后该检查仍执行，失败项继续
出现在 `validation.errors`，但不会进入 `validation.blockingErrors`；报告会明确
显示“通过你选择的验收标准”，而不会冒充全部检查通过。源文件变化和 Photoshop
未完成等基础安全错误始终阻止发布。

直存模式使用 `succeeded + IN_PLACE_SAVED_UNVALIDATED` 表示 Photoshop 已完成
用户明确要求的原位保存，但它不代表上述严格验证通过。HTML 报告会显示
“直存完成（未校对）”，避免与安全副本成品混淆。

个别目标无法处理但已保存其他完成项时，使用“部分完成、未校对”结果和对应原因代码。
这能避免数小时已完成工作全部丢失，但绝不等于全部目标完成；报告必须列出失败对象、
计划覆盖和备份位置。

`validation.structure` 会区分：

- `topologyMatch`：容器、层级、尺寸、位深、颜色模式和智能对象记录拓扑；
- `assetIdsMatch`：嵌入智能对象资产 ID 是否保持不变；
- `assetIdChanges`：按记录路径列出前后 ID。

拓扑一致但资产 ID 变化的错误代码为
`SMART_OBJECT_ASSET_IDS_CHANGED`。严格默认值会因此进入人工复核；只有用户明确
取消“智能对象资产 ID 一致”这一必须项时，它才会作为警告发布。

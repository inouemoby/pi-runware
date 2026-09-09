# Runware

使用 `runware_infer` 调用 Runware 的统一任务 API，使用 `runware_models` 搜索、筛选和确认模型。Runware Provider 仅用于 `/login runware` 保存 API Key，不提供 Pi 聊天模型，也没有插件命令。

## `runware_infer`

用于任何 Runware 模型、AIR 标识符和任务类型。插件不根据模型能力过滤、修改或拒绝输入字段。

### 直接任务字段

- `model`：任意 Runware 模型标识符或 AIR 标识符。
- `taskType`：任意 Runware 任务类型。
- `prompt`：便捷的正向提示词字段。
- `task`：单个原始任务对象。
- `tasks`：原始任务对象数组。
- `input`：合并到任务顶层的任意字段。

`task`、`tasks` 与 `input` 用于模型专有参数、任意模态输入、设置对象、任务配置和未来 API 字段。

### 内容输入

`content` 是自由内容块数组。每个块包含：

- `type`：自由类型标签。
- `field`：可选目标字段路径，支持点路径。
- `value`：任意 JSON 值。
- `text`：文本内容。
- `source`：HTTP(S) URL、数据 URI、Runware UUID 或本地文件路径。
- `mimeType`：可选 MIME 类型。
- `role`：目标为消息数组时的可选角色。

带 `field` 的内容块会追加到对应任务字段；未带 `field` 的内容块保留在任务的 `content` 数组中。本地文件会转换为数据 URI；URL、数据 URI 和 Runware UUID 原样发送。

### 执行与输出

- `deliveryMethod`：Runware 交付方式。
- `waitForCompletion`：是否轮询异步任务。
- `pollIntervalMs`：轮询间隔。
- `maxWaitSeconds`：异步等待上限。
- `timeoutSeconds`：单次 HTTP 请求超时。
- `includeCost`：是否请求单任务成本。
- `outputDir`：可选输出下载目录；未指定时不写入本地文件。
- `embedOutputImages`：是否将小型图片输出附加到 Pi 工具内容。
- `maxEmbeddedImageBytes`：单张附加图片的大小上限。

工具结果包含任务 UUID、输出 URL、可选已保存路径、Runware 数据、错误和成本信息。

## `runware_models`

使用 Runware 的 `modelSearch` 任务筛选和确认社区或组织可见的 AIR 模型。

- `action`：`search` 或 `inspect`。
- `query`：模型查询词。
- `model`：用于确认的模型或 AIR 标识符。
- `source`、`category`、`architecture`、`capabilities`、`visibility`：筛选字段。
- `limit`、`offset`、`sort`：分页和排序字段。
- `filters`：任意额外 Model Search 字段。
- `includeRaw`：是否返回完整原始模型记录。

结果包含 AIR 标识符、名称、类别、架构、能力、来源、可见性、简介和原始响应信息。

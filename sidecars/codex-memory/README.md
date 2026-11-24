# Codex Local Memory

在本机保存指定的 Codex 聊天，并通过 MCP 跨聊天检索、核对原话和恢复项目进度。使用 Node.js 的内置 SQLite 与 zstd 读取日志，使用 Python 在本机建立话题和关联索引。

## 快速开始

需要 Node.js 26、Python 3.14、uv 和 Codex CLI。从仓库根目录运行下列 PowerShell 命令。数据目录应和源码仓库分开放置。

```powershell
$sidecar = (Resolve-Path './sidecars/codex-memory').Path
$memoryRoot = Join-Path $env:LOCALAPPDATA 'CodexMemory'
Set-Location $sidecar
npm ci --ignore-scripts
uv venv --python 3.14 .venv
uv pip sync --python .venv/Scripts/python.exe requirements.lock.txt
New-Item -ItemType Directory -Path $memoryRoot -Force | Out-Null
$configFile = Join-Path $memoryRoot 'config.json'
if (!(Test-Path -LiteralPath $configFile)) {
    Copy-Item -LiteralPath './config.example.json' -Destination $configFile
}
```

在新配置中设置 `sourceDirectories`，常见来源是用户目录下的 `.codex/sessions` 和 `.codex/archived_sessions`。把要导入的历史聊天编号加入 `threadIds`。如果需要持续保存以后新建的聊天，设置 `captureNewChats` 和相应的 `captureSince`。示例配置的采集范围为空。

```powershell
codex mcp add codex-memory -- node (Join-Path $sidecar 'server.mjs') $memoryRoot
node (Join-Path $sidecar 'cli.mjs') watch $memoryRoot
```

重新打开 Codex 后可发现 MCP 工具。停止采集后可再次运行 `watch`，断点保存在数据库。设置好本机模型程序和权重后可启用 `semantic`。配置 `backup.directory` 可以启用异盘备份。

可选配置项如下。相对的模型路径以记忆数据目录为基准。

| 配置项 | 示例或说明 |
| --- | --- |
| `semantic.executable` | 本机 llama.cpp 的 `llama-server.exe` 路径 |
| `semantic.weights` | `Qwen3-Embedding-0.6B-Q8_0.gguf` 权重路径 |
| `backup.directory` | 异盘备份目录的绝对路径 |
| `sharedThreadIds` | 允许跨项目检索的聊天编号。聊天仍应符合采集范围 |

## 命令行

| 命令 | 功能 |
| --- | --- |
| `scan` | 扫描一轮并更新状态 |
| `watch` | 每隔配置的秒数持续扫描 |
| `status` | 查看最近一次扫描的结果 |
| `export` | 从数据库重建全部 Markdown 原文 |
| `backup` | 立即创建独立本机数据库快照并检查完整性 |
| `backup-external` | 立即创建一份异盘快照 |

`verify-backup <快照目录>` 核对清单、数据库与配置的 SHA-256，以及 SQLite 完整性和外键。`restore-backup <快照目录> <新目录>` 将数据库恢复到一个尚未创建的目录。新目录使用快照的共同记忆范围，初始关闭日志采集。

## 保存内容

`data/conversations.sqlite3` 是原文库，保存用户消息和助手最终回复，保留角色、原始时间、聊天编号、来源文件、字节位置、消息编号和文本哈希。消息内的附件保存类型和可用名称。

`exports/<聊天编号>.md` 便于直接阅读。导出失败后可以从数据库重建。原文中的说法保留为当时的发言，引用与预测的真实性需要单独核实。

`status.json` 记录最后一轮扫描的时间、文件数、新增消息数、累计消息数、未完整日志数及错误。`heartbeat.json` 记录后台进程的最近一次成功运行时间。`backups/` 保存每天首次扫描后的数据库快照。

## 正确性和恢复

消息按聊天编号和来源消息编号去重。没有消息编号时使用原始 ordinal 或字节位置。同样文字的不同消息分别保存。采集消息和推进来源断点在同一个数据库事务里提交，坏行和消息冲突会回滚这一批。文本只有在整行换行后才解析，支持中文多字节边界。来源变短或检查点附近内容发生变化时重新读取，已保存的消息仍按编号去重。压缩为 `.jsonl.zst` 后可继续读取。

本机 Codex 日志格式属于适配依赖。无法识别的消息阶段、文本结构和记录会进入错误状态，并保留上次成功断点。检查 `status.json` 和 `logs/collector-errors.log` 可发现采集故障。

配置保存在记忆数据目录的 `config.json`。

## 验证

运行 `node --test sidecars/codex-memory/test.mjs`。测试使用独立临时目录，验证重复采集、中文半行、回滚、内容冲突、压缩迁移、范围选择、重开与导出恢复以及备份回读。

## Codex MCP 接入

`server.mjs` 通过 stdio 提供本地 MCP 服务。依赖使用本目录的 `package.json` 和锁文件安装，运行 `npm ci --ignore-scripts` 可以复现依赖。服务与采集器共用 SQLite，新增消息经数据库触发器同步进入 FTS5 索引。

| 工具 | 用途 |
| --- | --- |
| `memory_bootstrap` | 新聊天优先读取核心记忆，再按可提取度选择有效记忆，最多八条 |
| `memory_search` | 中文关键词与短语检索，可限定项目、日期、说话者及聊天 |
| `memory_topics` | 搜索原文摘句生成的话题摘要及概念共现关系，可按项目和聊天限定 |
| `memory_context` | 按消息编号展开前后文，长消息标记截断 |
| `memory_resume` | 找回续接点，包括最近原话、相关决定和未完话题 |
| `memory_notes` | 查看记忆和来源，可包含修订历史 |
| `memory_remember` | 带来源写入、幂等重试，以及保留旧版本的修订 |
| `memory_archive_note` | 将条目归档，历史可查 |
| `memory_associate` | 调用上游实体关联函数，带出新的相关话题及共同关键词 |
| `memory_review` | 确认使用记忆后更新复习记录，持久化一小时冷却 |
| `memory_set_core` | 设置或取消核心记忆标记 |
| `memory_artifact_save` | 按用户要求保存项目产物的文件版本和原文依据 |
| `memory_artifact_list` | 按项目、名称和说明查找已保存的版本 |
| `memory_artifact_restore` | 校验旧版内容并恢复到项目内新的文件路径 |
| `memory_status` | 检查后台心跳、采集错误与实时数量 |

`config.json` 的 `sharedThreadIds` 显式指定可以跨项目读取的共同聊天。其他聊天根据原始工作目录与请求的 `project_path` 匹配。跨项目的用户交流偏好和共同经历可写为 `shared`，项目决定写为 `project`。用户相关陈述和偏好需要用户发言作为来源。写入工具按 `operation_id` 去重，修订通过 `supersedes` 关联旧条目，所有写入在事务中提交。

关键词通道使用 SQLite FTS5 的 trigram 索引，配合中文分词、两字子串与显式关键词。默认将关键词结果和本地向量结果按名次合并。可用 `mode=keyword` 单独查询关键词。

完整验证运行 `npm test`，包含原文采集、MCP 握手、工具发现、检索、项目隔离、上下文、来源校验、修订、幂等与恢复测试。测试使用独立的模拟会话。

如需在新聊天启动时读取记忆，可在 Codex 项目指引中约定调用 `memory_bootstrap`，并在引用过往发言时用 `memory_context` 核对。

## 直接复用上游记忆机制

`lifecycle.mjs` 直接导入仓库 `src/memory-decay.js` 的 `retrievability`、`initialStability`、`initialDifficulty`、`ltmUnitMeta`、`nextStability` 和 `nextDifficulty`。复习状态写入同一 SQLite 数据库，采用事务更新，支持多个 MCP 进程同时使用。普通条目的可提取度低于 0.5 时淡出启动摘要，核心条目及有效的未完话题豁免。显式原文检索覆盖全部已采集消息。复习有一小时冷却，列表查询和启动摘要读取保持只读。

`association.py` 直接导入并调用上游 `sidecars/memory-rag/memory_rag/recall.py` 的 `associate()`。适配器将当前可见的记忆条目提供为摘要和实体视图，上游负责关联排序、带出新实体及排除高重叠复述。Node 调用前过滤项目范围，返回后再次核对条目仍然有效。实体当前由本地分词提取，`via` 列出共同关键词。默认允许当天记忆参与关联，`min_age_days` 可调整。

Python 环境位于本目录 `.venv`。可用 `uv venv --python 3.14 .venv` 及 `uv pip sync --python .venv/Scripts/python.exe requirements.lock.txt` 重建。Python 只处理本机提供的可见记忆快照。自动检索在关联服务不可用时继续返回原文命中，并附 `association_error`。

可提取度 R 描述自动检索排序，记忆内容的事实依据来自原话和独立核对。

## 异盘备份与恢复

采集器按 `backup.directory` 保存异盘快照。启动时检查，此后在与最近一份快照相隔至少六小时后生成。已发布的快照含 SQLite 一致性副本、恢复所需配置及完整性清单。创建结果写入 `backup-status.json`，也可通过 `memory_status` 查看。

使用同版本源码运行 `node cli.mjs restore-backup <快照目录> <新目录>`。在新目录运行 `export` 可重建可读原文，运行 `rebuild-topics` 可重建话题索引。使用 `server.mjs <新目录>` 可查询恢复的数据。如需恢复采集和语义索引，在新数据目录配置日志范围、异盘备份位置和本机模型后运行 `watch`。

## 本地向量检索

0.4.0 通过原仓库的 `LlamaCppEmbedder` 调用本机 Qwen3-Embedding-0.6B Q8_0。采集器管理向量进程，模型服务使用 CPU、四个线程和随机回环端口。模型及程序存放在 `runtime/`，启动路径在根目录的 `config.json` 的 `semantic` 段配置。输入文本仅经本机回环地址发送给模型。

`data/semantic.sqlite3` 保存聊天消息片段的派生向量。新消息通过原文编号和内容哈希补建索引。查询沿用原仓库的 RRF 算法合并关键词和向量名次，在比较向量前按项目、聊天、说话者和时间范围过滤，并通过消息编号回读原文。输出的 `routes` 标明命中通道，`cosine` 表示向量相似度。

`memory_status` 提供语义索引的状态和覆盖数量。模型加载、初次索引或服务离线时可继续查询原文。向量库是派生数据，可从原文和本地模型重新生成。Windows 上可运行 `.venv/Scripts/python.exe -m unittest -v semantic_test` 检查增量索引、分块和范围筛选。

## 自动话题摘要和关系索引

从 0.6.0 起，采集器按会话更新 `data/topics.sqlite3`。每次用户发言和紧随其后的回复形成一个话题段。摘要选取原句，标注说话者、时间、消息编号和原文字符位置。概念共现关系附有支持它的原文编号，表示两个词在同一摘句里出现。生成过程在本机进行，独立于向量模型。

索引复用上游 L2 表、中文分词、关系图评分及 RRF。普通 `memory_search` 会附带 `related_topics`，原文结果仍按原先的关键词和向量排序返回。指定说话者、日期或关键词模式时，查询保留原有原文筛选行为。`memory_topics` 可直接查摘要及关系，省略查询词时返回最近的话题。摘要和关系与原文使用同一项目可见范围，引用时用 `memory_context` 核对。

`memory_status` 的 `topics` 项报告覆盖范围和总数。恢复快照后可运行 `node cli.mjs rebuild-topics <记忆目录>` 将话题索引从原文重建，也可以等待采集器首次启动时重建。摘要库与向量库都是派生数据，快照保存原文库和已确认记忆。

## 续接记录、助手观察和产物版本

采集器导入原文时，在同一事务中为该聊天保存近八条消息的续接点。旧聊天的续接点在首次扫描时回补。用 `memory_resume` 可以按聊天查原文摘句以及该聊天相关的当前有效决定和未完话题。压缩前也可以用 Codex 的 `PreCompact` 调用下面的命令，在库里保留一份独立的压缩前续接点。命令读取已经入库的原文。Codex 需要由用户信任新增钩子后才会自动调用它。

```json
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/example/codex-local-memory/sidecars/codex-memory/cli.mjs\" precompact-hook \"C:/example/codex-memory-data\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

`memory_remember` 支持 `self_observation`，适合保存助手对自己实际协作行为的观察。至少引用一条助手原话，可用 `supersedes` 修订。新聊天启动时最多返回两条可见观察，放在 `self_observations`。记录保留为当时的判断。

用户明确指定的项目文件可以用 `memory_artifact_save` 归档，单件上限 16 MiB。提供本项目原文编号作为依据；同一路径内容有改动时生成新版本。输入和恢复路径会校验实际位置，跨目录链接无法越过项目边界。旧版取回前验证 SHA-256，恢复会创建新文件。文件字节、续接记录和观察都随 SQLite 快照备份。

如果原项目目录在恢复后不可用，可以按旧项目路径查找版本编号，再用恢复包的 CLI 把指定版本取回到新记忆目录下的 `recovered-artifacts`。

```powershell
node cli.mjs recover-artifact '<恢复后的记忆目录>' '<原项目绝对路径>' '<产物编号>' '<恢复文件名>'
```

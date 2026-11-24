# Codex Local Memory

为 Codex 提供本地长期记忆的 MCP 服务。它采集用户选择的聊天，保留原话和来源，并在新聊天中找回相关讨论、项目进度和交付物版本。

## 功能

- **聊天存档与检索**。保存用户发言和助手最终回复，支持关键词、可选的本地语义检索，以及按项目读取前后文。
- **话题与长期记忆**。从原文生成可追溯的摘句摘要和概念共现关系。长期记忆支持来源、修订历史、核心标记和 FSRS 复习。
- **项目续接和产物版本**。采集时保存续接点，归档指定文件并以 SHA-256 校验恢复。
- **备份**。SQLite 一致性快照支持异盘保存、验证和恢复；话题与向量索引可重建。

## 使用

已在 Windows 上验证。需要 Node.js 26、Python 3.14、uv 和 Codex CLI。配置示例的采集范围为空，初次使用时由你选择要导入的聊天和项目范围。配置文件、聊天数据库、模型权重和备份存放在独立的本机数据目录。

- [安装、配置、MCP 工具与恢复命令](sidecars/codex-memory/README.md)
- [示例配置](sidecars/codex-memory/config.example.json)
- [更新记录](sidecars/codex-memory/CHANGELOG.md)

## 来源与许可

记忆算法复用自 [dsh-memory-brain](https://github.com/y083245/dsh-memory-brain/tree/636c9334d45d292e6333807bbc5f66427c83c15d)。许可和上游归属见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。

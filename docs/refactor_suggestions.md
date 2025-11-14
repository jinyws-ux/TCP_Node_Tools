# 减重与重构建议

下列建议聚焦于当前项目中最容易引起「代码臃肿」和「难以维护」的区域。每条建议都对应仓库里的具体文件/函数，并说明拆分思路和可以立刻着手的步骤。

## 1. 把桌面壳与 Flask 服务分层（`app.py` 与 `web/server.py`）
- 目前 `app.py` 负责创建配置目录、写入 Flask `app.config` 并在同一个进程里拉起桌面 webview；同时，`web/server.py` 在模块导入阶段就初始化 `ConfigManager`、`LogAnalyzer` 等重量级对象，还硬编码了 `configs/`、`downloads/` 等路径。【F:app.py†L1-L48】【F:web/server.py†L1-L98】
- **问题**：任何一处改动（例如想把后端改成 CLI）都要同时编辑两个文件；而当 Flask 作为独立进程运行时，桌面壳里的目录准备逻辑会被重复执行。
- **做法**：
  1. 在 `web/` 下新增 `bootstrap.py`，专门负责「解析环境变量 → 计算数据目录 → 初始化 ConfigManager/LogAnalyzer/Downloader」。
  2. `web/server.py` 只保留 Flask 蓝图和路由函数，在 `create_app()` 里接收注入的依赖；`app.py` 只需 `from web.bootstrap import create_app` 并传入目录。
  3. 桌面壳用 `subprocess` 或 `threading` 启动 Flask 时只关心 URL，未来若要发布纯 Web 服务，可直接运行 `python -m web.bootstrap`。

## 2. 给日志下载逻辑引入「命令构造 + 解析器」层（`core/log_downloader.py`）
- `LogDownloader` 里 `_search_realtime_for_nodes` 与 `_search_archive_for_nodes` 都在循环里拼装 shell 命令、解析 `ls -l` 输出并拼接 `remote_path`，上层 `search_logs/search_logs_many_nodes/search_logs_strict` 又存在语义重复，只是组合方式不同。【F:core/log_downloader.py†L12-L150】
- **问题**：每新增一种日志源（例如 NFS 历史目录）都得复制粘贴一组命令 + 解析；而 `_normalize_nodes`、去重逻辑散落在各函数里，导致 bug（如忘记 `visited`）时需要在三处修复。
- **做法**：
  1. 提炼 `LsEntry = TypedDict("LsEntry", {"remote_path": str, ...})`，再写一个 `_parse_ls_output(base_path, lines, node)` 专门负责拆分 size/mtime/文件名。
  2. 给不同来源写「命令构造器」，例如 `_build_realtime_command(base_path, node)` 与 `_build_archive_command(base_path, node, date_range)` 只返回字符串，真正的 SSH 执行和输出解析由统一函数 `_run_ls_for_nodes(builder)` 完成。
  3. `search_logs`/`search_logs_many_nodes` 只负责「组织 builder」「合并结果」「排序」，语义差异可以通过参数表达而不是新函数。

## 3. 把日志解析流程拆成「提取 → 匹配 → 渲染」三步（`core/log_parser.py`）
- `parse_log_lines` 当前在一个 while 循环里同时：定位行、判断格式、解析字段、拼字符串；`parse_message_content` 也把「字段切片」「版本选择」「转义展示」写在一起。【F:core/log_parser.py†L1-L140】
- **问题**：一旦想支持新的日志格式，必须在 `parse_log_lines` 的 if/else 中加分支；字段配置缺乏校验（`Start`/`Length` 错误时只有运行时报错）。
- **做法**：
  1. 把模式匹配抽象成生成器，例如 `_iter_direction_entries(lines)` 负责把原始行转换为 `ParsedLine`（含 timestamp / direction / payload）；`parse_log_lines` 只迭代这些结构体并调用后续处理。
  2. 将 `parse_message_content` 分裂为两步：`resolve_fields(msg_type, version)` 返回字段定义 + 校验报告，`render_fields(field_defs, content)` 执行切片。这样便于在命令行或单测里单独验证配置是否完整。
  3. 在渲染结果中附带「原始长度不足」「未知转义键」等状态码，前端即可根据状态提示用户哪些配置需要清理。

## 4. 拆出配置/报告仓库，减少 Flask 模块负担（`web/server.py` + `core/config_manager.py`）
- `web/server.py` 直接读写 `configs/server_configs.json`、`report_mappings.json`，`build_config_tree`、`calculate_config_stats` 等函数与 Flask 强耦合，导致前端每调用一次 API 都会重新遍历整个配置树。【F:web/server.py†L40-L174】
- **问题**：配置/报告相关逻辑缺乏统一接口，难以写脚本批量修复无效配置；并且在模块导入时全局初始化 `ConfigManager`，阻碍测试。
- **做法**：
  1. 在 `core/` 下新建 `config_repository.py`，包装所有「读/写 JSON + 校验」操作；`ConfigManager` 专心暴露 CRUD，Flask 层通过依赖注入获得实例。
  2. 报告映射写成一个小型仓库（可替换为 SQLite/轻量 KV），并提供 `get_for_logs(log_ids)`、`save(log_id, report_path)` 等方法，避免直接操作文件路径。
  3. `build_config_tree`、`calculate_config_stats` 放入独立的纯数据模块（例如新增 `core/config_tree.py`），并接受 `ConfigSnapshot` 作为输入，这样前端或 CLI 都能重用。

## 5. 给分析阶段增加可观测性与“按需执行”能力（`core/log_analyzer.py`）
- `LogAnalyzer.analyze_logs` 会在单个函数里完成「读取下载结果 → 调用 LogParser → 渲染报告 → 写 HTML/文本」，且没有任何阶段性指标；失败时只返回 `False`，用户无法定位耗时步骤。【F:core/log_analyzer.py†L1-L200】
- **做法**：
  1. 抽象 `AnalysisPipeline`，在每个阶段记录 `start/end` 时间与输入输出数量，写入同目录的 `analysis_stats.json`。
  2. 允许调用方通过参数关闭某些阶段（例如只做结构化解析、不生成 HTML）；前端可根据用户勾选来减少工作量。
  3. 将 HTML 渲染模板化：把当前硬编码字符串搬到 `web/templates`，并把不同输出通道（HTML/纯文本/JSON）用策略模式管理，这样才能安全删除未使用的格式。

---

这些步骤不要求一次完成，可以按模块逐步拆分。只要先建立“依赖注入 + 模块化”的骨架，后续的减重就能在不影响用户功能的前提下持续推进。

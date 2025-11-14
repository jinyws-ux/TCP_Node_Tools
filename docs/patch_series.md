# 补丁系列一览

> 方便你逐个应用或回滚，本表列出了当前为止四个模块的主要补丁及其触达文件。

## 01-download-tab.patch
- **目标**：合并旧版“实时/归档/模板”三个搜索入口，交给 `DownloadService` 做参数校验。
- **关键文件**：`core/download_service.py`、`web/server.py` 中 `/api/logs/*`、`web/static/js/modules/download.js`、`web/static/js/core/api.js`。

## 02-analyze-tab.patch
- **目标**：拆出 `AnalysisService` 与 `ReportMappingStore`，让 `/api/analyze` 只负责调度；前端增加阶段耗时卡片。
- **关键文件**：`core/analysis_service.py`、`core/log_analyzer.py`、`web/server.py`（分析相关路由）、`web/static/js/modules/analyze.js`、`web/static/css/style.css`。

## 03-server-config-tab.patch
- **目标**：把服务器配置的增删改查集中到 `ServerConfigService`，联动模板更新/删除；前端列表、表单与消息提示重新整理。
- **关键文件**：`core/server_config_service.py`、`web/server.py` 中 `/api/server-configs` 系列路由、`web/static/js/core/api.js`、`web/static/js/modules/server-config.js`。

## 04-parser-config-tab.patch
- **目标**：提炼 `ParserConfigService` 负责树、统计、搜索与校验；前端统一走 `api` 模块，避免散落的 `fetch`/URL 拼接。
- **关键文件**：`core/parser_config_service.py`、`web/server.py`（解析配置相关路由）、`web/static/js/core/api.js`、`web/static/js/modules/parser-config.js`。

> 后续如果继续拆分其他子模块，可以延续此命名方式（05-xxx.patch），保持顺序即可。

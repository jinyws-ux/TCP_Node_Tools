# 日志分析系统（嵌入式客户端 + 网页模式）

## 概述
- 本项目提供嵌入式桌面客户端（基于 PyQt6 + pywebview）与网页模式两种使用方式。
- 功能模块：日志下载、日志分析、服务器配置、解析配置、网页/客户端切换与后台退出。
- 支持通过 `paths.json` 将配置、下载、报告目录指向 NAS 路径，发布后无需重新打包即可调整。

## 目录结构（核心）
- `app.py`：嵌入式客户端入口（创建窗口、初始化托盘/网页模式、读取路径配置）
- `web/server.py`：Flask 后端（API 路由、静态资源与模板、业务服务绑定）
- `core/`：核心业务（下载器、分析器、配置管理等）
- `web/templates/index.html`：前端页面模板
- `web/static/`：前端样式与脚本
- `paths.json`：外部路径配置（可改为 NAS）

## 运行环境
- Windows 10/11 x64
- Python 3.12（推荐），依赖：
  - Flask、pywebview、PyQt6、PyQt6-WebEngine、qtpy、paramiko、pyinstaller

安装依赖：
```
py -3.12 -m pip install --upgrade pip
py -3.12 -m pip install flask pywebview PyQt6 PyQt6-WebEngine qtpy paramiko pyinstaller
```

## 启动方式
- 嵌入式客户端（默认）：
```
py -3.12 app.py
```
- 仅后端（开发调试）：
```
py -3.12 -m web.server
```

## 路径配置（paths.json）
- 文件位置：与可执行文件同目录（开发环境在项目根目录，打包后在 `dist/LogTool/`）
- 示例（本地目录）：
```
{
  "CONFIG_DIR": "configs",
  "PARSER_CONFIGS_DIR": "configs/parser_configs",
  "REGION_TEMPLATES_DIR": "configs/region_templates",
  "MAPPING_CONFIG_DIR": "configs/mappingconfig",
  "DOWNLOAD_DIR": "downloads",
  "HTML_LOGS_DIR": "html_logs",
  "REPORT_MAPPING_FILE": ""
}
```
- 示例（NAS 目录）：
```
{
  "CONFIG_DIR": "\\\\nas-server\\share\\LogToolData\\configs",
  "PARSER_CONFIGS_DIR": "\\\\nas-server\\share\\LogToolData\\configs\\parser_configs",
  "REGION_TEMPLATES_DIR": "\\\\nas-server\\share\\LogToolData\\configs\\region_templates",
  "MAPPING_CONFIG_DIR": "\\\\nas-server\\share\\LogToolData\\configs\\mappingconfig",
  "DOWNLOAD_DIR": "\\\\nas-server\\share\\LogToolData\\downloads",
  "HTML_LOGS_DIR": "\\\\nas-server\\share\\LogToolData\\html_logs",
  "REPORT_MAPPING_FILE": "\\\\nas-server\\share\\LogToolData\\html_logs\\report_mappings.json"
}
```
- 说明：绝对路径（含 UNC）优先；留空 `REPORT_MAPPING_FILE` 则默认使用 `HTML_LOGS_DIR/report_mappings.json`。

## 打包命令（PyInstaller）
- 一目录模式（推荐分发）：
```
pyinstaller --onedir --hidden-import=platform --hidden-import=socket --hidden-import=ssl --hidden-import=flask --hidden-import=core.analysis_service --hidden-import=core.config_manager --hidden-import=core.download_service --hidden-import=core.log_analyzer --hidden-import=core.log_downloader --hidden-import=core.log_metadata_store --hidden-import=core.log_parser --hidden-import=core.parser_config_manager --hidden-import=core.parser_config_service --hidden-import=core.report_generator --hidden-import=core.report_mapping_store --hidden-import=core.server_config_service --hidden-import=core.template_manager --add-data "web:web" --add-data "configs:configs" --add-data "paths.json:." app.py
```
- 依赖说明：已安装 `PyQt6-WebEngine` 与 `qtpy`，pywebview 会自动选择 Qt 后端；无需 .NET。
- 分发：压缩并分发 `dist/LogTool/` 整个目录，不要只发单个 `exe`。

## 使用说明
- 嵌入式客户端（窗口 URL 带 `?embedded=1`）：
  - 右上角显示“网页模式”按钮：点击→确认→打开浏览器并隐藏客户端。
- 网页模式：
  - 右上角显示“切回客户端模式”“退出后台”按钮，均有确认弹窗。
  - 切回客户端：显示嵌入式窗口，并尝试关闭当前浏览器页（仅当前标签）。
  - 退出后台：优雅停止服务，并尝试关闭当前浏览器页。
- 日志下载：选择厂区/系统，填写节点（必填），可选归档日期范围→搜索→勾选→下载。
- 日志分析：选择已下载日志与解析配置→开始分析→生成报告。
- 服务器配置与解析配置：在对应页面管理；配置文件保存在 `paths.json` 指定目录。

## 常见问题
- 托盘不可见：当前实现以网页控制面板替代托盘；无需托盘即可切回/退出后台。
- 资源 304：浏览器缓存命中，正常行为。
- 端口占用：如有其它程序占用 `5000`，请关闭占用进程或更换端口。
- NAS 权限：确保目标 UNC 路径对用户可读写；失败时检查权限与连通性。

## 提交建议
- 已移除本地构建产物：`dist/LogTool/`、`build/LogTool/`，避免将打包结果提交。
- 建议保留的核心目录与文件：`app.py`、`paths.json`、`web/`、`core/`。
- 如需忽略更多本地文件，可在 VCS 中添加忽略规则（例如 `dist/`、`build/`）。
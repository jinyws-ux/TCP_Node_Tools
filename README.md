# 日志分析系统（纯网页模式）

## 概述
- 本项目提供纯网页模式，启动时自动打开浏览器访问，无需桌面客户端。
- 功能模块：日志下载、日志分析、服务器配置、解析配置。
- 支持通过 `paths.json` 将配置、下载、报告目录指向 NAS 路径，发布后无需重新打包即可调整。

## 目录结构（核心）
- `app.py`：入口脚本（读取路径配置、启动 Flask 服务并打开浏览器）
- `web/server.py`：Flask 后端（API 路由、静态资源与模板、业务服务绑定）
- `core/`：核心业务（下载器、分析器、配置管理等）
- `web/templates/index.html`：前端页面模板
- `web/static/`：前端样式与脚本
- `paths.json`：外部路径配置（可改为 NAS）

## 运行环境
- Windows 10/11 x64
- Python 3.12（推荐），依赖：
  - Flask、paramiko、pyinstaller（可选用于打包）

安装依赖：
```
py -3.12 -m pip install --upgrade pip
py -3.12 -m pip install flask paramiko pyinstaller
```

## 启动方式
- 直接启动（自动打开浏览器）：
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
py -3.12 -m PyInstaller \
  --name LogTool \
  --noconsole \
  --clean \
  --noconfirm \
  --add-data "web\\templates;web\\templates" \
  --add-data "web\\static;web\\static" \
  --add-data "paths.json;." \
  app.py
```
- 分发：压缩并分发 `dist/LogTool/` 整个目录，不要只发单个 `exe`。

## 使用说明
- 启动后访问 `http://localhost:5000`（`app.py` 会默认尝试打开浏览器）。
- 日志下载：选择厂区/系统，填写节点（必填），可选归档日期范围→搜索→勾选→下载。
- 日志分析：选择已下载日志与解析配置→开始分析→生成报告。
- 服务器配置与解析配置：在对应页面管理；配置文件保存在 `paths.json` 指定目录。

## 常见问题
- 托盘不可见：已改为纯网页模式，无需托盘和桌面客户端。
- 资源 304：浏览器缓存命中，正常行为。
- 端口占用：如有其它程序占用 `5000`，请关闭占用进程或更换端口。
- NAS 权限：确保目标 UNC 路径对用户可读写；失败时检查权限与连通性。

## 提交建议
- 已移除本地构建产物：`dist/LogTool/`、`build/LogTool/`，避免将打包结果提交。
- 建议保留的核心目录与文件：`app.py`、`paths.json`、`web/`、`core/`。
- 如需忽略更多本地文件，可在 VCS 中添加忽略规则（例如 `dist/`、`build/`）。
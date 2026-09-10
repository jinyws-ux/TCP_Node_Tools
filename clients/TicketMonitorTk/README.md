# TicketMonitor v2.5.0 测试版

本版只改客户端，后端继续使用 v2.4.0。保留你自己的 ticket-monitor.json，勿用示例覆盖。

## 列表

待处理页按“待人工处理（N）/未分配（N）”上下分区；浅蓝/灰色标题，细分隔线。
两区共用滚动条（鼠标滚轮），全部/INC/WO 筛选同时生效。空分区显示暂无工单。
卡片显示实际 status；计数、共享忽略和转人工提醒沿用 v2.4.0。
后端必须返回 handling_kind=agent_handoff 才会进入待人工处理区。

## 首次安装

1. 首次使用先把 ticket-monitor.example.json 复制为 ticket-monitor.json，填写本机配置。已有配置继续保留。
2. 本机 Python 3.10，运行 build-onefile.cmd。build.cmd 仍为旧的 onedir 打包方式；本次分发请用 onefile。
2. 关闭旧客户端，把 dist/TicketMonitor.exe 手动放到原客户端目录，保留原配置。
3. 配置新增一项（JSON 注意逗号）：

```json
"updateManifestPath": "\\\\NAS01\\共享目录\\TicketMonitor\\version.json"
```

4. 启动后右键菜单选择“检查更新”。不自动定时检查。不配置路径不影响其他功能。

## 后续发布

修改 main.py 的 APP_VERSION（x.y.z），重新运行 build-onefile.cmd，再执行：

```bat
py -3.10 publish_update.py "dist\TicketMonitor.exe" "\\NAS01\共享目录\TicketMonitor" --notes "本次更新说明"
```

发布脚本从同目录 main.py 读取版本，所以必须使用同一份源码刚打出来的 onefile EXE。
脚本先上传并校验独立版本 EXE，最后替换 version.json。同版本文件存在则拒绝覆盖。
请勿多人同时发布。读者需要 NAS 读取权限，只有发布者需要写权限。

使用者点击检查更新，确认后在后台复制到本地临时目录、校验 SHA-256，然后自动退出、替换原路径 EXE 并重新启动。
仅支持单 EXE 的 onefile 发布，不支持仅替换 onedir 包的主程序来升级依赖。
更新不会迁移或覆盖配置；退出时仍会按原有逻辑保存窗口位置。

## 失败和恢复

复制或校验失败：当前客户端继续运行。
PowerShell 脚本被公司策略禁止：提示失败，当前客户端保持运行；本版不更改执行策略。
旧进程退出超时或无法替换：更新脚本记录错误并尝试恢复/重启旧版本。
成功后旧 EXE 留在原目录的 TicketMonitor.exe.update-backup（实际前缀随原文件名）。
本地临时目录 TicketMonitor-update-* 内保留 update.log、更新脚本和已下载文件，排查后可以删除。
如果新版启动后自身报错，当前版本不能自动识别业务健康状态；关闭程序后可手动用备份恢复。
客户端应放在有写权限的本地目录，避免直接运行共享盘 EXE；更新期间不要手动启动第二个实例。
SHA-256 用于完整性校验，不是数字签名；请限制 NAS 发布目录的写权限。

## 验证

源码自检：python main.py --self-test
回归测试：python -m unittest discover -s tests -v
本交付环境不具备 Windows / PowerShell / 桌面显示，未实测 Windows 自替换及实际字体渲染。
建议先用本机测试目录模拟 NAS，发布一个提高版本号的构建，检查更新后版本号、配置、工单分区和重启。

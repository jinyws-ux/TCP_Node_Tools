# 工单监控同步说明

## 基线与范围

本分支基于远端 agent/unassigned-ticket-monitor 的 5485e6d（保留 PLC 报告功能和完整 server.py）。同步的是当前对话中可取得的代码和已确认修正，不是生产电脑文件的逐字副本。

- 后端：未分配或指定 assignee + In Progress；返回 handling_kind、status，转人工优先。
- SLA：75%/90%/100%，Assigned 与 In Progress，独立接口和缓存。
- 工作量：UF 与 Remedy 姓名独立；工单按月查询，默认每单 2.69/8 天，JIRA 1 SP=1 天。
- JIRA：支持 jira.token 明文配置，未填写时读取 tokenEnv；查询失败保留异常日志。
- 客户端：已交付 v2.5.0 的分区列表、共享忽略、防锁按钮、NAS 手动更新及发布辅助脚本。
- 客户端路径：clients/TicketMonitorTk/；源码版本仍为 2.5.0，不擅自重命名为生产的 2.6.0。

## 必须保留的生产设置

以下内容没有生产实物可核对，不能声称已经同步：数据库连接/密码、生产 schema/组名及自定义 pendingQuery/slaRiskQuery、真实 JQL、JIRA URL/PAT、假期和调休、个人工号姓名、NAS 路径及生产自行修改的代码。

配置只入库 example 文件；复制为对应实际文件后自行填写。实际 configs/unassigned_tickets.json、configs/workload.json、客户端 ticket-monitor.json 已被忽略。不要将生产配置覆盖为示例。

pendingQuery 为可选的完整 SQL；参数使用 %(agent_assignee)s 和 %(agent_status)s。默认表为 remedy_ticket，组为 IT Control Center L2；按实际生产配置核对。完整模板在 core/unassigned_ticket_service.py 的 DEFAULT_QUERY。

月目标仍为周一至周五加 calendar.holidays / extraWorkdays / monthlyTargetOverrides，没有联网自动获取节假日。沿用你在生产填好的日历。

## 已知边界

共享忽略的偶发 WinError 5 未复现，也没有擅自替换成另一种写入方式；保持共享锁和临时文件替换逻辑。NAS 发布脚本读取源码版本，仍需先重新打包再发布，不能只修改版本号。Windows 更新与界面需在本机验证。

## 今后开发

从本分支继续改代码，客户端与后端一起提交。每次发布先修改 APP_VERSION，再运行 build-onefile.cmd，再运行 publish_update.py。源码和 EXE 必须来自同一次构建。

生产目录存在未提交改动时，不要直接覆盖或 reset --hard。优先在新的目录检出本分支，复用本机配置并核对上述差异，然后再切换部署。

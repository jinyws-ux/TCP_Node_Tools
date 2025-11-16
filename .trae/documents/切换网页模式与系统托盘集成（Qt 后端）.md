## 目标
- 顶部右上角替换为“网页模式”按钮，点击后：
  1) 打开默认浏览器访问 `http://localhost:5000`
  2) 隐藏桌面客户端窗口
  3) 在 Windows 系统托盘（右下角小三角）挂载图标，菜单包含“显示客户端”“退出”
- 保持后端 Flask 服务与所有功能在后台可用；托盘菜单可恢复窗口或退出程序。

## 设计要点
- 后端强制使用 Qt 后端（PyQt6），通过 Qt 的 `QSystemTrayIcon` 实现托盘，无需新增依赖。
- 托盘对象必须在 GUI 主线程创建；使用 `webview.start(func=setup_tray)` 在 Qt 事件循环 ready 后初始化托盘。
- 前端按钮调用新接口 `/api/web-mode`，后端执行：打开浏览器、隐藏窗口、显示托盘。
- 恢复客户端：托盘菜单触发窗口 `show/raise`；退出：销毁窗口并优雅结束进程。

## 文件与改动
### 1) 前端 UI 与交互
- `web/templates/index.html`
  - 将右上角“在线 / 智慧运维V2”标识替换为一个按钮：`<button id="btn-web-mode">网页模式</button>`
- `web/static/js/app.js`
  - 绑定按钮事件：`document.getElementById('btn-web-mode').addEventListener('click', enableWebMode)`
  - 新增函数 `enableWebMode`：调用 `api.webMode({ enable: true })`，成功后提示“已切换到网页模式”，可选延迟 0.5s 再关闭提示
- `web/static/js/core/api.js`
  - 增加方法：`webMode: (payload) => post('/api/web-mode', payload)`（参考现有 `openInBrowser`、`openInEditor` 实现）

### 2) 后端接口
- `web/server.py`
  - 新增路由：`@app.route('/api/web-mode', methods=['POST'])`
    - 读取 `enable`（默认 true）
    - 打开浏览器：使用已存在的打开浏览器逻辑（`webbrowser.open`），或直接调用现有接口的内部工具
    - 隐藏窗口：`import webview; webview.windows[0].hide()`（若无窗口则返回错误）
    - 置托盘显示：调用托盘管理器的 `show_tray()`（见下节）
    - 返回 JSON：`{ success: true }`

### 3) 托盘管理（Qt 实现）
- `app.py`
  - 强制 Qt 后端：`webview.start(gui='qt', func=setup_tray)`（替换现有 `webview.start()`）
  - 新增 `setup_tray()`：
    - 使用 `from PyQt6.QtWidgets import QApplication, QSystemTrayIcon, QMenu, QAction`，获取 `QApplication.instance()`
    - 创建 `QSystemTrayIcon`，使用 `web/static/favicon.ico` 作为图标（按当前 `base_path` 拼接）
    - 创建 `QMenu`：
      - `显示客户端`：调用 `webview.windows[0].show()` 并将窗口前置（Qt 中可用 `raise_`/`activateWindow`，或调用 `webview.windows[0].bring_to_front()` 若支持）
      - `退出`：销毁窗口并结束（`webview.destroy_window(webview.windows[0])` 或 `webview.exit()`）
    - `tray.setContextMenu(menu)`；初始不显示托盘（`tray.hide()`）
    - 将 `tray` 保存为全局对象，提供 `show_tray()`/`hide_tray()` 供后端调用（注意这些操作需在 GUI 线程执行；可用 `webview.evaluate_js` 不适合；建议在 `setup_tray` 内注册一个线程安全的调用桥，如 `webview.windows[0].events.loaded += ...` 或用 `webview._call_on_main_thread`；实现方案如下）
  - 线程安全调用方案：
    - 在 `setup_tray` 内定义线程安全队列或用 `QTimer.singleShot` 包装回调；在后端调用时通过 `webview.windows[0]` 的 `gui` 调度（pywebview Qt 后端允许在主线程执行的回调；若不可直接用内部 API，则通过 `ctypes.pythonapi.Py_AddPendingCall` 或创建一个轻量 `socket` 事件触发 Qt 主线程执行 `show_tray()`）；优先尝试 pywebview 的 `webview.windows[0].toggle_visibility()`/`show()`/`hide()` 直接调用（这些通常为线程安全封装）。

### 4) 运行时流程
- 用户点击“网页模式”按钮 → 前端调用 `/api/web-mode`。
- 后端：打开浏览器 → 隐藏窗口 → 显示托盘（托盘菜单可恢复或退出）。
- 恢复：右键托盘选择“显示客户端” → 窗口显示并前置；根据需求，仍保留托盘（或隐藏托盘）。
- 退出：右键托盘选择“退出” → 释放资源并结束进程。

### 5) 打包与资源
- 托盘图标使用现有 `web/static/favicon.ico`。
- PyInstaller 已包含 PyQt6 运行库；无需新增依赖。
- 保留 `paths.json` 配置以支持 NAS 路径。

### 6) 回退与兼容
- 若运行环境未启用 Qt 后端：
  - 退化行为：仍打开浏览器与隐藏窗口；托盘功能暂不可用（或使用 `pystray` 作为备选，但这会增加依赖体积）。
  - 可选增强：设置 `webview.start(gui='qt')` 强制使用 Qt 后端，确保托盘功能可用。

### 7) 测试用例
- 前端：按钮点击后提示成功，随后窗口隐藏、浏览器打开。
- 托盘菜单：
  - 选择“显示客户端” → 窗口显示且可交互；全选按钮状态与分析列表保持正常。
  - 选择“退出” → 进程结束，无残留托盘。
- 边界：
  - 无窗口对象时调用 → 返回错误 JSON 并提示。
  - 重复点击“网页模式” → 仅首次显示托盘与隐藏窗口；后续调用不重复创建托盘。

## 代码参考
- Flask 与 API 方法：`web/static/js/core/api.js:26-33` 已有多个 POST 调用模式；复用风格。
- 打开浏览器（已存在调用）：`web/static/js/core/api.js:34-41` 的 `openInBrowser` 与后端对应路由可参照；新增路由时同样返回 JSON。
- 下载页多选实现参考：`web/static/js/modules/download.js:34-66, 136-149, 305-320` 的“全选/部分选/未选”逻辑，分析页已对齐。

## 交付
- 改动 JS/HTML 与 Python（`app.py`、`web/server.py`）
- 提供构建后的包 `dist/LogTool`，在 Windows 上验证托盘与网页模式切换。

## 确认
- 如无异议，我将按上述计划修改前后端与托盘集成，并确保 Qt 后端启用，完成打包和验证。
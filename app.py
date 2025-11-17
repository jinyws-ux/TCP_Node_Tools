import os
import sys
import threading
import json

import webview
import importlib
import importlib.util
if False:
    import web.server

server = None
app = None


def run_flask():
    """启动本地flask服务，端口5000"""
    app.run(port=5000)


def get_base_path():
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))

def get_runtime_root():
    if getattr(sys, 'frozen', False):
        try:
            return sys._MEIPASS
        except Exception:
            return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

def setup_tray():
    try:
        from PyQt6.QtWidgets import QApplication, QSystemTrayIcon, QMenu, QAction, QStyle
        from PyQt6.QtGui import QIcon
        app_qt = QApplication.instance()
        if app_qt is None:
            return
        try:
            app_qt.setQuitOnLastWindowClosed(False)
        except Exception:
            pass
        icon_path = os.path.join(get_base_path(), 'web', 'static', 'favicon.ico')
        icon = QIcon(icon_path) if os.path.exists(icon_path) else QIcon()
        if icon.isNull():
            try:
                icon = app_qt.style().standardIcon(QStyle.StandardPixmap.SP_ComputerIcon)
            except Exception:
                icon = QIcon()

        tray = QSystemTrayIcon(icon, app_qt)
        menu = QMenu()
        tray.setToolTip('日志分析系统')

        def show_client():
            try:
                if webview.windows:
                    win = webview.windows[0]
                    win.show()
                    try:
                        # bring to front if possible
                        pass
                    except Exception:
                        pass
            except Exception:
                pass

        def exit_app():
            try:
                if webview.windows:
                    webview.destroy_window(webview.windows[0])
            except Exception:
                os._exit(0)

        act_show = QAction('显示客户端', menu)
        act_show.triggered.connect(show_client)
        menu.addAction(act_show)

        act_exit = QAction('退出', menu)
        act_exit.triggered.connect(exit_app)
        menu.addAction(act_exit)

        tray.setContextMenu(menu)
        tray.show()

        # 暴露托盘控制到 server 模块
        server.TRAY_OBJ = tray
        server.TRAY_API = {
            'show': tray.show,
            'hide': tray.hide,
        }
    except Exception:
        # 无法初始化托盘（非 Qt 后端等），忽略
        server.TRAY_API = {
            'show': lambda: None,
            'hide': lambda: None,
        }

if __name__ == '__main__':
    base_dir = os.path.dirname(os.path.abspath(__file__))
    runtime_root = get_runtime_root()
    candidates = []
    env_cfg = os.environ.get('LOGTOOL_PATHS_FILE')
    if env_cfg:
        candidates.append(env_cfg)
    candidates.append(os.path.join(runtime_root, 'paths.json'))
    try:
        meipass = sys._MEIPASS
        candidates.append(os.path.join(meipass, 'paths.json'))
    except Exception:
        pass
    candidates.append(os.path.join(base_dir, 'paths.json'))
    candidates.append(os.path.join(os.getcwd(), 'paths.json'))
    cfg_file = None
    for p in candidates:
        if p and os.path.exists(p):
            cfg_file = p
            break
    if cfg_file is None:
        cfg_file = os.path.join(base_dir, 'paths.json')
    data = {}
    try:
        with open(cfg_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        data = {}
    try:
        os.environ['LOGTOOL_PATHS_FILE'] = cfg_file
    except Exception:
        pass
    def _resolve(p, default):
        v = (data.get(p) or default)
        return v if os.path.isabs(v) else os.path.join(base_dir, v)
    download_dir = _resolve('DOWNLOAD_DIR', 'downloads')
    config_dir = _resolve('CONFIG_DIR', 'configs')
    html_logs_dir = _resolve('HTML_LOGS_DIR', 'html_logs')

    os.makedirs(download_dir, exist_ok=True)
    os.makedirs(config_dir, exist_ok=True)
    os.makedirs(html_logs_dir, exist_ok=True)

    try:
        server = importlib.import_module('web.server')
    except ModuleNotFoundError:
        import types
        import importlib.machinery
        pkg = types.ModuleType('web')
        candidates = []
        try:
            candidates.append(os.path.join(sys._MEIPASS, 'web'))
        except Exception:
            pass
        candidates.append(os.path.join(runtime_root, 'web'))
        candidates.append(os.path.join(base_dir, 'web'))
        module_dir = None
        for d in candidates:
            if os.path.exists(os.path.join(d, 'server.py')):
                module_dir = d
                break
        if not module_dir:
            raise ModuleNotFoundError('web.server module not found in packaged resources')
        pkg.__path__ = [module_dir]
        sys.modules['web'] = pkg
        server_path = os.path.join(module_dir, 'server.py')
        spec = importlib.util.spec_from_file_location('web.server', server_path)
        server = importlib.util.module_from_spec(spec)
        sys.modules['web.server'] = server
        spec.loader.exec_module(server)
    app = server.app
    app.config['DOWNLOAD_DIR'] = download_dir
    app.config['CONFIG_DIR'] = config_dir
    app.config['HTML_LOGS_DIR'] = html_logs_dir

    # 在单独线程中启动Flask
    threading.Thread(target=run_flask, daemon=True).start()

    # 创建webview窗口
    base_path = get_base_path()
    window = webview.create_window(
        title='日志分析系统',
        url='http://localhost:5000?embedded=1',
        width=1500,
        height=1000,
        resizable=True
    )

    # 设置窗口图标
    icon_path = os.path.join(base_path, 'web', 'static', 'favicon.ico')
    if os.path.exists(icon_path):
        window.set_icon(icon_path)

    webview.start(gui='qt', func=setup_tray)
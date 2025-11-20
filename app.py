import os
import sys
import threading
import json
import time
import webbrowser

import importlib
import importlib.util
if False:
    import web.server


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


def open_browser(url: str, delay: float = 1.0) -> None:
    """在后台尝试打开浏览器，不阻塞主线程。"""

    def _open():
        time.sleep(delay)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    threading.Thread(target=_open, daemon=True).start()


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

    # 启动 Flask 服务（主线程），默认自动打开网页模式
    url = 'http://localhost:5000'
    if os.environ.get('LOGTOOL_NO_BROWSER') != '1':
        open_browser(url)

    app.run(port=5000)

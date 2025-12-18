CORE_MODULES = [
    "core.analysis_service",
    "core.config_manager",
    "core.download_service",
    "core.log_analyzer",
    "core.log_downloader",
    "core.log_metadata_store",
    "core.log_parser",
    "core.parser_config_manager",
    "core.parser_config_service",
    "core.report_mapping_store",
    "core.server_config_service",
    "core.template_manager",
]


def preload_core_modules() -> None:
    """显式导入 core.* 模块，确保 PyInstaller 打包后可用。"""
    for module_name in CORE_MODULES:
        try:
            importlib.import_module(module_name)
        except Exception:
            continue
import argparse
import importlib
import importlib.util
import json
import os
import sys
import threading
import time
import webbrowser
from dataclasses import dataclass
from typing import Dict, Iterable, Optional
from flask_cors import CORS


# --------------------------------------------------------------------------- #
# 数据类与工具
# --------------------------------------------------------------------------- #
@dataclass
class AppPaths:
    base_dir: str
    runtime_root: str
    config_file: str
    download_dir: str
    config_dir: str
    html_logs_dir: str


def _is_frozen() -> bool:
    return getattr(sys, "frozen", False)


def get_base_dir() -> str:
    if _is_frozen():
        return getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def get_runtime_root() -> str:
    if _is_frozen():
        return getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _candidate_paths(base_dir: str, runtime_root: str) -> Iterable[str]:
    env_cfg = os.environ.get("LOGTOOL_PATHS_FILE")
    if env_cfg:
        yield env_cfg

    yield os.path.join(runtime_root, "paths.json")

    if _is_frozen():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            yield os.path.join(meipass, "paths.json")

    yield os.path.join(base_dir, "paths.json")
    yield os.path.join(os.getcwd(), "paths.json")


def resolve_paths_config(base_dir: str, runtime_root: str) -> str:
    for path in _candidate_paths(base_dir, runtime_root):
        if path and os.path.exists(path):
            return path
    return os.path.join(base_dir, "paths.json")


def load_paths(config_file: str) -> Dict[str, str]:
    try:
        with open(config_file, "r", encoding="utf-8") as handle:
            data = json.load(handle)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def ensure_directories(*paths: str) -> None:
    for path in paths:
        os.makedirs(path, exist_ok=True)


def discover_app_paths() -> AppPaths:
    base_dir = get_base_dir()
    runtime_root = get_runtime_root()
    config_file = resolve_paths_config(base_dir, runtime_root)
    data = load_paths(config_file)

    def _resolve(key: str, default: str) -> str:
        value = data.get(key) or default
        return value if os.path.isabs(value) else os.path.join(base_dir, value)

    download_dir = _resolve("DOWNLOAD_DIR", "downloads")
    config_dir = _resolve("CONFIG_DIR", "configs")
    html_logs_dir = _resolve("HTML_LOGS_DIR", "html_logs")
    ensure_directories(download_dir, config_dir, html_logs_dir)

    try:
        os.environ["LOGTOOL_PATHS_FILE"] = config_file
    except Exception:
        pass

    return AppPaths(
        base_dir=base_dir,
        runtime_root=runtime_root,
        config_file=config_file,
        download_dir=download_dir,
        config_dir=config_dir,
        html_logs_dir=html_logs_dir,
    )


# --------------------------------------------------------------------------- #
# web.server 导入（兼容打包）
# --------------------------------------------------------------------------- #
def load_web_server(runtime_root: str, base_dir: str):
    def _ensure_sys_path(paths: Iterable[str]) -> None:
        for p in paths:
            if p and p not in sys.path:
                sys.path.insert(0, p)

    _ensure_sys_path({base_dir, runtime_root})

    try:
        return importlib.import_module("web.server")
    except ModuleNotFoundError:
        import types

        pkg = types.ModuleType("web")
        candidates = []
        if _is_frozen():
            meipass = getattr(sys, "_MEIPASS", None)
            if meipass:
                candidates.append(os.path.join(meipass, "web"))
        candidates.append(os.path.join(runtime_root, "web"))
        candidates.append(os.path.join(base_dir, "web"))

        module_dir: Optional[str] = None
        for folder in candidates:
            if os.path.exists(os.path.join(folder, "server.py")):
                module_dir = folder
                break
        if not module_dir:
            raise ModuleNotFoundError("web.server module not found in packaged resources")

        pkg.__path__ = [module_dir]
        sys.modules["web"] = pkg

        server_path = os.path.join(module_dir, "server.py")

        # 确保 web 包所在目录及其上级加入 sys.path，便于导入 core 等本地模块
        _ensure_sys_path({module_dir, os.path.dirname(module_dir), base_dir})

        spec = importlib.util.spec_from_file_location("web.server", server_path)
        server = importlib.util.module_from_spec(spec)
        sys.modules["web.server"] = server
        spec.loader.exec_module(server)
        return server


# --------------------------------------------------------------------------- #
# 启动流程
# --------------------------------------------------------------------------- #
def create_app(paths: AppPaths):
    preload_core_modules()
    server_module = load_web_server(paths.runtime_root, paths.base_dir)
    flask_app = server_module.app

    if CORS:
        CORS(flask_app, resources={r"/*": {"origins": "*"}})
        print("CORS enabled for all routes")
    else:
        print("CORS not enabled")

    flask_app.config.update(
        DOWNLOAD_DIR=paths.download_dir,
        CONFIG_DIR=paths.config_dir,
        HTML_LOGS_DIR=paths.html_logs_dir,
    )
    return flask_app


def run_flask(app, host: str, port: int, debug: bool):
    app.run(host=host, port=port, debug=debug)


def wait_for_server(host: str, port: int, timeout: float = 5.0) -> None:
    import socket

    started = time.time()
    while time.time() - started < timeout:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            result = sock.connect_ex((host, port))
            if result == 0:
                return
        time.sleep(0.2)


def open_default_browser(host: str, port: int) -> None:
    try:
        wait_for_server(host, port)
        webbrowser.open(f"http://{host}:{port}")
    except Exception:
        pass


def parse_args(argv: Optional[Iterable[str]] = None):
    parser = argparse.ArgumentParser(description="启动 TCP LogTool Web 服务")
    parser.add_argument("--port", type=int, default=5000, help="Flask 监听端口（默认5000）")
    parser.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    parser.add_argument("--backend-only", action="store_true", help="只启动后端API服务，不自动打开浏览器")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="绑定的主机地址（默认127.0.0.1，服务器部署使用0.0.0.0）")
    parser.add_argument("--debug", action="store_true", help="启用调试模式")
    return parser.parse_args(argv)


def main(argv: Optional[Iterable[str]] = None) -> int:
    args = parse_args(argv)
    paths = discover_app_paths()
    flask_app = create_app(paths)

    # 启动Flask服务
    thread = threading.Thread(
        target=run_flask, 
        args=(flask_app, args.host, args.port, args.debug), 
        daemon=True
    )
    thread.start()

    # 打印启动信息
    print(f"\n🚀 TCP LogTool Web 服务已启动")
    print(f"📌 服务地址: http://{args.host}:{args.port}")
    print(f"📁 配置文件目录: {paths.config_dir}")
    print(f"💾 下载目录: {paths.download_dir}")
    print(f"💡 使用说明:")
    print(f"   - 访问 http://{args.host}:{args.port} 查看日志分析系统")
    print(f"   - 使用 --backend-only 参数只启动后端API服务")
    print(f"   - 使用 --host=0.0.0.0 参数允许外部访问（服务器部署）")
    print(f"   - 使用 Ctrl+C 停止服务\n")

    # 根据参数决定是否自动打开浏览器
    if not args.no_browser and not args.backend_only:
        open_default_browser(args.host, args.port)

    try:
        thread.join()
    except KeyboardInterrupt:
        print("\n🛑 服务已停止")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
import os
import sys
import threading

import webview

from web.server import app


def run_flask():
    """启动本地flask服务，端口5000"""
    app.run(port=5000)


def get_base_path():
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


if __name__ == '__main__':
    # 设置数据目录
    base_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(base_dir, 'data')
    download_dir = os.path.join(base_dir, 'downloads')
    config_dir = os.path.join(base_dir, 'configs')
    html_logs_dir = os.path.join(base_dir, 'html_logs')

    # 创建必要的目录
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(download_dir, exist_ok=True)
    os.makedirs(config_dir, exist_ok=True)
    os.makedirs(html_logs_dir, exist_ok=True)

    # 配置Flask应用
    app.config['DATA_DIR'] = data_dir
    app.config['DOWNLOAD_DIR'] = download_dir
    app.config['CONFIG_DIR'] = config_dir
    app.config['HTML_LOGS_DIR'] = html_logs_dir

    # 在单独线程中启动Flask
    threading.Thread(target=run_flask, daemon=True).start()

    # 创建webview窗口
    base_path = get_base_path()
    window = webview.create_window(
        title='日志分析系统',
        url='http://localhost:5000',
        width=1500,
        height=1000,
        resizable=True
    )

    # 设置窗口图标
    icon_path = os.path.join(base_path, 'web', 'static', 'favicon.ico')
    if os.path.exists(icon_path):
        window.set_icon(icon_path)

    webview.start()
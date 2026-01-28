import os
import subprocess
from stat import S_ISDIR
from typing import Any, Dict, List, Optional, Tuple

import paramiko

from core.json_store import JsonStore


def default_ghostpcl_exe(project_root: str) -> str:
    return os.path.join(project_root, "ghostpcl-10.06.0-win64", "gpcl6win64.exe")


def _is_safe_basename(name: str) -> bool:
    if not name:
        return False
    if os.path.basename(name) != name:
        return False
    if "/" in name or "\\" in name:
        return False
    return True


class PclServerStore:
    def __init__(self, config_dir: str) -> None:
        self._store = JsonStore(
            os.path.join(config_dir, "pcl_servers.json"),
            default_factory=lambda: {"servers": []},
        )

    def list_servers(self) -> List[Dict[str, Any]]:
        data = self._store.load() or {}
        servers = data.get("servers")
        if isinstance(servers, list):
            return [s for s in servers if isinstance(s, dict)]
        return []

    def get_server(self, server_id: str) -> Optional[Dict[str, Any]]:
        sid = (server_id or "").strip()
        for s in self.list_servers():
            if str(s.get("id") or "").strip() == sid:
                return s
        return None

    @property
    def filepath(self) -> str:
        return self._store.filepath


def list_remote_pcl_files(server: Dict[str, Any], password: str) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    host = str(server.get("host") or "").strip()
    user = str(server.get("user") or "").strip()
    port = int(server.get("port") or 22)
    path = str(server.get("path") or "").strip()
    if not host or not user or not path:
        return [], "服务器配置缺少 host/user/path"

    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(hostname=host, port=port, username=user, password=password, timeout=8, auth_timeout=8, banner_timeout=8)
        sftp = ssh.open_sftp()
        try:
            entries = sftp.listdir_attr(path)
        except FileNotFoundError:
            return [], f"远程路径不存在: {path}"
        files = [e for e in entries if not S_ISDIR(e.st_mode)]
        items: List[Dict[str, Any]] = []
        for f in files:
            fn = getattr(f, "filename", "")
            if not isinstance(fn, str):
                continue
            lower = fn.lower()
            if not (lower.endswith(".pcl") or lower.endswith(".prn")):
                continue
            items.append(
                {
                    "filename": fn,
                    "mtime": int(getattr(f, "st_mtime", 0) or 0),
                    "size": int(getattr(f, "st_size", 0) or 0),
                }
            )
        items.sort(key=lambda x: x.get("mtime", 0), reverse=True)
        try:
            sftp.close()
        finally:
            ssh.close()
        return items, None
    except Exception as exc:
        return [], str(exc)


def download_remote_file(server: Dict[str, Any], password: str, filename: str, local_path: str) -> Optional[str]:
    if not _is_safe_basename(filename):
        return "非法文件名"

    host = str(server.get("host") or "").strip()
    user = str(server.get("user") or "").strip()
    port = int(server.get("port") or 22)
    path = str(server.get("path") or "").strip()
    if not host or not user or not path:
        return "服务器配置缺少 host/user/path"

    remote_full_path = path.rstrip("/") + "/" + filename
    try:
        os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(hostname=host, port=port, username=user, password=password, timeout=10, auth_timeout=10, banner_timeout=10)
        sftp = ssh.open_sftp()
        sftp.get(remote_full_path, local_path)
        try:
            sftp.close()
        finally:
            ssh.close()
        return None
    except Exception as exc:
        return str(exc)


def convert_pcl_to_pdf(ghostpcl_exe: str, pcl_file: str, pdf_file: str) -> Tuple[bool, Optional[str]]:
    if not os.path.exists(ghostpcl_exe):
        return False, f"找不到 GhostPCL 可执行文件: {ghostpcl_exe}"
    if not os.path.exists(pcl_file):
        return False, f"找不到待转换文件: {pcl_file}"

    os.makedirs(os.path.dirname(pdf_file) or ".", exist_ok=True)
    cmd = [
        ghostpcl_exe,
        "-dNOPAUSE",
        "-dBATCH",
        "-sDEVICE=pdfwrite",
        f"-sOutputFile={pdf_file}",
        pcl_file,
    ]
    try:
        startupinfo = None
        if os.name == "nt":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        subprocess.run(cmd, check=True, startupinfo=startupinfo)
        return True, None
    except subprocess.CalledProcessError:
        return False, "转换失败：可能是 PCL/PRN 文件损坏或格式不兼容"
    except Exception as exc:
        return False, str(exc)


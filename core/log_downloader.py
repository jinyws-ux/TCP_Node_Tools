# core/log_downloader.py
import hashlib
import logging
import os
import re
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional

import paramiko

from .log_metadata_store import LogMetadataStore

class LogDownloader:
    """
    统一/增强版：
    - 实时/归档搜索分别使用：_search_realtime_for_nodes / _search_archive_for_nodes
    - 多节点“严格”与“普通”都复用 search_logs_many_nodes（仅语义区分）
    - 返回字段统一：name, remote_path(兼容 path), size, mtime, type, node
    - download_logs 会按“实际节点号”分目录
    """

    def __init__(
        self,
        download_dir: str,
        config_manager: Any,
        *,
        metadata_dir: Optional[str] = None,
        metadata_store: Optional[LogMetadataStore] = None,
    ):
        self.download_dir = download_dir
        self.config_manager = config_manager
        self.logger = logging.getLogger(__name__)
        os.makedirs(download_dir, exist_ok=True)
        self.metadata_store = metadata_store or LogMetadataStore(download_dir, metadata_dir)

    # ---------------------- 对外：单节点（向后兼容） ----------------------
    def search_logs(
        self,
        factory: str,
        system: str,
        node: str,
        include_realtime: bool = True,
        include_archive: bool = False,
        date_start: Optional[str] = None,
        date_end: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        保持原签名不变；内部复用多节点实现。
        """
        nodes = self._normalize_nodes(node)
        return self.search_logs_many_nodes(
            factory=factory,
            system=system,
            nodes=nodes,
            include_realtime=include_realtime,
            include_archive=include_archive,
            date_start=date_start,
            date_end=date_end,
        )

    # ---------------------- 对外：多节点（通用/模糊） ----------------------
    def search_logs_many_nodes(
        self,
        factory: str,
        system: str,
        nodes: Iterable[str],
        include_realtime: bool = True,
        include_archive: bool = False,
        date_start: Optional[str] = None,
        date_end: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        多节点搜索（实时使用 tcp_trace.{node}* 模式；归档限定日期范围）。
        """
        try:
            server_config = self._get_server_config(factory, system)
            if not server_config:
                return []

            server_info = server_config["server"]
            server_alias = server_info["alias"]
            results: List[Dict[str, Any]] = []
            visited = set()  # 去重（remote_path）

            with self._open_ssh(server_info) as ssh:
                if include_realtime:
                    realtime_path = (server_info.get("realtime_path") or f"/{server_alias}/km/log")
                    for it in self._search_realtime_for_nodes(ssh, realtime_path, nodes):
                        rp = it.get("remote_path") or it.get("path")
                        if rp and rp not in visited:
                            visited.add(rp)
                            results.append(it)

                if include_archive:
                    archive_path = (server_info.get("archive_path") or f"/nfs/{server_alias}/ips_log_archive/{server_alias}/km_log")
                    for it in self._search_archive_for_nodes(
                        ssh, archive_path, nodes, date_start=date_start, date_end=date_end
                    ):
                        rp = it.get("remote_path") or it.get("path")
                        if rp and rp not in visited:
                            visited.add(rp)
                            results.append(it)

            # 时间降序（尽量用 mtime / timestamp）
            def _key(x):
                return x.get("mtime") or x.get("timestamp") or ""

            results.sort(key=_key, reverse=True)
            return results
        except Exception as e:
            self.logger.error(f"搜索日志失败: {str(e)}")
            return []

    # ---------------------- 对外：多节点（严格/模板） ----------------------
    def search_logs_strict(
        self,
        factory: str,
        system: str,
        nodes: Iterable[str],
        include_realtime: bool = True,
        include_archive: bool = False,
        date_start: Optional[str] = None,
        date_end: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        “严格模式”：业务语义用于模板锁定；实现复用 search_logs_many_nodes。
        """
        nodes = self._normalize_nodes(nodes)
        return self.search_logs_many_nodes(
            factory=factory,
            system=system,
            nodes=nodes,
            include_realtime=include_realtime,
            include_archive=include_archive,
            date_start=date_start,
            date_end=date_end,
        )

    # ====================== 内部：公共工具 ======================
    def _normalize_nodes(self, nodes: Any) -> List[str]:
        """
        支持传入逗号分隔字符串或可迭代对象；去空/去重/保持原顺序。
        """
        out: List[str] = []
        if isinstance(nodes, str):
            parts = [p.strip() for p in nodes.split(",")]
        else:
            parts = [str(p).strip() for p in list(nodes or [])]
        for p in parts:
            if not p:
                continue
            if p not in out:
                out.append(p)
        return out

    def _get_server_config(self, factory: str, system: str) -> Optional[Dict[str, Any]]:
        """获取服务器配置"""
        configs = self.config_manager.get_server_configs()
        for config in configs:
            if config.get("factory") == factory and config.get("system") == system:
                return config
        return None

    @contextmanager
    def _open_ssh(self, server_info: Dict[str, Any]):
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            server_info["hostname"],
            username=server_info["username"],
            password=server_info["password"],
            timeout=int(server_info.get("timeout", 30)),
        )
        try:
            yield ssh
        finally:
            try:
                ssh.close()
            except Exception:
                pass

    @contextmanager
    def _open_sftp(self, ssh: paramiko.SSHClient):
        sftp = None
        try:
            sftp = ssh.open_sftp()
            yield sftp
        finally:
            if sftp:
                try:
                    sftp.close()
                except Exception:
                    pass

    # ====================== 内部：实时/归档检索 ======================
    def _search_realtime_for_nodes(
        self, ssh: paramiko.SSHClient, base_path: str, nodes: Iterable[str]
    ) -> List[Dict[str, Any]]:
        """
        遍历节点，执行 ls -l {base_path}/tcp_trace.{node}*
        修复返回 remote_path，补充 node 字段。
        """
        results: List[Dict[str, Any]] = []
        for node in nodes or []:
            try:
                cmd = f'ls -l {base_path}/tcp_trace.{node}* 2>/dev/null'
                stdin, stdout, stderr = ssh.exec_command(cmd)
                lines = stdout.read().decode(errors="ignore").splitlines()

                for line in lines:
                    line = line.strip()
                    if not line or line.startswith("total"):
                        continue
                    parts = line.split()
                    if len(parts) < 9:
                        continue

                    size = parts[4]
                    # mtime 形如 "Jan 01 12:34" 或 "2025-01-01 12:34"
                    mtime = " ".join(parts[5:8])
                    filename = " ".join(parts[8:])

                    # 兼容 ls 可能返回绝对路径或仅文件名
                    basename = os.path.basename(filename)
                    remote_path = f"{base_path.rstrip('/')}/{basename}"

                    item = {
                        "name": basename,
                        "remote_path": remote_path,
                        "path": remote_path,  # 兼容旧字段
                        "size": int(size) if str(size).isdigit() else 0,
                        "mtime": self._format_timestamp(mtime),
                        "type": "realtime",
                        "node": self._extract_node_from_filename(basename),
                    }
                    results.append(item)
            except Exception as e:
                self.logger.error(f"搜索实时日志失败（node={node}）: {str(e)}")
                continue
        return results

    def _search_archive_for_nodes(
        self,
        ssh: paramiko.SSHClient,
        base_path: str,
        nodes: Iterable[str],
        date_start: Optional[str],
        date_end: Optional[str],
    ) -> List[Dict[str, Any]]:
        """
        归档按日期范围与节点枚举；stat 使用完整路径。
        """
        results: List[Dict[str, Any]] = []

        if not date_start or not date_end:
            self.logger.warning("归档搜索需要提供日期范围（date_start/date_end）")
            return results

        try:
            start_date = datetime.strptime(date_start, "%Y-%m-%d")
            end_date = datetime.strptime(date_end, "%Y-%m-%d")
        except Exception:
            self.logger.error("日期格式应为 YYYY-MM-DD")
            return results

        # 生成闭区间日期
        date_list: List[str] = []
        cur = start_date
        while cur <= end_date:
            date_list.append(cur.strftime("%Y-%m-%d"))
            cur += timedelta(days=1)

        for node in nodes or []:
            for date_str in date_list:
                try:
                    basename = f"tcp_trace.{node}.{date_str}"
                    remote_path = f"{base_path.rstrip('/')}/{basename}"

                    # stat 需要完整路径
                    cmd = f"stat {remote_path} 2>/dev/null"
                    stdin, stdout, stderr = ssh.exec_command(cmd)
                    stat_info = stdout.read().decode().strip()
                    if not stat_info:
                        continue

                    size_match = re.search(r"Size:\s*(\d+)", stat_info)
                    mtime_match = re.search(r"Modify:\s*(.+)", stat_info)

                    item = {
                        "name": basename,
                        "remote_path": remote_path,
                        "path": remote_path,  # 兼容旧字段
                        "size": int(size_match.group(1)) if size_match else 0,
                        "mtime": self._format_timestamp(mtime_match.group(1) if mtime_match else ""),
                        "type": "archive",
                        "node": self._extract_node_from_filename(basename),
                    }
                    results.append(item)
                except Exception as e:
                    self.logger.error(f"搜索归档日志失败（node={node}, date={date_str}）: {str(e)}")
                    continue

        return results

    # ====================== 下载 ======================
    def download_logs(
        self,
        log_files: List[Dict[str, Any]],
        factory: str,
        system: str,
        search_node: Optional[str] = None,
        search_nodes: Optional[Iterable[str]] = None,
    ) -> List[Dict[str, Any]]:
        """
        下载选中的日志文件：
        - 优先用 item['remote_path']（回退 item['path']）
        - 文件按“实际节点号”分目录
        - 兼容旧字段：search_node，同时支持 search_nodes（列表）
        """
        try:
            server_config = self._get_server_config(factory, system)
            if not server_config:
                self.logger.error(f"未找到服务器配置: {factory}/{system}")
                return []

            download_base_dir = os.path.join(self.download_dir, factory, system)
            os.makedirs(download_base_dir, exist_ok=True)

            downloaded_files: List[Dict[str, Any]] = []
            node_groups = self._group_files_by_node(log_files)
            if not node_groups:
                return []

            normalized_search_nodes = self._normalize_nodes(search_nodes or [])
            search_nodes_payload = normalized_search_nodes or ([search_node] if search_node else [])
            search_trace = search_node or ",".join(normalized_search_nodes)

            server_info = server_config["server"]
            with self._open_ssh(server_info) as ssh:
                with self._open_sftp(ssh) as sftp:
                    for actual_node, node_files in node_groups.items():
                        node_dir = os.path.join(download_base_dir, actual_node)
                        os.makedirs(node_dir, exist_ok=True)

                        for file_info in node_files:
                            remote_path = file_info["remote_path"]
                            filename = file_info["name"]
                            local_path = os.path.join(node_dir, filename)

                            try:
                                sftp.get(remote_path, local_path)
                                download_time = datetime.now().isoformat()
                                source_mtime = file_info.get("mtime") or ""
                                entry = {
                                    "name": filename,
                                    "path": local_path,
                                    "size": os.path.getsize(local_path),
                                    "timestamp": download_time,
                                    "download_time": download_time,
                                    "log_time": source_mtime,
                                    "source_mtime": source_mtime,
                                    "factory": factory,
                                    "system": system,
                                    "node": actual_node,
                                    "type": file_info.get("type", "unknown"),
                                    "search_node": search_node,
                                    "search_nodes": search_nodes_payload,
                                }
                                downloaded_files.append(entry)
                                self._write_metadata(
                                    local_path,
                                    {
                                        **entry,
                                        "remote_path": remote_path,
                                    },
                                )
                                self.logger.info(
                                    "成功下载: %s (实际节点: %s, 搜索节点/集: %s)",
                                    local_path,
                                    actual_node,
                                    search_trace or "未指定",
                                )
                            except Exception as e:
                                self.logger.error(f"下载失败 {remote_path}: {str(e)}")
                                continue

            return downloaded_files
        except Exception as e:
            self.logger.error(f"下载日志失败: {str(e)}")
            return []

    # ====================== 辅助 ======================
    def _group_files_by_node(self, log_files: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
        node_groups: Dict[str, List[Dict[str, Any]]] = {}
        for file_info in log_files or []:
            remote_path = file_info.get("remote_path") or file_info.get("path") or ""
            if not remote_path:
                self.logger.warning(f"跳过无 remote_path 的项: {file_info}")
                continue
            filename = os.path.basename(remote_path)
            actual_node = file_info.get("node") or self._extract_node_from_filename(filename)
            node_groups.setdefault(actual_node, []).append(
                {**file_info, "remote_path": remote_path, "name": filename}
            )
        return node_groups

    def _extract_node_from_filename(self, filename: str) -> str:
        """从文件名中提取节点号 - 增强版"""
        try:
            patterns = [
                r"tcp_trace\.(\d+)",
                r"tcp_trace\.(\d+)\.old",
                r"tcp_trace\.(\d+)\.\d{4}-\d{2}-\d{2}",
            ]
            for pattern in patterns:
                m = re.search(pattern, filename)
                if m:
                    return m.group(1)

            parts = filename.split(".")
            if len(parts) >= 2 and parts[1].isdigit():
                return parts[1]

            digits = re.findall(r"\d+", filename)
            if digits:
                return max(digits, key=len)

            self.logger.warning(f"无法从文件名提取节点号: {filename}, 使用'未知'")
            return "未知"
        except Exception as e:
            self.logger.error(f"提取节点号失败 {filename}: {str(e)}")
            return "未知"

    def _write_metadata(self, file_path: str, payload: Dict[str, Any]) -> None:
        try:
            self.metadata_store.write(file_path, payload)
        except Exception as exc:
            self.logger.warning("写入日志元数据失败: %s (%s)", file_path, exc)

    def _read_metadata(self, file_path: str) -> Dict[str, Any]:
        try:
            return self.metadata_store.read(file_path)
        except Exception as exc:
            self.logger.warning("读取日志元数据失败: %s (%s)", file_path, exc)
            return {}

    def _format_timestamp(self, raw: str) -> str:
        text = (raw or "").strip()
        if not text:
            return ""
        normalized = re.sub(r"\s+", " ", text)
        iso_match = re.match(r"(?P<date>\d{4}-\d{2}-\d{2})[ T](?P<time>\d{2}:\d{2}:\d{2})", normalized)
        if iso_match:
            return f"{iso_match.group('date')} {iso_match.group('time')}"
        iso_short = re.match(r"(?P<date>\d{4}-\d{2}-\d{2})[ T](?P<time>\d{2}:\d{2})", normalized)
        if iso_short:
            return f"{iso_short.group('date')} {iso_short.group('time')}:00"

        try:
            dt = datetime.strptime(normalized, "%b %d %H:%M")
            dt = dt.replace(year=datetime.now().year)
            return dt.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            pass

        try:
            dt = datetime.strptime(normalized, "%b %d %Y")
            return dt.strftime("%Y-%m-%d 00:00:00")
        except Exception:
            pass

        frac_iso = re.match(r"(?P<date>\d{4}-\d{2}-\d{2})[ T](?P<time>\d{2}:\d{2}:\d{2})\.\d+", normalized)
        if frac_iso:
            return f"{frac_iso.group('date')} {frac_iso.group('time')}"

        return normalized

    def get_downloaded_logs(self) -> List[Dict[str, Any]]:
        """获取已下载的日志列表 - 正确显示实际节点"""
        try:
            downloaded_logs: List[Dict[str, Any]] = []
            seen_files = set()

            if not os.path.exists(self.download_dir):
                return []

            for root, dirs, files in os.walk(self.download_dir):
                for file in files:
                    if not file.startswith("tcp_trace"):
                        continue
                    file_path = os.path.abspath(os.path.join(root, file))
                    if file_path in seen_files:
                        continue
                    seen_files.add(file_path)

                    relative_path = os.path.relpath(file_path, self.download_dir)
                    parts = relative_path.split(os.sep)

                    if len(parts) >= 3:
                        factory, system, actual_node = parts[:3]
                    else:
                        factory, system = "未知厂区", "未知系统"
                        actual_node = self._extract_node_from_filename(file)

                    file_id = hashlib.md5(file_path.encode()).hexdigest()[:8]

                    metadata = self._read_metadata(file_path)
                    factory = metadata.get("factory") or factory
                    system = metadata.get("system") or system
                    actual_node = metadata.get("node") or actual_node
                    download_time = (
                        metadata.get("download_time")
                        or metadata.get("timestamp")
                        or datetime.fromtimestamp(os.path.getctime(file_path)).isoformat()
                    )
                    log_time = (
                        metadata.get("log_time")
                        or metadata.get("source_mtime")
                        or metadata.get("remote_mtime")
                        or ""
                    )

                    downloaded_logs.append(
                        {
                            "id": file_id,
                            "path": file_path,
                            "name": file,
                            "factory": factory,
                            "system": system,
                            "node": actual_node,
                            "timestamp": download_time,
                            "download_time": download_time,
                            "log_time": log_time,
                            "source_mtime": log_time,
                            "size": os.path.getsize(file_path),
                        }
                    )

            downloaded_logs.sort(key=lambda x: x.get("download_time") or x.get("timestamp"), reverse=True)
            self.logger.info(f"获取已下载日志完成，共{len(downloaded_logs)}个文件")
            return downloaded_logs
        except Exception as e:
            self.logger.error(f"获取已下载日志失败: {str(e)}")
            return []

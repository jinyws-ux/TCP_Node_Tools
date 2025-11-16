"""Utilities that keep the download-related view/controller code small."""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

from core.log_downloader import LogDownloader
from core.template_manager import TemplateManager


class DownloadService:
    """High level helpers used by the download tab HTTP handlers."""

    def __init__(self, downloader: LogDownloader, templates: TemplateManager):
        self._downloader = downloader
        self._templates = templates

    # ------------------------------------------------------------------
    def search(
        self,
        *,
        factory: str,
        system: str,
        nodes: Optional[Iterable[str]] = None,
        node: Optional[str] = None,
        include_realtime: bool = True,
        include_archive: bool = False,
        date_start: Optional[str] = None,
        date_end: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Search logs with manual inputs."""

        self._require_factory_system(factory, system)
        normalized_nodes = self._merge_nodes(nodes, node)
        self._validate_date_range(include_archive, date_start, date_end)

        if not normalized_nodes:
            raise ValueError("必须填写节点")

        if len(normalized_nodes) > 1:
            logs = self._downloader.search_logs_many_nodes(
                factory=factory,
                system=system,
                nodes=normalized_nodes,
                include_realtime=include_realtime,
                include_archive=include_archive,
                date_start=date_start,
                date_end=date_end,
            )
        else:
            single_node = normalized_nodes[0] if normalized_nodes else ""
            logs = self._downloader.search_logs(
                factory=factory,
                system=system,
                node=single_node,
                include_realtime=include_realtime,
                include_archive=include_archive,
                date_start=date_start,
                date_end=date_end,
            )
        return self._normalize_log_payloads(logs)

    def search_with_template(
        self,
        *,
        template_id: str,
        include_realtime: bool = True,
        include_archive: bool = False,
        date_start: Optional[str] = None,
        date_end: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        template = self._templates.get(template_id)
        if not template:
            raise ValueError("模板不存在")

        factory = template.get("factory_name") or template.get("factory")
        system = template.get("system_name") or template.get("system")
        nodes = template.get("nodes") or []
        return self.search(
            factory=factory or "",
            system=system or "",
            nodes=nodes,
            include_realtime=include_realtime,
            include_archive=include_archive,
            date_start=date_start,
            date_end=date_end,
        )

    def download(
        self,
        *,
        files: List[Dict[str, Any]],
        factory: str,
        system: str,
        nodes: Optional[Iterable[str]] = None,
        node: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        self._require_factory_system(factory, system)
        if not files:
            raise ValueError("缺少日志文件列表")

        normalized_nodes = self._merge_nodes(nodes, node)
        search_node = normalized_nodes[0] if normalized_nodes else None

        return self._downloader.download_logs(
            log_files=files,
            factory=factory,
            system=system,
            search_node=search_node,
            search_nodes=normalized_nodes,
        )

    # ------------------------------------------------------------------
    def _require_factory_system(self, factory: Optional[str], system: Optional[str]) -> None:
        if not factory or not system:
            raise ValueError("缺少厂区或系统参数")

    def _merge_nodes(
        self,
        nodes: Optional[Iterable[str]],
        node: Optional[str],
    ) -> List[str]:
        merged: List[str] = []
        seen = set()

        def _push(value: Optional[str]) -> None:
            if value is None:
                return
            text = str(value).strip()
            if not text or text in seen:
                return
            seen.add(text)
            merged.append(text)

        if nodes is not None:
            for item in nodes:
                _push(item)
        _push(node)
        return merged

    def _validate_date_range(
        self,
        include_archive: bool,
        date_start: Optional[str],
        date_end: Optional[str],
    ) -> None:
        if include_archive and (not date_start or not date_end):
            raise ValueError("归档搜索需要提供开始和结束日期")

    def _normalize_log_payloads(self, logs: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
        normalized: List[Dict[str, Any]] = []
        for item in logs or []:
            payload = dict(item)
            path = payload.get("remote_path") or payload.get("path") or payload.get("name", "")
            payload.setdefault("remote_path", path)
            payload["path"] = path
            normalized.append(payload)
        return normalized

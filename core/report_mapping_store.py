"""报告映射存储 - 统一管理日志到报告的对应关系。"""
from __future__ import annotations

import logging
import os
from typing import Dict, Iterable, List, Set

from .json_store import JsonStore


class ReportMappingStore:
    """简单的 JSON 映射仓库，负责读取/写入 report_mappings.json。"""

    def __init__(self, filepath: str):
        self.filepath = filepath
        self.logger = logging.getLogger(__name__)
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        self._store = JsonStore(filepath, default_factory=dict)

    def _load(self) -> Dict[str, List[str]]:
        mapping = self._store.load()
        # 确保所有值都是列表
        for key in mapping:
            if not isinstance(mapping[key], list):
                # 如果是旧格式（字符串），转换为列表
                mapping[key] = [mapping[key]] if mapping[key] else []
        return mapping

    def _save(self, mapping: Dict[str, List[str]]) -> None:
        if not self._store.save(mapping):
            self.logger.error("保存报告映射失败: %s", self.filepath)

    def save_many(self, log_paths: Iterable[str], report_path: str) -> None:
        mapping = self._load()
        for path in log_paths:
            if path:
                if path not in mapping:
                    mapping[path] = []
                # 确保报告路径不重复
                if report_path not in mapping[path]:
                    mapping[path].append(report_path)
        self._save(mapping)

    def get(self, log_path: str) -> List[str]:
        return self._load().get(log_path, [])

    def delete(self, log_path: str) -> None:
        mapping = self._load()
        if log_path in mapping:
            mapping.pop(log_path)
            self._save(mapping)

    def delete_many(self, log_paths: Iterable[str]) -> None:
        mapping = self._load()
        changed = False
        for path in log_paths:
            if path in mapping:
                mapping.pop(path)
                changed = True
        if changed:
            self._save(mapping)

    def delete_report(self, report_path: str) -> None:
        """删除特定报告路径从所有日志映射中"""
        mapping = self._load()
        changed = False
        for log_path in mapping:
            if report_path in mapping[log_path]:
                mapping[log_path].remove(report_path)
                # 如果日志没有更多报告，移除该日志的映射
                if not mapping[log_path]:
                    mapping.pop(log_path)
                changed = True
        if changed:
            self._save(mapping)

    def get_all_reports(self) -> Set[str]:
        """获取所有唯一的报告路径"""
        mapping = self._load()
        reports = set()
        for report_list in mapping.values():
            reports.update(report_list)
        return reports

    def get_related_logs(self, report_path: str) -> List[str]:
        """获取与特定报告关联的所有日志路径"""
        mapping = self._load()
        related_logs = []
        for log_path, report_list in mapping.items():
            if report_path in report_list:
                related_logs.append(log_path)
        return related_logs

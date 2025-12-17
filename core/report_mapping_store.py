"""报告映射存储 - 统一管理日志到报告的对应关系。"""
from __future__ import annotations

import logging
import os
from typing import Dict, Iterable

from .json_store import JsonStore


class ReportMappingStore:
    """简单的 JSON 映射仓库，负责读取/写入 report_mappings.json。"""

    def __init__(self, filepath: str):
        self.filepath = filepath
        self.logger = logging.getLogger(__name__)
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        self._store = JsonStore(filepath, default_factory=dict)

    def _load(self) -> Dict[str, str]:
        return self._store.load()

    def _save(self, mapping: Dict[str, str]) -> None:
        if not self._store.save(mapping):
            self.logger.error("保存报告映射失败: %s", self.filepath)

    def save_many(self, log_paths: Iterable[str], report_path: str) -> None:
        mapping = self._load()
        for path in log_paths:
            if path:
                mapping[path] = report_path
        self._save(mapping)

    def get(self, log_path: str) -> str:
        return self._load().get(log_path, "")

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

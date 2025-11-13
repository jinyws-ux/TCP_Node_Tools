"""报告映射存储 - 统一管理日志到报告的对应关系。"""
from __future__ import annotations

import json
import logging
import os
from typing import Dict, Iterable


class ReportMappingStore:
    """简单的 JSON 映射仓库，负责读取/写入 report_mappings.json。"""

    def __init__(self, filepath: str):
        self.filepath = filepath
        self.logger = logging.getLogger(__name__)
        os.makedirs(os.path.dirname(filepath), exist_ok=True)

    def _load(self) -> Dict[str, str]:
        if not os.path.exists(self.filepath):
            return {}
        try:
            with open(self.filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
        except Exception as exc:  # pragma: no cover - 记录即可
            self.logger.error("加载报告映射失败: %s", exc)
        return {}

    def _save(self, mapping: Dict[str, str]) -> None:
        try:
            tmp_path = f"{self.filepath}.tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(mapping, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, self.filepath)
        except Exception as exc:  # pragma: no cover - 记录即可
            self.logger.error("保存报告映射失败: %s", exc)

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

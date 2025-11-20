"""Utility helpers for storing log metadata alongside downloaded files."""
from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional


class LogMetadataStore:
    """Persist per-log metadata either next to the files or in a dedicated directory."""

    def __init__(self, download_dir: str, metadata_dir: Optional[str] = None) -> None:
        self.download_dir = os.path.abspath(download_dir)
        self.metadata_dir = os.path.abspath(metadata_dir or download_dir)
        os.makedirs(self.metadata_dir, exist_ok=True)

    # ------------------------------------------------------------------
    def path_for(self, log_path: str, *, ensure_dir: bool = True) -> str:
        """Return the metadata path for a downloaded log file."""
        abs_log_path = os.path.abspath(log_path)
        if self.metadata_dir == self.download_dir:
            return f"{abs_log_path}.meta.json"

        rel_path = self._safe_relative_path(abs_log_path)
        rel_dir = os.path.dirname(rel_path)
        meta_dir = os.path.join(self.metadata_dir, rel_dir)
        if ensure_dir:
            os.makedirs(meta_dir, exist_ok=True)
        filename = os.path.basename(rel_path)
        return os.path.join(meta_dir, f"{filename}.meta.json")

    def read(self, log_path: str) -> Dict[str, Any]:
        """Load metadata for the given log path (fallback to legacy location)."""
        candidates = [self.path_for(log_path, ensure_dir=False)]
        legacy = f"{os.path.abspath(log_path)}.meta.json"
        if legacy not in candidates:
            candidates.append(legacy)

        for meta_path in candidates:
            if not meta_path or not os.path.exists(meta_path):
                continue
            try:
                with open(meta_path, "r", encoding="utf-8") as handle:
                    data = json.load(handle)
                    return data if isinstance(data, dict) else {}
            except Exception:
                continue
        return {}

    def write(self, log_path: str, payload: Dict[str, Any]) -> None:
        meta_path = self.path_for(log_path, ensure_dir=True)
        with open(meta_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)

    def delete(self, log_path: str) -> None:
        targets = [self.path_for(log_path, ensure_dir=False)]
        legacy = f"{os.path.abspath(log_path)}.meta.json"
        if legacy not in targets:
            targets.append(legacy)
        for meta_path in targets:
            if not meta_path or not os.path.exists(meta_path):
                continue
            try:
                os.remove(meta_path)
            except OSError:
                pass

    # ------------------------------------------------------------------
    def _safe_relative_path(self, abs_log_path: str) -> str:
        try:
            rel = os.path.relpath(abs_log_path, self.download_dir)
        except ValueError:
            rel = os.path.basename(abs_log_path)
        if rel.startswith(".."):
            rel = os.path.basename(abs_log_path)
        return rel

"""通用的 JSON 文件存储帮助类，提供缓存与原子写入能力。"""
from __future__ import annotations

import copy
import json
import os
import tempfile
import threading
from typing import Callable, Generic, Optional, TypeVar


T = TypeVar("T")


class JsonStore(Generic[T]):
    """封装 JSON 文件的读写，带缓存、线程安全与原子写入。"""

    def __init__(
        self,
        filepath: str,
        default_factory: Callable[[], T],
        *,
        encoding: str = "utf-8",
        enable_cache: bool = True,
    ) -> None:
        self.filepath = filepath
        self._default_factory = default_factory
        self._encoding = encoding
        self._enable_cache = enable_cache
        self._lock = threading.RLock()
        self._data_type = type(self._default_factory())
        self._cache: Optional[T] = None
        self._cache_mtime: Optional[float] = None
        os.makedirs(os.path.dirname(filepath) or ".", exist_ok=True)

    # ------------------------------------------------------------------ #
    def load(self) -> T:
        """读取 JSON 数据（命中缓存直接返回深拷贝）。"""
        with self._lock:
            if self._enable_cache:
                cached = self._try_load_from_cache()
                if cached is not None:
                    return copy.deepcopy(cached)

            data = self._read_from_disk()
            self._update_cache(data)
            return copy.deepcopy(data)

    def save(self, data: T) -> bool:
        """以原子方式写入 JSON 数据，并刷新缓存。"""
        payload = copy.deepcopy(data)
        with self._lock:
            temp_path = None
            try:
                dirpath = os.path.dirname(self.filepath) or "."
                with tempfile.NamedTemporaryFile(
                    mode="w",
                    encoding=self._encoding,
                    delete=False,
                    dir=dirpath,
                ) as handle:
                    json.dump(payload, handle, ensure_ascii=False, indent=2)
                    temp_path = handle.name
                os.replace(temp_path, self.filepath)
                self._update_cache(payload)
                self._cache_mtime = self._safe_mtime()
                return True
            except Exception:
                if temp_path and os.path.exists(temp_path):
                    try:
                        os.remove(temp_path)
                    except OSError:
                        pass
                return False

    # ------------------------------------------------------------------ #
    def _try_load_from_cache(self) -> Optional[T]:
        if self._cache is None:
            return None
        current_mtime = self._safe_mtime()
        if self._cache_mtime is None and current_mtime is None:
            return self._cache
        if current_mtime == self._cache_mtime:
            return self._cache
        return None

    def _read_from_disk(self) -> T:
        if not os.path.exists(self.filepath):
            return self._default_factory()
        try:
            with open(self.filepath, "r", encoding=self._encoding) as handle:
                data = json.load(handle)
                if isinstance(data, self._data_type):
                    return data
        except Exception:
            pass
        return self._default_factory()

    def _update_cache(self, data: T) -> None:
        self._cache = copy.deepcopy(data)
        self._cache_mtime = self._safe_mtime()

    def _safe_mtime(self) -> Optional[float]:
        try:
            return os.path.getmtime(self.filepath)
        except OSError:
            return None



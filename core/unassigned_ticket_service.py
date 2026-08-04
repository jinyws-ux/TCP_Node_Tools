"""Read-only PostgreSQL access and caching for unassigned Helix tickets."""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import date, datetime
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional


DEFAULT_QUERY = """
SELECT
    id,
    ticket_type,
    summary,
    priority,
    submit_time
FROM remedy_ticket
WHERE assign_group = 'IT Control Center L2'
  AND status != 'Cancelled'
  AND assignee IS NULL
ORDER BY submit_time DESC NULLS LAST
""".strip()


class TicketDatabaseNotConfigured(RuntimeError):
    """Raised when the server has no usable PostgreSQL configuration."""


class TicketQueryFailed(RuntimeError):
    """Raised when PostgreSQL cannot be queried and no cached result exists."""


def _as_positive_int(value: Any, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _load_json(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError):
        return {}


def load_ticket_database_config(project_root: str) -> Dict[str, Any]:
    """Load server-only PostgreSQL settings without requiring secrets in git."""

    config_path = os.environ.get("UNASSIGNED_TICKET_DB_CONFIG")
    if not config_path:
        config_path = os.path.join(project_root, "configs", "unassigned_tickets.json")

    config = _load_json(os.path.abspath(config_path))
    env_dsn = (os.environ.get("UNASSIGNED_TICKET_DB_DSN") or "").strip()
    if env_dsn:
        config["dsn"] = env_dsn

    password_env = str(config.get("passwordEnv") or "UNASSIGNED_TICKET_DB_PASSWORD").strip()
    env_password = os.environ.get(password_env) if password_env else None
    if env_password:
        config["password"] = env_password

    return config


def _serialize_value(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def _normalize_ticket_type(value: Any) -> str:
    raw = str(value or "").strip()
    compact = raw.replace(" ", "").replace("_", "").lower()
    if compact in {"incident", "inc"}:
        return "INC"
    if compact in {"workorder", "wo"}:
        return "WO"
    return raw.upper() or "OTHER"


class UnassignedTicketService:
    """Query unassigned tickets and share a bounded cache between web clients."""

    def __init__(
        self,
        config: Optional[Mapping[str, Any]] = None,
        *,
        query_executor: Optional[Callable[[], Iterable[Mapping[str, Any]]]] = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.config: Dict[str, Any] = dict(config or {})
        self.cache_seconds = _as_positive_int(self.config.get("cacheSeconds"), 300)
        self.min_force_interval_seconds = _as_positive_int(
            self.config.get("minForceIntervalSeconds"), 10
        )
        self._query_executor = query_executor
        self._clock = clock
        self._lock = threading.Lock()
        self._cached_snapshot: Optional[Dict[str, Any]] = None
        self._expires_at = 0.0
        self._last_query_attempt = 0.0

    @classmethod
    def from_environment(cls, project_root: str) -> "UnassignedTicketService":
        return cls(load_ticket_database_config(project_root))

    @property
    def configured(self) -> bool:
        if self._query_executor is not None:
            return True
        if str(self.config.get("dsn") or "").strip():
            return True
        required = ("host", "dbname", "user")
        return all(str(self.config.get(key) or "").strip() for key in required)

    def get_snapshot(self, *, force: bool = False) -> Dict[str, Any]:
        if not self.configured:
            raise TicketDatabaseNotConfigured("PostgreSQL尚未配置")

        now = self._clock()
        if self._cached_snapshot is not None:
            if not force and now < self._expires_at:
                return self._copy_snapshot(self._cached_snapshot, source="cache")
            if force and now - self._last_query_attempt < self.min_force_interval_seconds:
                return self._copy_snapshot(self._cached_snapshot, source="cache")

        with self._lock:
            now = self._clock()
            if self._cached_snapshot is not None:
                if not force and now < self._expires_at:
                    return self._copy_snapshot(self._cached_snapshot, source="cache")
                if force and now - self._last_query_attempt < self.min_force_interval_seconds:
                    return self._copy_snapshot(self._cached_snapshot, source="cache")

            self._last_query_attempt = now
            try:
                rows = list(self._execute_query())
                snapshot = self._build_snapshot(rows)
                self._cached_snapshot = snapshot
                self._expires_at = self._clock() + self.cache_seconds
                return self._copy_snapshot(snapshot, source="database")
            except Exception as exc:
                if self._cached_snapshot is not None:
                    stale = self._copy_snapshot(self._cached_snapshot, source="stale-cache")
                    stale["stale"] = True
                    stale["error"] = "数据库查询失败，当前显示上次成功结果"
                    return stale
                raise TicketQueryFailed("数据库查询失败") from exc

    def _execute_query(self) -> Iterable[Mapping[str, Any]]:
        if self._query_executor is not None:
            return self._query_executor()

        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:
            raise RuntimeError("缺少psycopg依赖") from exc

        connect_timeout = _as_positive_int(self.config.get("connectTimeoutSeconds"), 5)
        statement_timeout = _as_positive_int(self.config.get("statementTimeoutMs"), 8000)
        options = (
            "-c default_transaction_read_only=on "
            f"-c statement_timeout={statement_timeout}"
        )

        dsn = str(self.config.get("dsn") or "").strip()
        kwargs: Dict[str, Any] = {
            "connect_timeout": connect_timeout,
            "options": options,
            "row_factory": dict_row,
        }
        if dsn:
            connection_args = (dsn,)
        else:
            connection_args = ()
            kwargs.update(
                host=str(self.config.get("host") or "").strip(),
                port=_as_positive_int(self.config.get("port"), 5432),
                dbname=str(self.config.get("dbname") or "").strip(),
                user=str(self.config.get("user") or "").strip(),
                password=str(self.config.get("password") or ""),
            )

        with psycopg.connect(*connection_args, **kwargs) as connection:
            with connection.cursor() as cursor:
                cursor.execute(DEFAULT_QUERY)
                return list(cursor.fetchall())

    def _build_snapshot(self, rows: Iterable[Mapping[str, Any]]) -> Dict[str, Any]:
        items: List[Dict[str, Any]] = []
        for row in rows:
            raw_type = row.get("ticket_type")
            ticket_id = str(row.get("id") or "").strip()
            if not ticket_id:
                continue
            items.append(
                {
                    "id": ticket_id,
                    "type": _normalize_ticket_type(raw_type),
                    "raw_type": str(raw_type or "").strip(),
                    "summary": str(row.get("summary") or "").strip(),
                    "priority": str(row.get("priority") or "").strip(),
                    "submit_time": _serialize_value(row.get("submit_time")),
                }
            )

        items.sort(key=lambda item: str(item.get("submit_time") or ""), reverse=True)
        inc_count = sum(1 for item in items if item["type"] == "INC")
        wo_count = sum(1 for item in items if item["type"] == "WO")
        return {
            "success": True,
            "counts": {"total": len(items), "inc": inc_count, "wo": wo_count},
            "items": items,
            "refreshed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "stale": False,
            "error": None,
        }

    @staticmethod
    def _copy_snapshot(snapshot: Mapping[str, Any], *, source: str) -> Dict[str, Any]:
        copied = dict(snapshot)
        copied["counts"] = dict(snapshot.get("counts") or {})
        copied["items"] = [dict(item) for item in snapshot.get("items") or []]
        copied["source"] = source
        return copied

"""Read-only PostgreSQL access and risk calculation for active SLA tickets."""

from __future__ import annotations

import threading
import time
from datetime import datetime
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional

from core.unassigned_ticket_service import (
    TicketDatabaseNotConfigured,
    TicketQueryFailed,
    _as_positive_int,
    _normalize_ticket_type,
    _serialize_value,
    load_ticket_database_config,
)


DEFAULT_SLA_QUERY = """
SELECT
    id,
    ticket_type,
    summary,
    priority,
    status,
    assignee,
    submit_time,
    limit_time
FROM remedy_ticket
WHERE assign_group = 'IT Control Center L2'
  AND status IN ('Assigned', 'In Progress')
  AND submit_time IS NOT NULL
  AND limit_time IS NOT NULL
  AND limit_time > submit_time
ORDER BY limit_time ASC
""".strip()


def _as_datetime(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        text = value.strip().replace("Z", "+00:00")
        if text:
            try:
                return datetime.fromisoformat(text)
            except ValueError:
                return None
    return None


def _seconds_label(seconds: int) -> str:
    overdue = seconds < 0
    value = abs(seconds)
    if value < 60:
        amount = "不足1分钟"
    elif value < 3600:
        amount = f"{value // 60}分钟"
    elif value < 86400:
        hours = value // 3600
        minutes = (value % 3600) // 60
        amount = f"{hours}小时" + (f"{minutes}分钟" if minutes else "")
    else:
        days = value // 86400
        hours = (value % 86400) // 3600
        amount = f"{days}天" + (f"{hours}小时" if hours else "")
    return ("已超时" if overdue else "剩余") + amount


class SlaRiskService:
    """Return active ITCC L2 tickets that have consumed at least 75% of SLA."""

    def __init__(
        self,
        config: Optional[Mapping[str, Any]] = None,
        *,
        query_executor: Optional[Callable[[], Iterable[Mapping[str, Any]]]] = None,
        clock: Callable[[], float] = time.monotonic,
        now_provider: Callable[[], datetime] = lambda: datetime.now().astimezone(),
    ) -> None:
        self.config: Dict[str, Any] = dict(config or {})
        self.cache_seconds = _as_positive_int(self.config.get("slaCacheSeconds"), 60)
        self.min_force_interval_seconds = _as_positive_int(
            self.config.get("minForceIntervalSeconds"), 10
        )
        self._query_executor = query_executor
        self._clock = clock
        self._now_provider = now_provider
        self._lock = threading.Lock()
        self._cached_snapshot: Optional[Dict[str, Any]] = None
        self._expires_at = 0.0
        self._last_query_attempt = 0.0

    @classmethod
    def from_environment(cls, project_root: str) -> "SlaRiskService":
        return cls(load_ticket_database_config(project_root))

    @property
    def configured(self) -> bool:
        if self._query_executor is not None:
            return True
        if str(self.config.get("dsn") or "").strip():
            return True
        return all(str(self.config.get(key) or "").strip() for key in ("host", "dbname", "user"))

    def get_snapshot(self, *, force: bool = False) -> Dict[str, Any]:
        if not self.configured:
            raise TicketDatabaseNotConfigured("PostgreSQL尚未配置")

        now = self._clock()
        if self._cached_snapshot is not None:
            if not force and now < self._expires_at:
                return self._copy_snapshot(self._cached_snapshot, "cache")
            if force and now - self._last_query_attempt < self.min_force_interval_seconds:
                return self._copy_snapshot(self._cached_snapshot, "cache")

        with self._lock:
            now = self._clock()
            if self._cached_snapshot is not None:
                if not force and now < self._expires_at:
                    return self._copy_snapshot(self._cached_snapshot, "cache")
                if force and now - self._last_query_attempt < self.min_force_interval_seconds:
                    return self._copy_snapshot(self._cached_snapshot, "cache")

            self._last_query_attempt = now
            try:
                snapshot = self._build_snapshot(self._execute_query(), self._now_provider())
                self._cached_snapshot = snapshot
                self._expires_at = self._clock() + self.cache_seconds
                return self._copy_snapshot(snapshot, "database")
            except Exception as exc:
                if self._cached_snapshot is not None:
                    stale = self._copy_snapshot(self._cached_snapshot, "stale-cache")
                    stale["stale"] = True
                    stale["error"] = "SLA查询失败，当前显示上次成功结果"
                    return stale
                raise TicketQueryFailed("SLA工单数据库查询失败") from exc

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
        options = f"-c default_transaction_read_only=on -c statement_timeout={statement_timeout}"
        kwargs: Dict[str, Any] = {
            "connect_timeout": connect_timeout,
            "options": options,
            "row_factory": dict_row,
        }
        dsn = str(self.config.get("dsn") or "").strip()
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

        query = str(self.config.get("slaRiskQuery") or DEFAULT_SLA_QUERY).strip()
        with psycopg.connect(*connection_args, **kwargs) as connection:
            with connection.cursor() as cursor:
                cursor.execute(query)
                return list(cursor.fetchall())

    def _build_snapshot(
        self, rows: Iterable[Mapping[str, Any]], current_time: datetime
    ) -> Dict[str, Any]:
        items: List[Dict[str, Any]] = []
        for row in rows:
            ticket_id = str(row.get("id") or "").strip()
            status = str(row.get("status") or "").strip()
            if status.lower() not in {"assigned", "in progress"}:
                continue
            submit_time = _as_datetime(row.get("submit_time"))
            limit_time = _as_datetime(row.get("limit_time"))
            if not ticket_id or submit_time is None or limit_time is None:
                continue
            if submit_time.tzinfo is None and current_time.tzinfo is not None:
                submit_time = submit_time.replace(tzinfo=current_time.tzinfo)
            if limit_time.tzinfo is None and current_time.tzinfo is not None:
                limit_time = limit_time.replace(tzinfo=current_time.tzinfo)
            total_seconds = (limit_time - submit_time).total_seconds()
            if total_seconds <= 0:
                continue
            elapsed_seconds = (current_time - submit_time).total_seconds()
            progress = elapsed_seconds / total_seconds * 100.0
            if progress < 75.0:
                continue

            remaining_seconds = int((limit_time - current_time).total_seconds())
            if remaining_seconds <= 0:
                risk_level = "breached"
            elif progress >= 90.0:
                risk_level = "critical"
            else:
                risk_level = "warning"
            raw_type = row.get("ticket_type")
            items.append(
                {
                    "id": ticket_id,
                    "type": _normalize_ticket_type(raw_type),
                    "raw_type": str(raw_type or "").strip(),
                    "summary": str(row.get("summary") or "").strip(),
                    "priority": str(row.get("priority") or "").strip(),
                    "status": status,
                    "assignee": str(row.get("assignee") or "").strip(),
                    "submit_time": _serialize_value(submit_time),
                    "limit_time": _serialize_value(limit_time),
                    "progress_percent": round(progress, 1),
                    "remaining_seconds": remaining_seconds,
                    "remaining_text": _seconds_label(remaining_seconds),
                    "risk_level": risk_level,
                }
            )

        severity = {"breached": 0, "critical": 1, "warning": 2}
        items.sort(key=lambda item: (severity[item["risk_level"]], item["remaining_seconds"]))
        return {
            "success": True,
            "counts": {
                "total": len(items),
                "warning": sum(item["risk_level"] == "warning" for item in items),
                "critical": sum(item["risk_level"] == "critical" for item in items),
                "breached": sum(item["risk_level"] == "breached" for item in items),
                "inc": sum(item["type"] == "INC" for item in items),
                "wo": sum(item["type"] == "WO" for item in items),
            },
            "items": items,
            "refreshed_at": current_time.isoformat(timespec="seconds"),
            "stale": False,
            "error": None,
        }

    @staticmethod
    def _copy_snapshot(snapshot: Mapping[str, Any], source: str) -> Dict[str, Any]:
        copied = dict(snapshot)
        copied["counts"] = dict(snapshot.get("counts") or {})
        copied["items"] = [dict(item) for item in snapshot.get("items") or []]
        copied["source"] = source
        return copied

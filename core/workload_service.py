"""Monthly workload calculation in workday units.

JIRA story points and ticket work are deliberately kept behind two small data
source adapters.  The UI and calculation can therefore be delivered before the
project-specific JIRA field and ticket SQL are known.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

from core.unassigned_ticket_service import (
    _as_positive_int,
    _load_json,
    load_ticket_database_config,
)


UF_NUMBER_PATTERN = re.compile(r"^[A-Za-z0-9_.@-]{1,64}$")
MONTH_PATTERN = re.compile(r"^(\d{4})-(\d{2})$")
DEFAULT_TICKET_DAYS = 2.69 / 8.0


class InvalidWorkloadRequest(ValueError):
    """Raised when employee or month input is invalid."""


def load_workload_config(project_root: str) -> Dict[str, Any]:
    config_path = os.environ.get("WORKLOAD_CONFIG")
    if not config_path:
        config_path = os.path.join(project_root, "configs", "workload.json")
    config = _load_json(os.path.abspath(config_path))
    # Reuse the existing read-only PostgreSQL connection unless workload.json
    # explicitly provides a different database under ticket.database.
    config["_defaultTicketDatabase"] = load_ticket_database_config(project_root)
    return config


def _as_number(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 0 else default


def _rounded(value: float) -> float:
    return round(float(value), 4)


def _month_bounds(month: str) -> Tuple[date, date]:
    match = MONTH_PATTERN.fullmatch(str(month or "").strip())
    if not match:
        raise InvalidWorkloadRequest("月份格式必须为YYYY-MM")
    year, month_number = int(match.group(1)), int(match.group(2))
    if not 1 <= month_number <= 12:
        raise InvalidWorkloadRequest("月份格式必须为YYYY-MM")
    first = date(year, month_number, 1)
    if month_number == 12:
        following = date(year + 1, 1, 1)
    else:
        following = date(year, month_number + 1, 1)
    return first, following


def _date_set(values: Any) -> set[date]:
    result: set[date] = set()
    if not isinstance(values, list):
        return result
    for value in values:
        try:
            result.add(date.fromisoformat(str(value).strip()))
        except (TypeError, ValueError):
            continue
    return result


class WorkCalendar:
    """Calculate target days from weekdays plus company calendar overrides."""

    def __init__(self, config: Optional[Mapping[str, Any]] = None) -> None:
        self.config = dict(config or {})
        weekend_values = self.config.get("weekendDays", [5, 6])
        if not isinstance(weekend_values, list):
            weekend_values = [5, 6]
        self.weekend_days = {
            int(value) for value in weekend_values
            if isinstance(value, int) or str(value).isdigit()
        }
        self.holidays = _date_set(self.config.get("holidays"))
        self.extra_workdays = _date_set(self.config.get("extraWorkdays"))
        overrides = self.config.get("monthlyTargetOverrides")
        self.monthly_overrides = dict(overrides) if isinstance(overrides, dict) else {}

    def is_workday(self, value: date) -> bool:
        if value in self.extra_workdays:
            return True
        if value in self.holidays:
            return False
        return value.weekday() not in self.weekend_days

    def target_days(self, month: str) -> Tuple[float, str]:
        override = self.monthly_overrides.get(month)
        if override is not None:
            return _as_number(override), "monthly_override"
        start, end = _month_bounds(month)
        value = start
        total = 0
        while value < end:
            if self.is_workday(value):
                total += 1
            value += timedelta(days=1)
        return float(total), "work_calendar"

    def elapsed_target_days(self, month: str, today: date) -> float:
        start, end = _month_bounds(month)
        if today < start:
            return 0.0
        last = min(today, end - timedelta(days=1))
        value = start
        total = 0
        while value <= last:
            if self.is_workday(value):
                total += 1
            value += timedelta(days=1)
        target, source = self.target_days(month)
        # A monthly manual override has no day-by-day shape.  Scale the elapsed
        # weekday ratio so pace remains meaningful without inventing dates.
        if source == "monthly_override":
            raw_month = self._raw_weekdays(start, end)
            raw_elapsed = self._raw_weekdays(start, last + timedelta(days=1))
            return min(target, target * raw_elapsed / raw_month) if raw_month else 0.0
        return min(target, float(total))

    def _raw_weekdays(self, start: date, end: date) -> int:
        value = start
        total = 0
        while value < end:
            if value.weekday() not in self.weekend_days:
                total += 1
            value += timedelta(days=1)
        return total


class WorkloadService:
    """Combine monthly JIRA story points and completed-ticket workload."""

    def __init__(
        self,
        config: Optional[Mapping[str, Any]] = None,
        *,
        jira_executor: Optional[Callable[[str, date, date], Tuple[int, float]]] = None,
        ticket_executor: Optional[Callable[[str, date, date], int]] = None,
        clock: Callable[[], float] = time.monotonic,
        today_provider: Callable[[], date] = date.today,
    ) -> None:
        self.config: Dict[str, Any] = dict(config or {})
        self.cache_seconds = _as_positive_int(self.config.get("cacheSeconds"), 300)
        self.min_force_interval_seconds = _as_positive_int(
            self.config.get("minForceIntervalSeconds"), 10
        )
        self.ticket_days = _as_number(
            self.config.get("ticketDaysPerTicket"), DEFAULT_TICKET_DAYS
        ) or DEFAULT_TICKET_DAYS
        self.calendar = WorkCalendar(self.config.get("calendar"))
        self._jira_executor = jira_executor
        self._ticket_executor = ticket_executor
        self._clock = clock
        self._today_provider = today_provider
        self._lock = threading.Lock()
        self._cache: Dict[Tuple[str, str, str], Tuple[float, Dict[str, Any]]] = {}
        self._last_attempt: Dict[Tuple[str, str, str], float] = {}

    @classmethod
    def from_environment(cls, project_root: str) -> "WorkloadService":
        return cls(load_workload_config(project_root))

    def get_summary(
        self,
        uf_number: str,
        assignee: str,
        month: str,
        *,
        force: bool = False,
    ) -> Dict[str, Any]:
        uf_number = str(uf_number or "").strip()
        assignee = str(assignee or "").strip()
        if not UF_NUMBER_PATTERN.fullmatch(uf_number):
            raise InvalidWorkloadRequest("UF号只能包含字母、数字、点、横线、下划线或@")
        if not assignee or len(assignee) > 256 or any(ord(char) < 32 for char in assignee):
            raise InvalidWorkloadRequest("Remedy用户名不能为空且不能包含控制字符")
        month_start, next_month_start = _month_bounds(month)
        month = month_start.strftime("%Y-%m")
        key = (uf_number, assignee, month)
        now = self._clock()
        cached = self._cache.get(key)
        if cached is not None:
            expires_at, snapshot = cached
            if not force and now < expires_at:
                return self._copy_summary(snapshot, "cache")
            if force and now - self._last_attempt.get(key, 0.0) < self.min_force_interval_seconds:
                return self._copy_summary(snapshot, "cache")

        with self._lock:
            now = self._clock()
            cached = self._cache.get(key)
            if cached is not None:
                expires_at, snapshot = cached
                if not force and now < expires_at:
                    return self._copy_summary(snapshot, "cache")
                if force and now - self._last_attempt.get(key, 0.0) < self.min_force_interval_seconds:
                    return self._copy_summary(snapshot, "cache")
            self._last_attempt[key] = now
            snapshot = self._build_summary(
                uf_number,
                assignee,
                month,
                month_start,
                next_month_start,
            )
            self._cache[key] = (self._clock() + self.cache_seconds, snapshot)
            return self._copy_summary(snapshot, "sources")

    def _build_summary(
        self,
        uf_number: str,
        assignee: str,
        month: str,
        month_start: date,
        next_month_start: date,
    ) -> Dict[str, Any]:
        target_days, target_source = self.calendar.target_days(month)
        elapsed_target = self.calendar.elapsed_target_days(month, self._today_provider())

        jira = self._load_jira(uf_number, month_start, next_month_start)
        tickets = self._load_tickets(assignee, month_start, next_month_start)
        complete = jira["status"] == "ok" and tickets["status"] == "ok"
        total_days: Optional[float] = None
        completion: Optional[float] = None
        pace: Optional[float] = None
        remaining: Optional[float] = None
        if complete:
            total_days = _rounded(jira["days"] + tickets["days"])
            completion = round(total_days / target_days * 100.0, 1) if target_days else 0.0
            pace = round(total_days / elapsed_target * 100.0, 1) if elapsed_target else 0.0
            remaining = _rounded(max(0.0, target_days - total_days))

        return {
            "success": True,
            "complete": complete,
            "uf_number": uf_number,
            "assignee": assignee,
            "month": month,
            "unit": "day",
            "target_days": _rounded(target_days),
            "elapsed_target_days": _rounded(elapsed_target),
            "target_source": target_source,
            "jira": jira,
            "tickets": tickets,
            "total_days": total_days,
            "remaining_days": remaining,
            "completion_percent": completion,
            "pace_percent": pace,
            "formula": "story_points + ticket_count * %.5f" % self.ticket_days,
            "refreshed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "stale": False,
            "error": None,
        }

    def _load_jira(self, uf_number: str, start: date, end: date) -> Dict[str, Any]:
        try:
            if self._jira_executor is not None:
                task_count, story_points = self._jira_executor(uf_number, start, end)
            elif self._jira_configured():
                task_count, story_points = self._query_jira(uf_number, start, end)
            else:
                return {
                    "status": "not_configured",
                    "task_count": None,
                    "story_points": None,
                    "days": None,
                    "error": "JIRA API待配置",
                }
            points = _as_number(story_points)
            return {
                "status": "ok",
                "task_count": max(0, int(task_count)),
                "story_points": _rounded(points),
                "days": _rounded(points),
                "error": None,
            }
        except Exception:
            logging.exception("JIRA workload query failed")
            return {
                "status": "error",
                "task_count": None,
                "story_points": None,
                "days": None,
                "error": "JIRA查询失败",
            }

    def _load_tickets(self, assignee: str, start: date, end: date) -> Dict[str, Any]:
        try:
            if self._ticket_executor is not None:
                count = self._ticket_executor(assignee, start, end)
            elif self._ticket_configured():
                count = self._query_ticket_count(assignee, start, end)
            else:
                return {
                    "status": "not_configured",
                    "count": None,
                    "days_per_ticket": _rounded(self.ticket_days),
                    "days": None,
                    "error": "工单SQL待配置",
                }
            count = max(0, int(count))
            return {
                "status": "ok",
                "count": count,
                "days_per_ticket": _rounded(self.ticket_days),
                "days": _rounded(count * self.ticket_days),
                "error": None,
            }
        except Exception:
            return {
                "status": "error",
                "count": None,
                "days_per_ticket": _rounded(self.ticket_days),
                "days": None,
                "error": "工单查询失败",
            }

    def _jira_configured(self) -> bool:
        jira = self.config.get("jira")
        return isinstance(jira, dict) and bool(
            str(jira.get("baseUrl") or "").strip()
            and str(jira.get("jqlTemplate") or "").strip()
            and str(jira.get("storyPointField") or "").strip()
        )

    def _ticket_configured(self) -> bool:
        ticket = self.config.get("ticket")
        if not isinstance(ticket, dict) or not str(ticket.get("query") or "").strip():
            return False
        database = self._ticket_database_config()
        if str(database.get("dsn") or "").strip():
            return True
        return all(str(database.get(key) or "").strip() for key in ("host", "dbname", "user"))

    def _query_ticket_count(self, assignee: str, start: date, end: date) -> int:
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:
            raise RuntimeError("缺少psycopg依赖") from exc

        ticket = dict(self.config.get("ticket") or {})
        database = self._ticket_database_config()
        connect_timeout = _as_positive_int(database.get("connectTimeoutSeconds"), 5)
        statement_timeout = _as_positive_int(database.get("statementTimeoutMs"), 8000)
        kwargs: Dict[str, Any] = {
            "connect_timeout": connect_timeout,
            "options": "-c default_transaction_read_only=on -c statement_timeout=%d" % statement_timeout,
            "row_factory": dict_row,
        }
        dsn = str(database.get("dsn") or "").strip()
        if dsn:
            connection_args = (dsn,)
        else:
            connection_args = ()
            kwargs.update(
                host=str(database.get("host") or "").strip(),
                port=_as_positive_int(database.get("port"), 5432),
                dbname=str(database.get("dbname") or "").strip(),
                user=str(database.get("user") or "").strip(),
                password=str(database.get("password") or ""),
            )
        parameters = {
            "assignee": assignee,
            "month_start": start,
            "next_month_start": end,
        }
        with psycopg.connect(*connection_args, **kwargs) as connection:
            with connection.cursor() as cursor:
                cursor.execute(str(ticket["query"]), parameters)
                rows = list(cursor.fetchall())
        count_field = str(ticket.get("countField") or "ticket_count")
        if len(rows) == 1 and count_field in rows[0]:
            return int(rows[0].get(count_field) or 0)
        return len(rows)

    def _ticket_database_config(self) -> Dict[str, Any]:
        ticket = self.config.get("ticket")
        explicit = ticket.get("database") if isinstance(ticket, dict) else None
        database = dict(self.config.get("_defaultTicketDatabase") or {})
        if isinstance(explicit, dict):
            database.update(explicit)
        password_env = str(database.get("passwordEnv") or "").strip()
        if password_env and os.environ.get(password_env):
            database["password"] = os.environ[password_env]
        return database

    def _query_jira(self, uf_number: str, start: date, end: date) -> Tuple[int, float]:
        jira = dict(self.config.get("jira") or {})
        base_url = str(jira["baseUrl"]).rstrip("/")
        api_version = str(jira.get("apiVersion") or "2")
        search_path = str(jira.get("searchPath") or "/rest/api/%s/search" % api_version)
        endpoint = base_url + "/" + search_path.lstrip("/")
        field_name = str(jira["storyPointField"]).strip()
        jql = str(jira["jqlTemplate"])
        replacements = {
            "{uf_number}": uf_number,
            "{employee_id}": uf_number,
            "{month_start}": start.isoformat(),
            "{next_month_start}": end.isoformat(),
        }
        for token, value in replacements.items():
            jql = jql.replace(token, value)
        employee_placeholder = str(jira.get("employeePlaceholder") or "current")
        if employee_placeholder:
            jql = jql.replace(employee_placeholder, uf_number)

        headers = {"Accept": "application/json", "User-Agent": "TicketMonitorBackend/2.3"}
        auth_mode = str(jira.get("authMode") or "bearer").strip().lower()
        token_env = str(jira.get("tokenEnv") or "JIRA_API_TOKEN").strip()
        token = str(jira.get("token") or os.environ.get(token_env) or "").strip()
        if auth_mode == "basic":
            username = str(jira.get("username") or os.environ.get(str(jira.get("usernameEnv") or "JIRA_USERNAME")) or "")
            if not username or not token:
                raise RuntimeError("JIRA Basic认证信息不完整")
            encoded = base64.b64encode((username + ":" + token).encode("utf-8")).decode("ascii")
            headers["Authorization"] = "Basic " + encoded
        elif auth_mode == "bearer":
            if not token:
                raise RuntimeError("JIRA令牌未配置")
            headers["Authorization"] = "Bearer " + token

        start_at = 0
        task_count = 0
        story_points = 0.0
        page_size = max(1, min(100, int(jira.get("pageSize") or 100)))
        timeout = max(2, min(60, int(jira.get("timeoutSeconds") or 10)))
        while True:
            query = urllib.parse.urlencode(
                {
                    "jql": jql,
                    "fields": field_name,
                    "startAt": start_at,
                    "maxResults": page_size,
                }
            )
            request = urllib.request.Request(endpoint + "?" + query, headers=headers, method="GET")
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read(8 * 1024 * 1024).decode("utf-8-sig"))
            issues = payload.get("issues") if isinstance(payload, dict) else None
            if not isinstance(issues, list):
                raise RuntimeError("JIRA响应缺少issues")
            for issue in issues:
                fields = issue.get("fields") if isinstance(issue, dict) else None
                value = fields.get(field_name) if isinstance(fields, dict) else None
                story_points += _as_number(value)
            task_count += len(issues)
            total = int(payload.get("total") or task_count)
            start_at += len(issues)
            if not issues or start_at >= total:
                break
        return task_count, story_points

    @staticmethod
    def _copy_summary(snapshot: Mapping[str, Any], source: str) -> Dict[str, Any]:
        copied = dict(snapshot)
        copied["jira"] = dict(snapshot.get("jira") or {})
        copied["tickets"] = dict(snapshot.get("tickets") or {})
        copied["source"] = source
        return copied

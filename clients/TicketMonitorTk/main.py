from __future__ import annotations

import nas_update

import ctypes
import getpass
import json
import logging
import os
import queue
import re
import sys
import tempfile
import threading
import time
import tkinter as tk
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from tkinter import messagebox, simpledialog
from typing import Any, Dict, List, Optional, Set, Tuple


APP_NAME = "工单监控"
APP_VERSION = "2.5.0"
TRANSPARENT_COLOR = "#010203"
COLLAPSED_SIZE = (108, 204)
EXPANDED_SIZE = (392, 610)
DEFAULT_DOCK_STRIP_WIDTH = 32
MOUSE_ACTIVITY_INTERVAL_MS = 55_000


def app_directory() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


APP_DIR = app_directory()
CONFIG_PATH = APP_DIR / "ticket-monitor.json"
LOG_PATH = APP_DIR / "ticket-monitor.log"


DEFAULT_CONFIG: Dict[str, Any] = {
    "apiUrl": "http://127.0.0.1:5556/api/unassigned-tickets",
    "slaApiUrl": "http://127.0.0.1:5556/api/sla-risk-tickets",
    "workloadApiUrl": "http://127.0.0.1:5556/api/workload/summary",
    "refreshSeconds": 300,
    "slaRefreshSeconds": 60,
    "workloadRefreshSeconds": 300,
    "timeoutSeconds": 8,
    "collapsedOpacity": 0.72,
    "expandedOpacity": 0.96,
    "notify": True,
    "useSystemProxy": False,
    "ignoreListPath": "",
    "updateManifestPath": "",
    "ufNumber": "",
    "remedyAssignee": "",
    "dockEnabled": True,
    "dockStripWidth": DEFAULT_DOCK_STRIP_WIDTH,
    "dockHideDelayMs": 900,
    "dockSnapDistance": 18,
    "position": {"anchorRight": None, "top": 80, "dockSide": None},
}


def setup_logging() -> None:
    try:
        logging.basicConfig(
            filename=str(LOG_PATH),
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(message)s",
            encoding="utf-8",
        )
    except Exception:
        logging.basicConfig(level=logging.INFO)


def load_config() -> Dict[str, Any]:
    config = json.loads(json.dumps(DEFAULT_CONFIG))
    explicit_sla_url = False
    explicit_workload_url = False
    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as handle:
            user_config = json.load(handle)
        if isinstance(user_config, dict):
            explicit_sla_url = bool(str(user_config.get("slaApiUrl") or "").strip())
            explicit_workload_url = bool(str(user_config.get("workloadApiUrl") or "").strip())
            for key, value in user_config.items():
                if key == "position" and isinstance(value, dict):
                    config["position"].update(value)
                else:
                    config[key] = value
    except FileNotFoundError:
        pass
    except Exception:
        logging.exception("读取配置失败")

    config["refreshSeconds"] = max(30, int(config.get("refreshSeconds") or 300))
    config["slaRefreshSeconds"] = max(30, int(config.get("slaRefreshSeconds") or 60))
    config["workloadRefreshSeconds"] = max(30, int(config.get("workloadRefreshSeconds") or 300))
    config["timeoutSeconds"] = max(2, min(60, int(config.get("timeoutSeconds") or 8)))
    config["collapsedOpacity"] = max(0.25, min(1.0, float(config.get("collapsedOpacity") or 0.72)))
    config["expandedOpacity"] = max(0.50, min(1.0, float(config.get("expandedOpacity") or 0.96)))
    config["apiUrl"] = str(config.get("apiUrl") or "").strip()
    config["slaApiUrl"] = str(config.get("slaApiUrl") or "").strip()
    config["workloadApiUrl"] = str(config.get("workloadApiUrl") or "").strip()
    config["ignoreListPath"] = str(config.get("ignoreListPath") or "").strip()
    legacy_employee_id = str(config.get("employeeId") or "").strip()
    config["ufNumber"] = str(config.get("ufNumber") or legacy_employee_id).strip()
    config["remedyAssignee"] = str(config.get("remedyAssignee") or "").strip()
    config.pop("employeeId", None)
    if not explicit_sla_url and config["apiUrl"]:
        config["slaApiUrl"] = config["apiUrl"].replace(
            "/api/unassigned-tickets", "/api/sla-risk-tickets"
        )
    if not explicit_workload_url and config["apiUrl"]:
        config["workloadApiUrl"] = config["apiUrl"].replace(
            "/api/unassigned-tickets", "/api/workload/summary"
        )
    config["dockEnabled"] = bool(config.get("dockEnabled", True))
    config["dockStripWidth"] = max(26, min(44, int(config.get("dockStripWidth") or DEFAULT_DOCK_STRIP_WIDTH)))
    config["dockHideDelayMs"] = max(300, min(5000, int(config.get("dockHideDelayMs") or 900)))
    config["dockSnapDistance"] = max(8, min(80, int(config.get("dockSnapDistance") or 18)))
    return config


def dock_target_x(
    side: str,
    hidden: bool,
    window_width: int,
    screen_width: int,
    strip_width: int,
) -> int:
    if side == "left":
        return strip_width - window_width if hidden else 0
    if side == "right":
        return screen_width - strip_width if hidden else screen_width - window_width
    raise ValueError("未知吸附方向：%s" % side)


def detect_dock_side(x: int, window_width: int, screen_width: int, distance: int) -> Optional[str]:
    if x <= distance:
        return "left"
    if screen_width - (x + window_width) <= distance:
        return "right"
    return None


def save_config(config: Dict[str, Any]) -> None:
    temporary = CONFIG_PATH.with_suffix(".json.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(config, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(str(temporary), str(CONFIG_PATH))
    except Exception:
        logging.exception("保存配置失败")


@dataclass
class Ticket:
    ticket_id: str
    ticket_type: str
    summary: str
    priority: str
    submit_time: str
    status: str = ""
    handling_kind: str = "unassigned"


@dataclass
class RiskTicket(Ticket):
    assignee: str = ""
    limit_time: str = ""
    progress_percent: float = 0.0
    remaining_seconds: int = 0
    remaining_text: str = ""
    risk_level: str = "warning"


@dataclass
class Snapshot:
    items: List[Ticket] = field(default_factory=list)
    total: int = 0
    inc: int = 0
    wo: int = 0
    stale: bool = False
    refreshed_at: str = ""
    source: str = ""


@dataclass
class RiskSnapshot:
    items: List[RiskTicket] = field(default_factory=list)
    total: int = 0
    warning: int = 0
    critical: int = 0
    breached: int = 0
    inc: int = 0
    wo: int = 0
    stale: bool = False
    refreshed_at: str = ""
    source: str = ""


@dataclass
class WorkloadSnapshot:
    complete: bool = False
    uf_number: str = ""
    assignee: str = ""
    month: str = ""
    target_days: float = 0.0
    elapsed_target_days: float = 0.0
    target_source: str = ""
    jira_status: str = "not_configured"
    jira_task_count: Optional[int] = None
    jira_story_points: Optional[float] = None
    jira_days: Optional[float] = None
    jira_error: str = ""
    ticket_status: str = "not_configured"
    ticket_count: Optional[int] = None
    ticket_days_per_ticket: float = 0.33625
    ticket_days: Optional[float] = None
    ticket_error: str = ""
    total_days: Optional[float] = None
    remaining_days: Optional[float] = None
    completion_percent: Optional[float] = None
    pace_percent: Optional[float] = None
    stale: bool = False
    refreshed_at: str = ""
    source: str = ""


@dataclass(frozen=True)
class IgnoredTicket:
    key: str
    ticket_id: str
    ticket_type: str
    ignored_by: str = ""
    ignored_at: str = ""


def ticket_key(ticket_type: str, ticket_id: str) -> str:
    normalized_type = str(ticket_type or "OTHER").strip().upper()
    normalized_id = str(ticket_id or "").strip()
    return "%s:%s" % (normalized_type, normalized_id)


def configured_ignore_list_path(config: Dict[str, Any]) -> Optional[Path]:
    raw_path = os.path.expandvars(str(config.get("ignoreListPath") or "").strip())
    if not raw_path:
        return None
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = APP_DIR / path
    return path


def _current_windows_user() -> str:
    username = str(os.environ.get("USERNAME") or getpass.getuser() or "unknown").strip()
    domain = str(os.environ.get("USERDOMAIN") or "").strip()
    if domain and "\\" not in username:
        return "%s\\%s" % (domain, username)
    return username


def load_ignored_tickets(path: Path) -> Dict[str, IgnoredTicket]:
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            payload = json.load(handle)
    except json.JSONDecodeError as error:
        raise ValueError("共享忽略列表JSON格式错误：%s" % error) from error

    raw_items = payload.get("ignored") if isinstance(payload, dict) else None
    if not isinstance(raw_items, list):
        raise ValueError("共享忽略列表缺少ignored数组")

    records: Dict[str, IgnoredTicket] = {}
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        ticket_id = str(item.get("ticketId") or item.get("ticket_id") or "").strip()
        ticket_type = str(item.get("ticketType") or item.get("ticket_type") or "OTHER").strip().upper()
        if not ticket_id:
            continue
        key = str(item.get("key") or ticket_key(ticket_type, ticket_id)).strip()
        records[key] = IgnoredTicket(
            key=key,
            ticket_id=ticket_id,
            ticket_type=ticket_type,
            ignored_by=str(item.get("ignoredBy") or item.get("ignored_by") or "").strip(),
            ignored_at=str(item.get("ignoredAt") or item.get("ignored_at") or "").strip(),
        )
    return records


def _acquire_ignore_list_lock(lock_path: Path, timeout_seconds: float = 4.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            descriptor = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write("%s\n" % _current_windows_user())
                handle.write("%s\n" % datetime.now().astimezone().isoformat(timespec="seconds"))
            return
        except FileExistsError:
            try:
                if time.time() - lock_path.stat().st_mtime > 30:
                    lock_path.unlink()
                    continue
            except FileNotFoundError:
                continue
            except OSError:
                pass
            if time.monotonic() >= deadline:
                raise TimeoutError("共享忽略列表正被其他客户端修改，请稍后重试")
            time.sleep(0.12)


def read_ignored_tickets_shared(path: Path) -> Dict[str, IgnoredTicket]:
    if not path.parent.exists():
        raise FileNotFoundError("共享忽略列表目录不存在：%s" % path.parent)
    lock_path = path.with_name(path.name + ".lock")
    _acquire_ignore_list_lock(lock_path)
    try:
        return load_ignored_tickets(path)
    finally:
        try:
            lock_path.unlink(missing_ok=True)
        except OSError:
            logging.exception("删除共享忽略列表读取锁失败")


def update_ignored_tickets(
    path: Path,
    action: str,
    ticket: Optional[Ticket] = None,
    key: str = "",
) -> Dict[str, IgnoredTicket]:
    if not path.parent.exists():
        raise FileNotFoundError("共享忽略列表目录不存在：%s" % path.parent)

    lock_path = path.with_name(path.name + ".lock")
    temporary = path.with_name(".%s.%s.%s.tmp" % (path.name, os.getpid(), threading.get_ident()))
    _acquire_ignore_list_lock(lock_path)
    try:
        records = load_ignored_tickets(path)
        if action == "add":
            if ticket is None:
                raise ValueError("缺少要忽略的工单")
            record_key = ticket_key(ticket.ticket_type, ticket.ticket_id)
            records[record_key] = IgnoredTicket(
                key=record_key,
                ticket_id=ticket.ticket_id,
                ticket_type=ticket.ticket_type,
                ignored_by=_current_windows_user(),
                ignored_at=datetime.now().astimezone().isoformat(timespec="seconds"),
            )
        elif action == "remove":
            records.pop(key, None)
        elif action == "clear":
            records.clear()
        else:
            raise ValueError("未知忽略列表操作：%s" % action)

        payload = {
            "schemaVersion": 1,
            "updatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "ignored": [
                {
                    "key": record.key,
                    "ticketId": record.ticket_id,
                    "ticketType": record.ticket_type,
                    "ignoredBy": record.ignored_by,
                    "ignoredAt": record.ignored_at,
                }
                for record in sorted(records.values(), key=lambda value: value.key)
            ],
        }
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                # Some SMB implementations do not expose a flush operation.
                logging.warning("共享盘不支持fsync，继续使用原子替换")
        for attempt in range(5):
            try:
                os.replace(str(temporary), str(path))
                break
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.12)
        return records
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        try:
            lock_path.unlink(missing_ok=True)
        except OSError:
            logging.exception("删除共享忽略列表锁文件失败")


def filter_snapshot(snapshot: Snapshot, ignored_keys: Set[str]) -> Snapshot:
    items = [item for item in snapshot.items if ticket_key(item.ticket_type, item.ticket_id) not in ignored_keys]
    return Snapshot(
        items=items,
        total=len(items),
        inc=sum(item.ticket_type == "INC" for item in items),
        wo=sum(item.ticket_type == "WO" for item in items),
        stale=snapshot.stale,
        refreshed_at=snapshot.refreshed_at,
        source=snapshot.source,
    )


def filter_risk_snapshot(snapshot: RiskSnapshot, ignored_keys: Set[str]) -> RiskSnapshot:
    items = [item for item in snapshot.items if ticket_key(item.ticket_type, item.ticket_id) not in ignored_keys]
    return RiskSnapshot(
        items=items,
        total=len(items),
        warning=sum(item.risk_level == "warning" for item in items),
        critical=sum(item.risk_level == "critical" for item in items),
        breached=sum(item.risk_level == "breached" for item in items),
        inc=sum(item.ticket_type == "INC" for item in items),
        wo=sum(item.ticket_type == "WO" for item in items),
        stale=snapshot.stale,
        refreshed_at=snapshot.refreshed_at,
        source=snapshot.source,
    )


def parse_snapshot(payload: Any) -> Snapshot:
    if not isinstance(payload, dict):
        raise ValueError("API返回格式不是JSON对象")
    if payload.get("success") is False:
        raise ValueError(str(payload.get("error") or "API返回失败"))

    items: List[Ticket] = []
    raw_items = payload.get("items")
    if isinstance(raw_items, list):
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            ticket_id = str(item.get("id") or "").strip()
            if not ticket_id:
                continue
            ticket_type = str(item.get("type") or item.get("ticket_type") or "OTHER").strip().upper()
            if ticket_type == "INCIDENT":
                ticket_type = "INC"
            elif ticket_type.replace(" ", "") == "WORKORDER":
                ticket_type = "WO"
            items.append(
                Ticket(
                    ticket_id=ticket_id,
                    ticket_type=ticket_type,
                    summary=str(item.get("summary") or "").strip(),
                    priority=str(item.get("priority") or "").strip(),
                    submit_time=str(item.get("submit_time") or "").strip(),
                    status=str(item.get("status") or "").strip(),
                    handling_kind="agent_handoff" if item.get("handling_kind") == "agent_handoff" else "unassigned",
                )
            )

    items.sort(key=lambda ticket: ticket.handling_kind != "agent_handoff")
    counts = payload.get("counts") if isinstance(payload.get("counts"), dict) else {}
    total = int(counts.get("total", len(items)) or 0)
    inc = int(counts.get("inc", sum(1 for item in items if item.ticket_type == "INC")) or 0)
    wo = int(counts.get("wo", sum(1 for item in items if item.ticket_type == "WO")) or 0)
    return Snapshot(
        items=items,
        total=total,
        inc=inc,
        wo=wo,
        stale=bool(payload.get("stale")),
        refreshed_at=str(payload.get("refreshed_at") or ""),
        source=str(payload.get("source") or ""),
    )


def parse_risk_snapshot(payload: Any) -> RiskSnapshot:
    if not isinstance(payload, dict):
        raise ValueError("SLA API返回格式不是JSON对象")
    if payload.get("success") is False:
        raise ValueError(str(payload.get("error") or "SLA API返回失败"))
    items: List[RiskTicket] = []
    for item in payload.get("items") or []:
        if not isinstance(item, dict) or not str(item.get("id") or "").strip():
            continue
        ticket_type = str(item.get("type") or item.get("ticket_type") or "OTHER").strip().upper()
        if ticket_type == "INCIDENT":
            ticket_type = "INC"
        elif ticket_type.replace(" ", "") == "WORKORDER":
            ticket_type = "WO"
        risk_level = str(item.get("risk_level") or "warning").strip().lower()
        if risk_level not in {"warning", "critical", "breached"}:
            risk_level = "warning"
        items.append(RiskTicket(
            ticket_id=str(item.get("id") or "").strip(),
            ticket_type=ticket_type,
            summary=str(item.get("summary") or "").strip(),
            priority=str(item.get("priority") or "").strip(),
            submit_time=str(item.get("submit_time") or "").strip(),
            status=str(item.get("status") or "").strip(),
            assignee=str(item.get("assignee") or "").strip(),
            limit_time=str(item.get("limit_time") or "").strip(),
            progress_percent=float(item.get("progress_percent") or 0),
            remaining_seconds=int(item.get("remaining_seconds") or 0),
            remaining_text=str(item.get("remaining_text") or "").strip(),
            risk_level=risk_level,
        ))
    counts = payload.get("counts") if isinstance(payload.get("counts"), dict) else {}
    return RiskSnapshot(
        items=items,
        total=int(counts.get("total", len(items)) or 0),
        warning=int(counts.get("warning", 0) or 0),
        critical=int(counts.get("critical", 0) or 0),
        breached=int(counts.get("breached", 0) or 0),
        inc=int(counts.get("inc", 0) or 0),
        wo=int(counts.get("wo", 0) or 0),
        stale=bool(payload.get("stale")),
        refreshed_at=str(payload.get("refreshed_at") or ""),
        source=str(payload.get("source") or ""),
    )


def _optional_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _optional_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_workload_snapshot(payload: Any) -> WorkloadSnapshot:
    if not isinstance(payload, dict):
        raise ValueError("工作量接口返回的不是JSON对象")
    if payload.get("success") is False:
        raise ValueError(str(payload.get("error") or "工作量接口返回失败"))
    if str(payload.get("unit") or "day") != "day":
        raise ValueError("工作量接口单位不是天")
    jira = payload.get("jira") if isinstance(payload.get("jira"), dict) else {}
    tickets = payload.get("tickets") if isinstance(payload.get("tickets"), dict) else {}
    return WorkloadSnapshot(
        complete=bool(payload.get("complete")),
        uf_number=str(payload.get("uf_number") or payload.get("employee_id") or ""),
        assignee=str(payload.get("assignee") or ""),
        month=str(payload.get("month") or ""),
        target_days=float(payload.get("target_days") or 0.0),
        elapsed_target_days=float(payload.get("elapsed_target_days") or 0.0),
        target_source=str(payload.get("target_source") or ""),
        jira_status=str(jira.get("status") or "not_configured"),
        jira_task_count=_optional_int(jira.get("task_count")),
        jira_story_points=_optional_float(jira.get("story_points")),
        jira_days=_optional_float(jira.get("days")),
        jira_error=str(jira.get("error") or ""),
        ticket_status=str(tickets.get("status") or "not_configured"),
        ticket_count=_optional_int(tickets.get("count")),
        ticket_days_per_ticket=float(tickets.get("days_per_ticket") or 0.33625),
        ticket_days=_optional_float(tickets.get("days")),
        ticket_error=str(tickets.get("error") or ""),
        total_days=_optional_float(payload.get("total_days")),
        remaining_days=_optional_float(payload.get("remaining_days")),
        completion_percent=_optional_float(payload.get("completion_percent")),
        pace_percent=_optional_float(payload.get("pace_percent")),
        stale=bool(payload.get("stale")),
        refreshed_at=str(payload.get("refreshed_at") or ""),
        source=str(payload.get("source") or ""),
    )


def fetch_json(config: Dict[str, Any], api_url: str, force: bool) -> Any:
    if not api_url:
        raise ValueError("接口地址未配置")

    separator = "&" if "?" in api_url else "?"
    parameters = []
    if force:
        parameters.append("refresh=1")
    parameters.append("_=%d" % int(time.time() * 1000))
    request_url = api_url + separator + "&".join(parameters)
    request = urllib.request.Request(
        request_url,
        headers={
            "Accept": "application/json",
            "Cache-Control": "no-cache",
            "User-Agent": "TicketMonitorTk/2.3",
        },
        method="GET",
    )

    if bool(config.get("useSystemProxy")):
        opener = urllib.request.build_opener()
    else:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    timeout = int(config.get("timeoutSeconds") or 8)
    try:
        with opener.open(request, timeout=timeout) as response:
            body = response.read(8 * 1024 * 1024 + 1)
            if len(body) > 8 * 1024 * 1024:
                raise ValueError("API响应超过8MB")
            return json.loads(body.decode("utf-8-sig"))
    except urllib.error.HTTPError as error:
        try:
            body = error.read().decode("utf-8-sig")
            payload = json.loads(body)
            message = payload.get("error") if isinstance(payload, dict) else None
        except Exception:
            message = None
        raise RuntimeError(str(message or "HTTP %s" % error.code)) from error
    except urllib.error.URLError as error:
        reason = getattr(error, "reason", error)
        raise RuntimeError("连接失败：%s" % reason) from error


def fetch_snapshot(config: Dict[str, Any], force: bool) -> Snapshot:
    return parse_snapshot(fetch_json(config, str(config.get("apiUrl") or "").strip(), force))


def fetch_risk_snapshot(config: Dict[str, Any], force: bool) -> RiskSnapshot:
    return parse_risk_snapshot(fetch_json(config, str(config.get("slaApiUrl") or "").strip(), force))


def fetch_workload_snapshot(config: Dict[str, Any], force: bool) -> WorkloadSnapshot:
    uf_number = str(config.get("ufNumber") or "").strip()
    assignee = str(config.get("remedyAssignee") or "").strip()
    if not uf_number or not assignee:
        raise ValueError("请先设置UF号和Remedy完整用户名")
    api_url = str(config.get("workloadApiUrl") or "").strip()
    if not api_url:
        raise ValueError("工作量接口地址未配置")
    separator = "&" if "?" in api_url else "?"
    parameters = urllib.parse.urlencode(
        {
            "uf_number": uf_number,
            "assignee": assignee,
            "month": datetime.now().strftime("%Y-%m"),
        }
    )
    return parse_workload_snapshot(fetch_json(config, api_url + separator + parameters, force))


class _MouseInput(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_int32),
        ("dy", ctypes.c_int32),
        ("mouseData", ctypes.c_uint32),
        ("dwFlags", ctypes.c_uint32),
        ("time", ctypes.c_uint32),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class _InputUnion(ctypes.Union):
    _fields_ = [("mi", _MouseInput)]


class _Input(ctypes.Structure):
    _anonymous_ = ("data",)
    _fields_ = [("type", ctypes.c_uint32), ("data", _InputUnion)]


def send_slight_mouse_activity() -> bool:
    """Send a one-pixel move and immediate restore as one Windows input batch."""
    if os.name != "nt":
        return False
    try:
        inputs = (_Input * 2)(
            _Input(type=0, mi=_MouseInput(dx=1, dy=0, dwFlags=0x0001)),
            _Input(type=0, mi=_MouseInput(dx=-1, dy=0, dwFlags=0x0001)),
        )
        user32 = ctypes.windll.user32
        user32.SendInput.argtypes = [ctypes.c_uint32, ctypes.POINTER(_Input), ctypes.c_int]
        user32.SendInput.restype = ctypes.c_uint32
        return int(user32.SendInput(2, inputs, ctypes.sizeof(_Input))) == 2
    except Exception:
        logging.exception("发送轻微鼠标活动失败")
        return False


class RoundedCanvas(tk.Canvas):
    def rounded_rectangle(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        radius: float,
        **kwargs: Any,
    ) -> int:
        radius = max(1.0, min(radius, (x2 - x1) / 2, (y2 - y1) / 2))
        points = [
            x1 + radius, y1,
            x2 - radius, y1,
            x2, y1,
            x2, y1 + radius,
            x2, y2 - radius,
            x2, y2,
            x2 - radius, y2,
            x1 + radius, y2,
            x1, y2,
            x1, y2 - radius,
            x1, y1 + radius,
            x1, y1,
        ]
        return self.create_polygon(points, smooth=True, splinesteps=24, **kwargs)


class TicketMonitor:
    BG = "#0f172a"
    PANEL = "#1e293b"
    PANEL_ACTIVE = "#203449"
    BORDER = "#334155"
    TEXT = "#f8fafc"
    MUTED = "#94a3b8"
    INC = "#fb923c"
    WO = "#60a5fa"
    GREEN = "#22c55e"
    AMBER = "#f59e0b"
    RED = "#ef4444"
    CYAN = "#38bdf8"

    def __init__(self) -> None:
        self.config = load_config()
        self.root = tk.Tk()
        self.root.title(APP_NAME)
        self.root.overrideredirect(True)
        self.root.configure(bg=TRANSPARENT_COLOR)
        self.root.attributes("-topmost", True)
        try:
            self.root.attributes("-transparentcolor", TRANSPARENT_COLOR)
        except tk.TclError:
            pass

        self.canvas = RoundedCanvas(
            self.root,
            bg=TRANSPARENT_COLOR,
            bd=0,
            highlightthickness=0,
            relief="flat",
        )
        self.canvas.pack(fill="both", expand=True)

        self.snapshot = Snapshot()
        self.risk_snapshot = RiskSnapshot()
        self.workload_snapshot = WorkloadSnapshot()
        self.raw_snapshot = Snapshot()
        self.raw_risk_snapshot = RiskSnapshot()
        self.ignored_tickets: Dict[str, IgnoredTicket] = {}
        self.ignore_list_error = ""
        self.ignore_write_pending = False
        self.connected = False
        self.risk_connected = False
        self.workload_connected = False
        self.last_error = "等待连接"
        self.risk_last_error = "等待连接"
        identity_ready = bool(self.config.get("ufNumber") and self.config.get("remedyAssignee"))
        self.workload_last_error = "等待连接" if identity_ready else "请先设置个人信息"
        self.mouse_keep_awake = False
        self.mouse_keep_awake_after_id: Optional[str] = None
        self.loading = False
        self.expanded = False
        self.target_expanded = False
        self.animating = False
        self.filter_name = "ALL"
        self.active_page = "unassigned"
        self.scroll_offset = 0
        self.seen_initialized = False
        self.seen_ids: Set[str] = set()
        self.seen_handling_kinds: Dict[str, str] = {}
        self.new_ids: Set[str] = set()
        self.risk_initialized = False
        self.risk_levels: Dict[str, str] = {}
        self.changed_risk_ids: Set[str] = set()
        self.toast_text = ""
        self.update_busy = False
        self.result_queue: "queue.Queue[Tuple[str, bool, Any]]" = queue.Queue()
        self.result_check_after_id: Optional[str] = None
        self.poll_after_id: Optional[str] = None
        self.collapse_after_id: Optional[str] = None
        self.dock_hide_after_id: Optional[str] = None
        self.toast_after_id: Optional[str] = None
        self.dragging = False
        self.drag_moved = False
        self.drag_start = (0, 0)
        self.drag_origin = (0, 0)
        self.anchor_right = 0
        self.top = 0
        # Keep the requested size separately from winfo_width()/winfo_height().
        # On Windows, geometry changes are applied asynchronously. Reading the
        # native size immediately after restoring a docked strip can therefore
        # return the old strip width and redraw strip content inside the popup.
        self.window_width, self.window_height = COLLAPSED_SIZE
        self.dock_side: Optional[str] = None
        self.dock_hidden = False
        self.dock_animating = False
        self.dock_animation_generation = 0
        self.refresh_rect = (0, 0, 0, 0)
        self.collapse_rect = (0, 0, 0, 0)
        self.awake_rect = (0, 0, 0, 0)
        self.filter_rects: List[Tuple[int, int, int, int]] = []
        self.page_rects: List[Tuple[int, int, int, int]] = []
        self.sla_collapsed_rect = (0, 0, 0, 0)
        self.employee_rect = (0, 0, 0, 0)
        self.list_top = 196
        self.list_bottom = 570

        self._configure_fonts()
        self._place_initial_window()
        self._bind_events()
        self._apply_windows_styles()
        self._set_opacity()
        self._build_context_menu()
        self._redraw()

        self.root.after(250, lambda: self.refresh(False))
        if self.dock_side:
            self._schedule_dock_hide(1400)

    def _configure_fonts(self) -> None:
        family = "Microsoft YaHei UI" if os.name == "nt" else "Sans"
        self.font_title = (family, 16, "bold")
        self.font_label = (family, 10)
        self.font_hero = (family, 30, "bold")
        self.font_count = (family, 14, "bold")
        self.font_id = (family, 11, "bold")
        self.font_body = (family, 10)
        self.font_small = (family, 9)
        self.font_strip_label = (family, 8, "bold")
        self.font_strip_count = (family, 12, "bold")

    def _place_initial_window(self) -> None:
        width, height = COLLAPSED_SIZE
        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()
        position = self.config.get("position") if isinstance(self.config.get("position"), dict) else {}
        configured_right = position.get("anchorRight")
        configured_top = position.get("top")
        configured_dock = str(position.get("dockSide") or "").lower()
        if bool(self.config.get("dockEnabled", True)) and configured_dock in {"left", "right"}:
            self.dock_side = configured_dock
        try:
            self.anchor_right = int(configured_right) if configured_right is not None else screen_width - 18
        except (TypeError, ValueError):
            self.anchor_right = screen_width - 18
        try:
            self.top = int(configured_top) if configured_top is not None else 80
        except (TypeError, ValueError):
            self.top = 80
        if self.dock_side == "left":
            self.anchor_right = width
        elif self.dock_side == "right":
            self.anchor_right = screen_width
        else:
            self.anchor_right = max(width, min(screen_width, self.anchor_right))
        self.top = max(0, min(screen_height - height, self.top))
        self._set_geometry(width, height)

    def _set_geometry(self, width: int, height: int) -> None:
        x = self.anchor_right - width
        self._set_geometry_at_x(width, height, x)

    def _set_geometry_at_x(self, width: int, height: int, x: int) -> None:
        self.window_width = width
        self.window_height = height
        self.anchor_right = x + width
        self.root.geometry("%dx%d%+d%+d" % (width, height, x, self.top))
        self.canvas.configure(width=width, height=height)

    def _apply_windows_styles(self) -> None:
        if os.name != "nt":
            return
        try:
            self.root.update_idletasks()
            user32 = ctypes.windll.user32
            hwnd = self.root.winfo_id()
            user32.GetParent.argtypes = [ctypes.c_void_p]
            user32.GetParent.restype = ctypes.c_void_p
            parent = user32.GetParent(hwnd)
            if parent:
                hwnd = parent
            get_window_long = user32.GetWindowLongPtrW if ctypes.sizeof(ctypes.c_void_p) == 8 else user32.GetWindowLongW
            set_window_long = user32.SetWindowLongPtrW if ctypes.sizeof(ctypes.c_void_p) == 8 else user32.SetWindowLongW
            get_window_long.argtypes = [ctypes.c_void_p, ctypes.c_int]
            get_window_long.restype = ctypes.c_ssize_t
            set_window_long.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_ssize_t]
            set_window_long.restype = ctypes.c_ssize_t
            GWL_EXSTYLE = -20
            WS_EX_TOOLWINDOW = 0x00000080
            WS_EX_NOACTIVATE = 0x08000000
            style = get_window_long(hwnd, GWL_EXSTYLE)
            set_window_long(hwnd, GWL_EXSTYLE, style | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)
        except Exception:
            logging.exception("设置Windows窗口样式失败")

    def _bind_events(self) -> None:
        self.canvas.bind("<ButtonPress-1>", self._mouse_down)
        self.canvas.bind("<B1-Motion>", self._mouse_drag)
        self.canvas.bind("<ButtonRelease-1>", self._mouse_up)
        self.canvas.bind("<Double-Button-1>", self._double_click)
        self.canvas.bind("<Button-3>", self._show_context_menu)
        self.canvas.bind("<Enter>", self._mouse_enter)
        self.canvas.bind("<Leave>", self._mouse_leave)
        self.canvas.bind("<MouseWheel>", self._mouse_wheel)
        self.root.protocol("WM_DELETE_WINDOW", self.close)

    def _build_context_menu(self) -> None:
        self.context_menu = tk.Menu(self.root, tearoff=False)
        self.ignored_submenu: Optional[tk.Menu] = None
        self._populate_context_menu(None)

    def _populate_context_menu(self, ticket: Optional[Ticket]) -> None:
        self.context_menu.delete(0, "end")
        ignore_path = configured_ignore_list_path(self.config)
        if ticket is not None:
            state = "normal" if ignore_path and not self.ignore_write_pending else "disabled"
            self.context_menu.add_command(
                label="忽略 %s（共享）" % ticket.ticket_id,
                state=state,
                command=lambda selected=ticket: self._request_ignore_ticket(selected),
            )
            self.context_menu.add_separator()

        self.context_menu.add_command(label="展开/收起", command=lambda: self.set_expanded(not self.expanded))
        self.context_menu.add_command(label="我的工作量", command=self._open_workload_page)
        self.context_menu.add_command(label="设置个人信息…", command=self._set_workload_identity)
        self.context_menu.add_command(label="立即刷新", command=lambda: self.refresh(True))
        self.context_menu.add_command(label="打开配置文件", command=self._open_config)
        self.context_menu.add_command(label="检查更新（%s）" % APP_VERSION,
                                      state="disabled" if self.update_busy else "normal",
                                      command=self._check_update)

        if ignore_path is None:
            self.context_menu.add_command(label="共享忽略列表未配置", state="disabled")
        else:
            self.ignored_submenu = tk.Menu(self.context_menu, tearoff=False)
            if self.ignored_tickets:
                for record in sorted(self.ignored_tickets.values(), key=lambda value: value.key):
                    owner = " · %s" % record.ignored_by if record.ignored_by else ""
                    self.ignored_submenu.add_command(
                        label="恢复 %s%s" % (record.ticket_id, owner),
                        state="disabled" if self.ignore_write_pending else "normal",
                        command=lambda selected_key=record.key: self._request_restore_ticket(selected_key),
                    )
                self.ignored_submenu.add_separator()
                self.ignored_submenu.add_command(
                    label="全部恢复",
                    state="disabled" if self.ignore_write_pending else "normal",
                    command=self._request_clear_ignored,
                )
            else:
                self.ignored_submenu.add_command(label="当前没有已忽略工单", state="disabled")
            self.context_menu.add_cascade(
                label="已忽略工单（%d）" % len(self.ignored_tickets),
                menu=self.ignored_submenu,
            )
            if self.ignore_list_error:
                self.context_menu.add_command(label="共享忽略列表连接异常", state="disabled")
            self.context_menu.add_command(label="重新读取共享忽略列表", command=self._reload_ignore_list)
        self.context_menu.add_separator()
        self.context_menu.add_command(label="退出", command=self.close)

    def _show_context_menu(self, event: tk.Event) -> None:
        self._cancel_dock_hide()
        if self.dock_hidden:
            self._show_dock()
        ticket = self._ticket_at_position(event.x, event.y)
        self._populate_context_menu(ticket)
        try:
            self.context_menu.tk_popup(event.x_root, event.y_root)
        finally:
            self.context_menu.grab_release()

    def _update_worker(self, kind, action):
        self.update_busy = True
        self._ensure_result_poller()
        def worker():
            try:
                self.result_queue.put((kind, True, action()))
            except Exception as error:
                logging.exception("客户端更新失败")
                self.result_queue.put((kind, False, str(error)))
        threading.Thread(target=worker, daemon=True).start()

    def _check_update(self):
        if self.update_busy:
            return
        path = str(self.config.get("updateManifestPath") or "").strip()
        if not path:
            messagebox.showinfo("检查更新", "请先在配置文件中填写 updateManifestPath。", parent=self.root)
            return
        self._show_toast("正在检查更新…", 5000)
        self._update_worker("update_check", lambda: nas_update.read_manifest(path))

    def _handle_update_result(self, kind, success, result):
        self.update_busy = False
        if not success:
            messagebox.showerror("更新失败", str(result), parent=self.root)
            return
        if kind == "update_check":
            if nas_update.version_tuple(result["version"]) <= nas_update.version_tuple(APP_VERSION):
                messagebox.showinfo("检查更新", "当前已是最新版本：" + APP_VERSION, parent=self.root)
                return
            detail = "当前版本：%s\n新版本：%s\n\n%s" % (
                APP_VERSION, result["version"], str(result.get("notes") or "")[:2000])
            if not getattr(sys, "frozen", False):
                messagebox.showinfo("发现新版", detail + "\n\n源码运行只检查版本；自动替换请使用 EXE。", parent=self.root)
                return
            if messagebox.askyesno("发现新版", detail + "\n\n立即更新并重启？", parent=self.root):
                self._show_toast("正在复制并校验新版…", 10000)
                def prepare():
                    staged = nas_update.stage_update(result)
                    nas_update.launch_updater(staged, sys.executable, result["sha256"])
                    return str(staged)
                self._update_worker("update_ready", prepare)
        elif kind == "update_ready":
            self.close()

    def _open_config(self) -> None:
        try:
            if os.name == "nt":
                os.startfile(str(CONFIG_PATH))  # type: ignore[attr-defined]
            else:
                logging.info("配置文件：%s", CONFIG_PATH)
        except Exception:
            logging.exception("打开配置文件失败")

    def _open_workload_page(self) -> None:
        self.active_page = "workload"
        self.filter_name = "ALL"
        self.scroll_offset = 0
        if not self.expanded:
            self.set_expanded(True)
        else:
            self._redraw()

    def _set_workload_identity(self) -> None:
        uf_number = simpledialog.askstring(
            "设置个人信息",
            "请输入JIRA使用的UF号：",
            initialvalue=str(self.config.get("ufNumber") or ""),
            parent=self.root,
        )
        if uf_number is None:
            return
        uf_number = uf_number.strip()
        if not re.fullmatch(r"[A-Za-z0-9_.@-]{1,64}", uf_number):
            messagebox.showerror(
                "UF号格式不正确",
                "UF号只能包含字母、数字、点、横线、下划线或@。",
                parent=self.root,
            )
            return
        assignee = simpledialog.askstring(
            "设置个人信息",
            "请输入Remedy中的完整用户名（包含部门后缀）：",
            initialvalue=str(self.config.get("remedyAssignee") or ""),
            parent=self.root,
        )
        if assignee is None:
            return
        assignee = assignee.strip()
        if not assignee or len(assignee) > 256 or any(ord(character) < 32 for character in assignee):
            messagebox.showerror(
                "Remedy用户名格式不正确",
                "请输入1至256个字符的Remedy完整用户名。",
                parent=self.root,
            )
            return
        changed = (
            uf_number != str(self.config.get("ufNumber") or "")
            or assignee != str(self.config.get("remedyAssignee") or "")
        )
        self.config["ufNumber"] = uf_number
        self.config["remedyAssignee"] = assignee
        save_config(self.config)
        self.workload_last_error = "等待连接"
        if changed:
            self.workload_snapshot = WorkloadSnapshot(uf_number=uf_number, assignee=assignee)
            self.workload_connected = False
        self.active_page = "workload"
        self.filter_name = "ALL"
        self.scroll_offset = 0
        self._show_toast("个人信息已保存")
        self.refresh(True)

    def _toggle_mouse_keep_awake(self) -> None:
        if self.mouse_keep_awake:
            self._stop_mouse_keep_awake(show_toast=True)
            return
        if os.name != "nt":
            self._show_toast("防锁屏仅支持Windows", 3600)
            return
        self.mouse_keep_awake = True
        self._run_mouse_keep_awake()
        if self.mouse_keep_awake:
            self._show_toast("防锁屏已开启")
        self._redraw()

    def _run_mouse_keep_awake(self) -> None:
        self.mouse_keep_awake_after_id = None
        if not self.mouse_keep_awake:
            return
        if not send_slight_mouse_activity():
            self.mouse_keep_awake = False
            self._show_toast("防锁屏启动失败", 4200)
            self._redraw()
            return
        self.mouse_keep_awake_after_id = self.root.after(
            MOUSE_ACTIVITY_INTERVAL_MS,
            self._run_mouse_keep_awake,
        )

    def _stop_mouse_keep_awake(self, show_toast: bool = False) -> None:
        if self.mouse_keep_awake_after_id:
            try:
                self.root.after_cancel(self.mouse_keep_awake_after_id)
            except tk.TclError:
                pass
            self.mouse_keep_awake_after_id = None
        was_enabled = self.mouse_keep_awake
        self.mouse_keep_awake = False
        if show_toast and was_enabled:
            self._show_toast("防锁屏已关闭")
        self._redraw()

    def _ticket_at_position(self, x: int, y: int) -> Optional[Ticket]:
        if self.active_page == "workload":
            return None
        if not self.expanded or not (14 <= x <= self.window_width - 14):
            return None
        if not (self.list_top <= y <= self.list_bottom):
            return None
        offset = y - self.list_top + self.scroll_offset
        rows, _ = self._list_layout()
        for kind, value, top, row_height in rows:
            if kind == "ticket" and top <= offset <= top + row_height - 9:
                return value
        return None

    def _request_ignore_ticket(self, ticket: Ticket) -> None:
        if not messagebox.askyesno(
            "共享忽略",
            "忽略后，%s 将在所有客户端隐藏。\n\n是否继续？" % ticket.ticket_id,
            parent=self.root,
        ):
            return
        self._start_ignore_mutation("add", ticket=ticket, success_message="已共享忽略 %s" % ticket.ticket_id)

    def _request_restore_ticket(self, key: str) -> None:
        record = self.ignored_tickets.get(key)
        if record is None:
            return
        if not messagebox.askyesno(
            "恢复工单",
            "恢复后，%s 将重新显示在所有客户端。\n\n是否继续？" % record.ticket_id,
            parent=self.root,
        ):
            return
        self._start_ignore_mutation("remove", key=key, success_message="已恢复 %s" % record.ticket_id)

    def _request_clear_ignored(self) -> None:
        if not self.ignored_tickets:
            return
        if not messagebox.askyesno(
            "全部恢复",
            "将恢复全部 %d 张共享忽略工单，所有客户端都会受影响。\n\n是否继续？"
            % len(self.ignored_tickets),
            parent=self.root,
        ):
            return
        self._start_ignore_mutation("clear", success_message="已恢复全部忽略工单")

    def _reload_ignore_list(self) -> None:
        path = configured_ignore_list_path(self.config)
        if path is None:
            self._show_toast("共享忽略列表未配置", 3600)
            return
        if self.ignore_write_pending:
            self._show_toast("正在更新共享忽略列表", 2800)
            return
        self.ignore_write_pending = True
        self._ensure_result_poller()

        def worker() -> None:
            try:
                records = read_ignored_tickets_shared(path)
                self.result_queue.put(("ignore_reload", True, records))
            except Exception as error:
                logging.exception("读取共享忽略列表失败")
                self.result_queue.put(("ignore_reload", False, str(error)))

        threading.Thread(target=worker, name="ignore-list-reload", daemon=True).start()

    def _start_ignore_mutation(
        self,
        action: str,
        ticket: Optional[Ticket] = None,
        key: str = "",
        success_message: str = "共享忽略列表已更新",
    ) -> None:
        path = configured_ignore_list_path(self.config)
        if path is None:
            self._show_toast("共享忽略列表未配置", 3600)
            return
        if self.ignore_write_pending:
            self._show_toast("正在更新共享忽略列表", 2800)
            return
        self.ignore_write_pending = True
        self._ensure_result_poller()

        def worker() -> None:
            try:
                records = update_ignored_tickets(path, action, ticket=ticket, key=key)
                self.result_queue.put(("ignore_mutation", True, (records, success_message)))
            except Exception as error:
                logging.exception("更新共享忽略列表失败")
                self.result_queue.put(("ignore_mutation", False, str(error)))

        threading.Thread(target=worker, name="ignore-list-write", daemon=True).start()

    def _ensure_result_poller(self) -> None:
        if self.result_check_after_id is None:
            self.result_check_after_id = self.root.after(100, self._process_results)

    def _apply_ignored_tickets(self, records: Dict[str, IgnoredTicket]) -> None:
        self.ignored_tickets = records
        self.ignore_list_error = ""
        ignored_keys = set(records)
        self.snapshot = filter_snapshot(self.raw_snapshot, ignored_keys)
        self.risk_snapshot = filter_risk_snapshot(self.raw_risk_snapshot, ignored_keys)
        self.new_ids.difference_update(record.ticket_id for record in records.values())
        self.changed_risk_ids.difference_update(record.ticket_id for record in records.values())

    def _mouse_enter(self, _event: tk.Event) -> None:
        if self.collapse_after_id:
            self.root.after_cancel(self.collapse_after_id)
            self.collapse_after_id = None
        self._cancel_dock_hide()
        if self.dock_hidden:
            self._show_dock()
        self._set_opacity(hover=True)

    def _mouse_leave(self, _event: tk.Event) -> None:
        self._set_opacity(hover=False)
        if self.expanded and not self.dragging:
            self.collapse_after_id = self.root.after(2600, lambda: self.set_expanded(False))
        elif self.dock_side and not self.dragging:
            self._schedule_dock_hide()

    def _mouse_down(self, event: tk.Event) -> None:
        self._cancel_dock_hide()
        if self.dock_hidden or self.dock_animating:
            return
        if self.expanded:
            if self._inside(self.awake_rect, event.x, event.y):
                self._toggle_mouse_keep_awake()
                return
            if self._inside(self.refresh_rect, event.x, event.y):
                self.refresh(True)
                return
            if self._inside(self.collapse_rect, event.x, event.y):
                self.set_expanded(False)
                return
            if self.active_page == "workload" and self._inside(self.employee_rect, event.x, event.y):
                self._set_workload_identity()
                return
            for index, rect in enumerate(self.page_rects):
                if self._inside(rect, event.x, event.y):
                    self.active_page = ("unassigned", "sla", "workload")[index]
                    self.filter_name = "ALL"
                    self.scroll_offset = 0
                    self._redraw()
                    return
            for index, rect in enumerate(self.filter_rects):
                if self._inside(rect, event.x, event.y):
                    if self.active_page == "unassigned":
                        self.filter_name = ("ALL", "INC", "WO")[index]
                    elif self.active_page == "sla":
                        self.filter_name = ("ALL", "CRITICAL", "WARNING")[index]
                    self.scroll_offset = 0
                    self._redraw()
                    return
            if event.y > 62:
                return
        else:
            if self._inside(self.awake_rect, event.x, event.y):
                self._toggle_mouse_keep_awake()
                return
            if self._inside(self.sla_collapsed_rect, event.x, event.y):
                self.active_page = "sla"
                self.set_expanded(True)
                return
        self.dragging = True
        self.drag_moved = False
        self.drag_start = (event.x_root, event.y_root)
        self.drag_origin = (self.anchor_right, self.top)

    def _mouse_drag(self, event: tk.Event) -> None:
        if not self.dragging:
            return
        dx = event.x_root - self.drag_start[0]
        dy = event.y_root - self.drag_start[1]
        if abs(dx) > 3 or abs(dy) > 3:
            self.drag_moved = True
            self.dock_side = None
            self.dock_hidden = False
        width = self.root.winfo_width()
        height = self.root.winfo_height()
        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()
        self.anchor_right = max(width, min(screen_width, self.drag_origin[0] + dx))
        self.top = max(0, min(screen_height - height, self.drag_origin[1] + dy))
        self._set_geometry(width, height)

    def _mouse_up(self, _event: tk.Event) -> None:
        if not self.dragging:
            return
        self.dragging = False
        if self.drag_moved:
            side = None
            if bool(self.config.get("dockEnabled", True)):
                side = detect_dock_side(
                    self.anchor_right - self.root.winfo_width(),
                    self.root.winfo_width(),
                    self.root.winfo_screenwidth(),
                    int(self.config["dockSnapDistance"]),
                )
            if side:
                self._snap_to_dock(side)
                return
            self.dock_side = None
            self.dock_hidden = False
        elif not self.expanded:
            self.set_expanded(True)
        self._save_position()

    def _double_click(self, event: tk.Event) -> None:
        if not self.expanded:
            self.set_expanded(True)
            return
        if not (self.list_top <= event.y <= self.list_bottom):
            return
        if self.active_page == "workload":
            return
        ticket = self._ticket_at_position(event.x, event.y)
        if ticket is not None:
            ticket_id = ticket.ticket_id
            try:
                self.root.clipboard_clear()
                self.root.clipboard_append(ticket_id)
                self.root.update()
                self._show_toast("已复制 %s" % ticket_id)
            except tk.TclError:
                pass

    def _mouse_wheel(self, event: tk.Event) -> None:
        if not self.expanded or self.active_page == "workload":
            return
        viewport = max(1, self.list_bottom - self.list_top)
        _, content = self._list_layout()
        maximum = max(0, content - viewport)
        step = -1 if event.delta > 0 else 1
        self.scroll_offset = max(0, min(maximum, self.scroll_offset + step * 64))
        self._redraw()

    @staticmethod
    def _inside(rect: Tuple[int, int, int, int], x: int, y: int) -> bool:
        return rect[0] <= x <= rect[2] and rect[1] <= y <= rect[3]

    def _save_position(self) -> None:
        self.config["position"] = {
            "anchorRight": self.anchor_right,
            "top": self.top,
            "dockSide": self.dock_side,
        }
        save_config(self.config)

    def _cancel_dock_hide(self) -> None:
        if self.dock_hide_after_id:
            self.root.after_cancel(self.dock_hide_after_id)
            self.dock_hide_after_id = None

    def _schedule_dock_hide(self, delay_ms: Optional[int] = None) -> None:
        self._cancel_dock_hide()
        if not self.dock_side or self.dragging or self.dock_hidden:
            return
        delay = int(delay_ms if delay_ms is not None else self.config["dockHideDelayMs"])
        self.dock_hide_after_id = self.root.after(delay, self._hide_dock_if_idle)

    def _hide_dock_if_idle(self) -> None:
        self.dock_hide_after_id = None
        if not self.dock_side or self.dragging or self.expanded or self._pointer_inside_window():
            return
        self._hide_dock()

    def _pointer_inside_window(self) -> bool:
        try:
            pointer_x = self.root.winfo_pointerx()
            pointer_y = self.root.winfo_pointery()
            left = self.root.winfo_rootx()
            top = self.root.winfo_rooty()
            return (
                left <= pointer_x < left + self.root.winfo_width()
                and top <= pointer_y < top + self.root.winfo_height()
            )
        except tk.TclError:
            return False

    def _snap_to_dock(self, side: str) -> None:
        self.dock_side = side
        self.dock_hidden = False
        width = self.root.winfo_width()
        target_x = dock_target_x(
            side,
            False,
            width,
            self.root.winfo_screenwidth(),
            int(self.config["dockStripWidth"]),
        )
        self._animate_window_x(target_x, hidden_at_end=False, save_at_end=True)

    def _show_dock(self) -> None:
        if not self.dock_side:
            return
        self._cancel_dock_hide()
        self.dock_hidden = False
        width, height = COLLAPSED_SIZE
        x = 0 if self.dock_side == "left" else self.root.winfo_screenwidth() - width
        self._set_geometry_at_x(width, height, x)
        self._set_opacity(hover=True)
        self._redraw()

    def _hide_dock(self) -> None:
        if not self.dock_side or self.expanded or self.dragging:
            return
        width = int(self.config["dockStripWidth"])
        height = COLLAPSED_SIZE[1]
        x = 0 if self.dock_side == "left" else self.root.winfo_screenwidth() - width
        self.dock_hidden = True
        self._set_geometry_at_x(width, height, x)
        self._set_opacity()
        self._redraw()

    def _animate_window_x(self, target_x: int, hidden_at_end: bool, save_at_end: bool = False) -> None:
        self.dock_animation_generation += 1
        generation = self.dock_animation_generation
        self.dock_animating = True
        width = self.root.winfo_width()
        height = self.root.winfo_height()
        start_x = self.anchor_right - width
        distance = target_x - start_x

        def animate(step: int = 1) -> None:
            if generation != self.dock_animation_generation:
                return
            total = 11
            linear = min(1.0, step / total)
            eased = 1.0 - (1.0 - linear) ** 3
            x = round(start_x + distance * eased)
            self._set_geometry_at_x(width, height, x)
            if step < total:
                self.root.after(15, lambda: animate(step + 1))
                return
            self.dock_hidden = hidden_at_end
            self.dock_animating = False
            self._set_opacity()
            self._redraw()
            if save_at_end:
                self._save_position()

        animate()

    def _set_opacity(self, hover: bool = False) -> None:
        base = float(self.config["expandedOpacity"] if self.expanded else self.config["collapsedOpacity"])
        if self.dock_hidden:
            base = max(base, 0.82)
        if hover:
            base = min(1.0, base + (0.03 if self.expanded else 0.18))
        try:
            self.root.attributes("-alpha", base)
        except tk.TclError:
            pass

    def set_expanded(self, value: bool) -> None:
        if self.dock_hidden:
            self._show_dock()
            return
        if self.animating or self.dock_animating or self.expanded == value:
            return
        self._cancel_dock_hide()
        self.target_expanded = value
        self.animating = True
        start_width = self.root.winfo_width()
        start_height = self.root.winfo_height()
        fixed_anchor_right = self.anchor_right
        target_width, target_height = EXPANDED_SIZE if value else COLLAPSED_SIZE
        screen_height = self.root.winfo_screenheight()
        target_height = min(target_height, max(COLLAPSED_SIZE[1], screen_height - 30))
        if value:
            self.expanded = True

        def animate(step: int = 1) -> None:
            total = 10
            linear = min(1.0, step / total)
            eased = 1.0 - (1.0 - linear) ** 3
            width = round(start_width + (target_width - start_width) * eased)
            height = round(start_height + (target_height - start_height) * eased)
            self.top = max(0, min(self.root.winfo_screenheight() - height, self.top))
            if self.dock_side == "left":
                x = 0
            elif self.dock_side == "right":
                x = self.root.winfo_screenwidth() - width
            else:
                x = fixed_anchor_right - width
            self._set_geometry_at_x(width, height, x)
            self._redraw()
            if step < total:
                self.root.after(16, lambda: animate(step + 1))
            else:
                self.expanded = value
                self.animating = False
                if not value:
                    self.scroll_offset = 0
                self._set_opacity()
                self._redraw()
                if not value and self.dock_side and not self._pointer_inside_window():
                    self._schedule_dock_hide()

        animate()

    def refresh(self, force: bool) -> None:
        if self.loading:
            return
        self.loading = True
        self._redraw()
        self._ensure_result_poller()

        def worker() -> None:
            ignore_path = configured_ignore_list_path(self.config)
            if ignore_path is not None:
                try:
                    records = read_ignored_tickets_shared(ignore_path)
                    self.result_queue.put(("ignore_read", True, records))
                except Exception as error:
                    logging.exception("轮询共享忽略列表失败")
                    self.result_queue.put(("ignore_read", False, str(error)))
            try:
                self.result_queue.put(("unassigned", True, fetch_snapshot(self.config, force)))
            except Exception as error:
                logging.exception("刷新未分配工单失败")
                self.result_queue.put(("unassigned", False, str(error)))
            try:
                self.result_queue.put(("sla", True, fetch_risk_snapshot(self.config, force)))
            except Exception as error:
                logging.exception("刷新SLA风险失败")
                self.result_queue.put(("sla", False, str(error)))
            if (
                str(self.config.get("ufNumber") or "").strip()
                and str(self.config.get("remedyAssignee") or "").strip()
            ):
                try:
                    self.result_queue.put(("workload", True, fetch_workload_snapshot(self.config, force)))
                except Exception as error:
                    logging.exception("刷新个人工作量失败")
                    self.result_queue.put(("workload", False, str(error)))
            self.result_queue.put(("done", True, None))

        threading.Thread(target=worker, name="ticket-refresh", daemon=True).start()

    def _process_results(self) -> None:
        self.result_check_after_id = None
        try:
            while True:
                kind, success, result = self.result_queue.get_nowait()
                if kind.startswith("update_"):
                    self._handle_update_result(kind, success, result)
                    if kind == "update_ready" and success:
                        return
                elif kind == "ignore_read":
                    if success:
                        self._apply_ignored_tickets(result)
                    else:
                        message = str(result or "共享忽略列表读取失败")
                        if message != self.ignore_list_error:
                            self._show_toast("共享忽略列表读取失败", 4200)
                        self.ignore_list_error = message
                elif kind == "ignore_reload":
                    self.ignore_write_pending = False
                    if success:
                        self._apply_ignored_tickets(result)
                        self._show_toast("共享忽略列表已刷新", 2800)
                    else:
                        self.ignore_list_error = str(result or "共享忽略列表读取失败")
                        self._show_toast("共享忽略列表读取失败", 4200)
                elif kind == "ignore_mutation":
                    self.ignore_write_pending = False
                    if success:
                        records, success_message = result
                        self._apply_ignored_tickets(records)
                        self._show_toast(str(success_message), 3600)
                    else:
                        self.ignore_list_error = str(result or "共享忽略列表更新失败")
                        self._show_toast("共享忽略列表更新失败", 4200)
                elif kind == "unassigned":
                    if success:
                        self._apply_snapshot(result)
                    else:
                        self.connected = False
                        self.last_error = str(result or "未分配工单刷新失败")
                elif kind == "sla":
                    if success:
                        self._apply_risk_snapshot(result)
                    else:
                        self.risk_connected = False
                        self.risk_last_error = str(result or "SLA风险刷新失败")
                elif kind == "workload":
                    if success:
                        self.workload_snapshot = result
                        self.workload_connected = True
                        self.workload_last_error = ""
                    else:
                        self.workload_connected = False
                        self.workload_last_error = str(result or "个人工作量刷新失败")
                elif kind == "done":
                    self.loading = False
                    self._schedule_poll()
                self._redraw()
        except queue.Empty:
            pass
        if (self.loading or self.ignore_write_pending or self.update_busy) and self.result_check_after_id is None:
            self.result_check_after_id = self.root.after(100, self._process_results)

    def _schedule_poll(self) -> None:
        if self.poll_after_id:
            self.root.after_cancel(self.poll_after_id)
        interval = min(
            int(self.config["refreshSeconds"]),
            int(self.config["slaRefreshSeconds"]),
            int(self.config["workloadRefreshSeconds"]),
        )
        self.poll_after_id = self.root.after(interval * 1000, lambda: self.refresh(False))

    def _apply_snapshot(self, snapshot: Snapshot) -> None:
        self.raw_snapshot = snapshot
        filtered = filter_snapshot(snapshot, set(self.ignored_tickets))
        current_ids = {item.ticket_id for item in filtered.items}
        raw_ids = {item.ticket_id for item in snapshot.items}
        self.new_ids = current_ids - self.seen_ids if self.seen_initialized else set()
        handoffs = {
            item.ticket_id for item in filtered.items
            if item.handling_kind == "agent_handoff" and self.seen_initialized
            and self.seen_handling_kinds.get(ticket_key(item.ticket_type, item.ticket_id)) != "agent_handoff"
        } if not snapshot.stale else set()
        if not snapshot.stale:
            for item in snapshot.items:
                self.seen_handling_kinds[ticket_key(item.ticket_type, item.ticket_id)] = item.handling_kind
        new_unassigned = self.new_ids - handoffs
        self.new_ids.update(handoffs)
        self.seen_ids.update(raw_ids)
        self.seen_initialized = True
        self.snapshot = filtered
        self.connected = True
        self.last_error = ""
        if self.new_ids and bool(self.config.get("notify", True)):
            parts = []
            if handoffs:
                parts.append("Agent转人工 %d 张" % len(handoffs))
            if new_unassigned:
                parts.append("新增待处理 %d 张" % len(new_unassigned))
            self._show_toast(" · ".join(parts), 4200)
            self._beep()

    def _apply_risk_snapshot(self, snapshot: RiskSnapshot) -> None:
        self.raw_risk_snapshot = snapshot
        filtered = filter_risk_snapshot(snapshot, set(self.ignored_tickets))
        current_levels = {item.ticket_id: item.risk_level for item in filtered.items}
        raw_levels = {item.ticket_id: item.risk_level for item in snapshot.items}
        rank = {"warning": 1, "critical": 2, "breached": 3}
        changed: Set[str] = set()
        if self.risk_initialized:
            for ticket_id, level in current_levels.items():
                previous = self.risk_levels.get(ticket_id)
                if previous is None or rank.get(level, 0) > rank.get(previous, 0):
                    changed.add(ticket_id)
        self.risk_levels = raw_levels
        self.risk_initialized = True
        self.changed_risk_ids = changed
        self.risk_snapshot = filtered
        self.risk_connected = True
        self.risk_last_error = ""
        if changed and bool(self.config.get("notify", True)):
            worst = max((current_levels[item] for item in changed), key=lambda level: rank.get(level, 0))
            if worst == "breached":
                message = "警告：%d 张工单已超过SLA" % len(changed)
            elif worst == "critical":
                message = "%d 张工单进入SLA紧急状态" % len(changed)
            else:
                message = "%d 张工单进入SLA风险" % len(changed)
            self._show_toast(message, 5200)
            if self.dock_hidden:
                self._show_dock()
                self._schedule_dock_hide(5200)
            self._beep()

    @staticmethod
    def _beep() -> None:
        if os.name == "nt":
            try:
                ctypes.windll.user32.MessageBeep(0x00000030)
            except Exception:
                pass

    def _show_toast(self, text: str, milliseconds: int = 2400) -> None:
        self.toast_text = text
        if self.toast_after_id:
            self.root.after_cancel(self.toast_after_id)
        self.toast_after_id = self.root.after(milliseconds, self._clear_toast)
        self._redraw()

    def _clear_toast(self) -> None:
        self.toast_text = ""
        self.toast_after_id = None
        self._redraw()

    def _filtered_items(self) -> List[Ticket]:
        if self.active_page == "workload":
            return []
        if self.active_page == "sla":
            items: List[Ticket] = list(self.risk_snapshot.items)
            if self.filter_name == "CRITICAL":
                return [item for item in items if isinstance(item, RiskTicket) and item.risk_level in {"critical", "breached"}]
            if self.filter_name == "WARNING":
                return [item for item in items if isinstance(item, RiskTicket) and item.risk_level == "warning"]
            return items
        if self.filter_name == "ALL":
            return list(self.snapshot.items)
        return [item for item in self.snapshot.items if item.ticket_type == self.filter_name]

    def _list_layout(self):
        items = self._filtered_items()
        rows = []
        top = 1
        if self.active_page == "sla":
            for ticket in items:
                rows.append(("ticket", ticket, top, 122))
                top += 122
        else:
            for group, label in (("agent_handoff", "待人工处理"), ("unassigned", "未分配")):
                selected = [item for item in items if item.handling_kind == group]
                rows.append(("header", (label, len(selected), group), top, 36))
                top += 36
                if not selected:
                    rows.append(("empty", "暂无工单", top, 36))
                    top += 36
                for ticket in selected:
                    rows.append(("ticket", ticket, top, 102))
                    top += 102
                top += 12
        return rows, top

    def _redraw(self) -> None:
        self.canvas.delete("all")
        width = max(1, self.window_width)
        height = max(1, self.window_height)
        if self.dock_hidden and self.dock_side:
            self._draw_dock_strip(width, height)
            return
        border = self.BORDER if self.connected or self.loading else self.RED
        self.canvas.rounded_rectangle(1, 1, width - 1, height - 1, 17, fill=self.BG, outline=border, width=1)
        if self.expanded:
            self._draw_expanded(width, height)
        else:
            self._draw_collapsed(width, height)

    def _draw_dock_strip(self, width: int, height: int) -> None:
        strip_width = min(width, int(self.config["dockStripWidth"]))
        x1, x2 = 1, strip_width - 1
        arrow = ">" if self.dock_side == "left" else "<"
        center = (x1 + x2) / 2
        status_color = self.AMBER if self.snapshot.stale or self.risk_snapshot.stale else self.GREEN
        if not self.connected or not self.risk_connected:
            status_color = self.CYAN if self.loading else self.RED

        border = self.CYAN if self.toast_text else self.BORDER
        self.canvas.rounded_rectangle(x1, 1, x2, height - 1, 10, fill=self.BG, outline=border, width=1)
        self.canvas.create_oval(center - 4, 9, center + 4, 17, fill=status_color, outline="")

        new_inc = any(item.ticket_id in self.new_ids and item.ticket_type == "INC" for item in self.snapshot.items)
        new_wo = any(item.ticket_id in self.new_ids and item.ticket_type == "WO" for item in self.snapshot.items)
        self._draw_strip_count(x1 + 3, 25, x2 - 3, 72, "I", self.snapshot.inc, self.INC, new_inc)
        self._draw_strip_count(x1 + 3, 77, x2 - 3, 124, "W", self.snapshot.wo, self.WO, new_wo)
        self._draw_strip_count(x1 + 3, 129, x2 - 3, 178, "R", self.risk_snapshot.total,
                               "#ff375f", bool(self.changed_risk_ids) or self.risk_snapshot.breached > 0)
        if self.loading:
            self.canvas.rounded_rectangle(x1 + 6, 184, x2 - 6, 187, 2, fill=self.CYAN, outline="")
        self.canvas.create_text(center, height - 11, text=arrow, fill=self.MUTED, font=self.font_small)

    def _draw_strip_count(
        self,
        x1: int,
        y1: int,
        x2: int,
        y2: int,
        label: str,
        value: int,
        color: str,
        highlighted: bool,
    ) -> None:
        fill = {"I": "#4a2b1b", "W": "#1d3762", "R": "#5f1727"}.get(label, self.PANEL)
        self.canvas.rounded_rectangle(
            x1,
            y1,
            x2,
            y2,
            7,
            fill=fill,
            outline=color if highlighted else "",
            width=2 if highlighted else 1,
        )
        center = (x1 + x2) / 2
        self.canvas.create_text(center, y1 + 13, text=label, fill=color, font=self.font_strip_label)
        display_value = "99+" if value > 99 else str(value)
        self.canvas.create_text(center, y1 + 32, text=display_value, fill=self.TEXT, font=self.font_strip_count)

    def _draw_collapsed(self, width: int, height: int) -> None:
        status_color = self.AMBER if self.snapshot.stale or self.risk_snapshot.stale else self.GREEN
        if not self.connected or not self.risk_connected:
            status_color = self.CYAN if self.loading else self.RED
        self.canvas.create_oval(13, 14, 21, 22, fill=status_color, outline="")
        self.canvas.create_text(28, 18, text="待处理", fill="#cbd5e1", font=self.font_label, anchor="w")
        self.awake_rect = (width - 28, 7, width - 7, 30)
        self._draw_awake_button(self.awake_rect)
        self.canvas.create_text(width / 2, 58, text=str(self.snapshot.total), fill=self.TEXT, font=self.font_hero)
        self._small_count(9, 82, width - 9, 108, "INC", self.snapshot.inc, self.INC)
        self._small_count(9, 114, width - 9, 140, "WO", self.snapshot.wo, self.WO)
        self.sla_collapsed_rect = (9, 148, width - 9, 192)
        risk_outline = "#ff375f" if self.risk_snapshot.total or self.changed_risk_ids else "#7f1d3a"
        self.canvas.rounded_rectangle(*self.sla_collapsed_rect, 10, fill="#581326", outline=risk_outline, width=2)
        self.canvas.create_text(19, 170, text="SLA风险", fill="#ff8aa2", font=self.font_small, anchor="w")
        self.canvas.create_text(width - 18, 170, text=str(self.risk_snapshot.total), fill="#ffffff",
                                font=self.font_count, anchor="e")
        if self.loading:
            self.canvas.create_oval(width - 36, 15, width - 30, 21, fill=self.CYAN, outline="")
        if self.toast_text:
            toast_fill = "#be123c" if "SLA" in self.toast_text or "超时" in self.toast_text else "#0284c7"
            self.canvas.rounded_rectangle(5, height - 55, width - 5, height - 5, 9, fill=toast_fill, outline="")
            self.canvas.create_text(width / 2, height - 30, text=self._ellipsis(self.toast_text, 24),
                                    width=width - 18, justify="center", fill="#ffffff", font=self.font_small)

    def _small_count(self, x1: int, y1: int, x2: int, y2: int, label: str, value: int, color: str) -> None:
        self.canvas.rounded_rectangle(x1, y1, x2, y2, 8, fill=self.PANEL, outline="")
        self.canvas.create_text(x1 + 8, (y1 + y2) / 2, text=label, fill=color, font=self.font_small, anchor="w")
        self.canvas.create_text(x2 - 10, (y1 + y2) / 2, text=str(value), fill=self.TEXT, font=self.font_id, anchor="e")

    def _draw_awake_button(self, rect: Tuple[int, int, int, int]) -> None:
        fill = "#14532d" if self.mouse_keep_awake else self.PANEL
        outline = self.GREEN if self.mouse_keep_awake else self.BORDER
        text_color = "#dcfce7" if self.mouse_keep_awake else self.MUTED
        self.canvas.rounded_rectangle(*rect, 7, fill=fill, outline=outline, width=1)
        x1, y1, x2, y2 = rect
        self.canvas.create_text((x1 + x2) / 2, (y1 + y2) / 2, text="防",
                                fill=text_color, font=self.font_small)

    def _draw_expanded(self, width: int, height: int) -> None:
        self.canvas.create_text(20, 25, text="工单监控", fill=self.TEXT, font=self.font_title, anchor="w")
        if self.active_page == "unassigned":
            page_connected, page_stale, page_error = self.connected, self.snapshot.stale, self.last_error
        elif self.active_page == "sla":
            page_connected, page_stale, page_error = (
                self.risk_connected,
                self.risk_snapshot.stale,
                self.risk_last_error,
            )
        else:
            page_connected, page_stale, page_error = (
                self.workload_connected,
                self.workload_snapshot.stale,
                self.workload_last_error,
            )
        status_color = self.GREEN if page_connected and not page_stale else self.AMBER
        status_text = "连接正常"
        if self.loading:
            status_color, status_text = self.CYAN, "正在刷新"
        elif self.active_page == "workload" and not (
            str(self.config.get("ufNumber") or "").strip()
            and str(self.config.get("remedyAssignee") or "").strip()
        ):
            status_color, status_text = self.AMBER, "未设置个人信息"
        elif not page_connected:
            status_color, status_text = self.RED, "连接失败"
        elif page_stale:
            status_text = "缓存数据"
        self.canvas.create_oval(19, 48, 27, 56, fill=status_color, outline="")
        self.canvas.create_text(34, 52, text=status_text, fill=self.MUTED, font=self.font_small, anchor="w")
        self.awake_rect = (width - 148, 15, width - 116, 47)
        self.refresh_rect = (width - 108, 15, width - 54, 47)
        self.collapse_rect = (width - 46, 15, width - 14, 47)
        self._draw_awake_button(self.awake_rect)
        self.canvas.rounded_rectangle(*self.refresh_rect, 9, fill=self.PANEL, outline="")
        self.canvas.create_text(width - 81, 31, text="刷新", fill=self.MUTED if self.loading else self.TEXT,
                                font=self.font_small)
        self.canvas.rounded_rectangle(*self.collapse_rect, 9, fill=self.PANEL, outline="")
        self.canvas.create_text(width - 30, 28, text="—", fill=self.TEXT, font=self.font_id)

        self.page_rects = []
        page_top = 68
        page_gap = 6
        page_width = (width - 28 - page_gap * 2) // 3
        workload_value = "--"
        if self.workload_snapshot.complete and self.workload_snapshot.completion_percent is not None:
            workload_value = "%.0f%%" % self.workload_snapshot.completion_percent
        for index, (name, label, value, accent) in enumerate((
            ("unassigned", "待处理", self.snapshot.total, self.CYAN),
            ("sla", "SLA风险", self.risk_snapshot.total, "#ff375f"),
            ("workload", "工作量", workload_value, "#a78bfa"),
        )):
            x1 = 14 + index * (page_width + page_gap)
            x2 = width - 14 if index == 2 else x1 + page_width
            rect = (x1, page_top, x2, page_top + 46)
            self.page_rects.append(rect)
            selected = self.active_page == name
            fill = "#4b1425" if name == "sla" and selected else (self.PANEL_ACTIVE if selected else self.PANEL)
            self.canvas.rounded_rectangle(*rect, 11, fill=fill, outline=accent if selected else "", width=1)
            self.canvas.create_text((x1 + x2) / 2, page_top + 14, text=label, fill=accent,
                                    font=self.font_small)
            self.canvas.create_text((x1 + x2) / 2, page_top + 33, text=str(value), fill=self.TEXT,
                                    font=self.font_id)

        if self.active_page == "workload":
            self.filter_rects = []
            self.list_top = 124
            self.list_bottom = height - 38
            self._draw_workload_page(width, height, page_connected, page_error)
            return

        top = 124
        gap = 8
        card_width = (width - 28 - gap * 2) // 3
        self.filter_rects = []
        if self.active_page == "unassigned":
            filter_data = (
                ("ALL", "全部", self.snapshot.total, self.CYAN),
                ("INC", "INC", self.snapshot.inc, self.INC),
                ("WO", "WO", self.snapshot.wo, self.WO),
            )
        else:
            filter_data = (
                ("ALL", "全部", self.risk_snapshot.total, "#ff375f"),
                ("CRITICAL", "紧急", self.risk_snapshot.critical + self.risk_snapshot.breached, "#ff375f"),
                ("WARNING", "预警", self.risk_snapshot.warning, self.AMBER),
            )
        for index, (name, label, value, accent) in enumerate(filter_data):
            x1 = 14 + index * (card_width + gap)
            x2 = width - 14 if index == 2 else x1 + card_width
            rect = (x1, top, x2, top + 58)
            self.filter_rects.append(rect)
            selected = self.filter_name == name
            self.canvas.rounded_rectangle(*rect, 11, fill=self.PANEL_ACTIVE if selected else self.PANEL,
                                          outline=accent if selected else "", width=1)
            self.canvas.create_text((x1 + x2) / 2, top + 20, text=str(value), fill=self.TEXT, font=self.font_count)
            self.canvas.create_text((x1 + x2) / 2, top + 43, text=label, fill=accent, font=self.font_small)

        self.list_top = 194
        self.list_bottom = height - 38
        rows, content = self._list_layout()
        self.scroll_offset = min(self.scroll_offset, max(0, content - (self.list_bottom - self.list_top)))
        header_ids = self.canvas.find_all()[1:]
        if not rows:
            self.canvas.create_text(width / 2, self.list_top + 50, text="当前没有SLA风险工单",
                                    fill=self.MUTED, font=self.font_body)
        for kind, value, top, row_height in rows:
            y = self.list_top + top - self.scroll_offset
            if y + row_height < self.list_top or y > self.list_bottom:
                continue
            if kind == "ticket":
                if isinstance(value, RiskTicket):
                    self._draw_risk_ticket(value, y, width)
                else:
                    self._draw_ticket(value, y, width)
            elif kind == "header":
                label, count, group = value
                color = "#7dd3fc" if group == "agent_handoff" else self.MUTED
                self.canvas.create_line(20, y + 1, width - 20, y + 1, fill=self.BORDER)
                self.canvas.create_text(24, y + 19, text="%s（%d）" % (label, count),
                                        fill=color, font=self.font_id, anchor="w")
            else:
                self.canvas.create_text(24, y + 15, text=value, fill=self.MUTED,
                                        font=self.font_small, anchor="w")
        # Mask list overflow, then restore the header above the mask.
        self.canvas.create_rectangle(10, 0, width - 10, self.list_top, fill=self.BG, outline="")
        self.canvas.create_rectangle(10, self.list_bottom, width - 10, height - 5, fill=self.BG, outline="")
        for item_id in header_ids:
            self.canvas.tag_raise(item_id)

        refreshed_at = self.snapshot.refreshed_at if self.active_page == "unassigned" else self.risk_snapshot.refreshed_at
        footer = "更新 %s" % self._short_time(refreshed_at) if page_connected else page_error
        self.canvas.create_text(16, height - 18, text=self._ellipsis(footer, 52),
                                fill=self.MUTED if self.connected else "#f87171", font=self.font_small, anchor="w")
        if self.toast_text:
            toast_width = min(250, width - 30)
            toast_fill = "#9f1239" if "SLA" in self.toast_text or "超时" in self.toast_text else "#0284c7"
            self.canvas.rounded_rectangle(width - toast_width - 15, height - 70, width - 15, height - 38, 9,
                                          fill=toast_fill, outline="")
            self.canvas.create_text(width - toast_width / 2 - 15, height - 54,
                                    text=self._ellipsis(self.toast_text, 34), fill="#f0f9ff", font=self.font_small)

    def _draw_workload_page(
        self, width: int, height: int, page_connected: bool, page_error: str
    ) -> None:
        snapshot = self.workload_snapshot
        uf_number = str(self.config.get("ufNumber") or "").strip()
        assignee = str(self.config.get("remedyAssignee") or "").strip()

        self.employee_rect = (14, 124, width - 14, 190)
        self.canvas.rounded_rectangle(*self.employee_rect, 11, fill=self.PANEL, outline="#475569")
        self.canvas.create_text(26, 145, text="UF号", fill=self.MUTED, font=self.font_small, anchor="w")
        self.canvas.create_text(84, 145, text=uf_number or "尚未设置", fill=self.TEXT,
                                font=self.font_id, anchor="w")
        self.canvas.create_text(26, 171, text="Remedy", fill=self.MUTED, font=self.font_small, anchor="w")
        self.canvas.create_text(84, 171, text=self._ellipsis(assignee or "尚未设置", 30), fill=self.TEXT,
                                font=self.font_small, anchor="w")
        self.canvas.create_text(width - 27, 145, text="修改", fill=self.CYAN,
                                font=self.font_small, anchor="e")

        if not uf_number or not assignee:
            self.canvas.rounded_rectangle(14, 204, width - 14, 325, 13, fill=self.PANEL, outline="")
            self.canvas.create_text(width / 2, 242, text="先设置个人信息", fill=self.TEXT, font=self.font_count)
            self.canvas.create_text(width / 2, 277, text="UF号用于JIRA，Remedy完整用户名用于工单统计",
                                    width=width - 60, justify="center", fill=self.MUTED, font=self.font_body)
            self._draw_workload_footer(width, height, "请先设置UF号和Remedy完整用户名", False)
            return

        self.canvas.create_text(18, 202, text=(snapshot.month or datetime.now().strftime("%Y-%m")) + " 月度工作量",
                                fill="#c4b5fd", font=self.font_label, anchor="w")

        target_y1, target_y2 = 219, 316
        self.canvas.rounded_rectangle(14, target_y1, width - 14, target_y2, 13,
                                      fill="#201d3a", outline="#6d5cae")
        self.canvas.create_text(28, target_y1 + 24, text="月目标", fill=self.MUTED,
                                font=self.font_small, anchor="w")
        self.canvas.create_text(28, target_y1 + 51, text=self._days_text(snapshot.target_days),
                                fill=self.TEXT, font=self.font_count, anchor="w")

        if snapshot.complete and snapshot.total_days is not None:
            percent = max(0.0, snapshot.completion_percent or 0.0)
            accent = self.GREEN if percent >= 100.0 else "#a78bfa"
            self.canvas.create_text(width - 28, target_y1 + 24, text="已完成", fill=self.MUTED,
                                    font=self.font_small, anchor="e")
            self.canvas.create_text(width - 28, target_y1 + 51, text=self._days_text(snapshot.total_days),
                                    fill=accent, font=self.font_count, anchor="e")
            bar_x1, bar_x2, bar_y = 28, width - 28, target_y1 + 70
            self.canvas.rounded_rectangle(bar_x1, bar_y, bar_x2, bar_y + 8, 4,
                                          fill="#111827", outline="")
            ratio = min(1.0, percent / 100.0)
            if ratio > 0:
                self.canvas.rounded_rectangle(bar_x1, bar_y, bar_x1 + (bar_x2 - bar_x1) * ratio,
                                              bar_y + 8, 4, fill=accent, outline="")
            remaining = snapshot.remaining_days or 0.0
            progress_text = "%.1f%% · %s" % (
                percent,
                "已达到目标" if remaining <= 0 else "还差 " + self._days_text(remaining),
            )
            self.canvas.create_text(28, target_y1 + 91, text=progress_text, fill=accent,
                                    font=self.font_small, anchor="w")
        else:
            self.canvas.create_text(width - 28, target_y1 + 37, text="数据源待配置",
                                    fill=self.AMBER, font=self.font_label, anchor="e")
            self.canvas.create_text(28, target_y1 + 83, text="JIRA与工单数据都接通后才计算合计，避免把缺失值当作0",
                                    width=width - 56, fill=self.MUTED, font=self.font_small, anchor="w")

        card_gap = 8
        card_width = (width - 28 - card_gap) / 2
        left = (14, 328, 14 + card_width, 430)
        right = (14 + card_width + card_gap, 328, width - 14, 430)
        self._draw_workload_source_card(
            left,
            "JIRA TASK",
            "#60a5fa",
            snapshot.jira_status,
            "Story Point %s" % self._number_text(snapshot.jira_story_points),
            self._days_text(snapshot.jira_days),
            snapshot.jira_error,
        )
        ticket_detail = "%s 张 × %.5f" % (
            self._number_text(snapshot.ticket_count),
            snapshot.ticket_days_per_ticket,
        )
        self._draw_workload_source_card(
            right,
            "工单",
            self.INC,
            snapshot.ticket_status,
            ticket_detail,
            self._days_text(snapshot.ticket_days),
            snapshot.ticket_error,
        )

        self.canvas.rounded_rectangle(14, 442, width - 14, 524, 12, fill=self.PANEL, outline="")
        self.canvas.create_text(28, 465, text="截至今天应完成", fill=self.MUTED,
                                font=self.font_small, anchor="w")
        self.canvas.create_text(width - 28, 465, text=self._days_text(snapshot.elapsed_target_days),
                                fill=self.TEXT, font=self.font_id, anchor="e")
        self.canvas.create_text(28, 496, text="当前进度达成率", fill=self.MUTED,
                                font=self.font_small, anchor="w")
        pace_text = "--" if snapshot.pace_percent is None else "%.1f%%" % snapshot.pace_percent
        pace_color = self.MUTED if snapshot.pace_percent is None else (
            self.GREEN if snapshot.pace_percent >= 100.0 else self.AMBER
        )
        self.canvas.create_text(width - 28, 496, text=pace_text, fill=pace_color,
                                font=self.font_count, anchor="e")

        footer = "更新 %s" % self._short_time(snapshot.refreshed_at) if page_connected else page_error
        self._draw_workload_footer(width, height, footer, page_connected)

    def _draw_workload_source_card(
        self,
        rect: Tuple[float, float, float, float],
        label: str,
        accent: str,
        status: str,
        detail: str,
        days_text: str,
        error: str,
    ) -> None:
        self.canvas.rounded_rectangle(*rect, 12, fill=self.PANEL, outline="")
        x1, y1, x2, _ = rect
        self.canvas.create_text(x1 + 12, y1 + 20, text=label, fill=accent,
                                font=self.font_label, anchor="w")
        if status == "ok":
            self.canvas.create_text(x1 + 12, y1 + 49, text=days_text, fill=self.TEXT,
                                    font=self.font_count, anchor="w")
            self.canvas.create_text(x1 + 12, y1 + 77, text=self._ellipsis(detail, 21),
                                    fill=self.MUTED, font=self.font_small, anchor="w")
        else:
            label_text = error or ("待配置" if status == "not_configured" else "查询失败")
            self.canvas.create_text((x1 + x2) / 2, y1 + 57, text=self._ellipsis(label_text, 18),
                                    width=x2 - x1 - 20, justify="center", fill=self.AMBER,
                                    font=self.font_small)

    def _draw_workload_footer(self, width: int, height: int, footer: str, connected: bool) -> None:
        self.canvas.create_text(16, height - 18, text=self._ellipsis(footer, 52),
                                fill=self.MUTED if connected else "#f87171",
                                font=self.font_small, anchor="w")
        if self.toast_text:
            toast_width = min(250, width - 30)
            self.canvas.rounded_rectangle(width - toast_width - 15, height - 70, width - 15,
                                          height - 38, 9, fill="#0284c7", outline="")
            self.canvas.create_text(width - toast_width / 2 - 15, height - 54,
                                    text=self._ellipsis(self.toast_text, 34), fill="#f0f9ff",
                                    font=self.font_small)

    @staticmethod
    def _number_text(value: Optional[float | int]) -> str:
        if value is None:
            return "--"
        if float(value).is_integer():
            return str(int(value))
        return ("%.4f" % float(value)).rstrip("0").rstrip(".")

    @classmethod
    def _days_text(cls, value: Optional[float]) -> str:
        return "--" if value is None else cls._number_text(value) + " 天"

    def _draw_ticket(self, ticket: Ticket, y: int, width: int) -> None:
        self.canvas.rounded_rectangle(14, y, width - 14, y + 93, 12,
                                      fill="#25354b" if ticket.ticket_id in self.new_ids else self.PANEL,
                                      outline=self.CYAN if ticket.ticket_id in self.new_ids else "")
        incident = ticket.ticket_type == "INC"
        accent = self.INC if incident else self.WO
        badge_bg = "#7c2d12" if incident else "#1e40af"
        self.canvas.rounded_rectangle(24, y + 13, 68, y + 35, 7, fill=badge_bg, outline="")
        self.canvas.create_text(46, y + 24, text=ticket.ticket_type or "OTHER", fill=accent, font=self.font_small)
        self.canvas.create_text(78, y + 23, text=self._ellipsis(ticket.ticket_id, 24),
                                fill=self.TEXT, font=self.font_id, anchor="w")
        priority_color = self._priority_color(ticket.priority)
        self.canvas.create_oval(width - 92, y + 19, width - 84, y + 27, fill=priority_color, outline="")
        self.canvas.create_text(width - 78, y + 23, text=ticket.priority or "未知",
                                fill="#cbd5e1", font=self.font_small, anchor="w")
        self.canvas.create_text(24, y + 50, text=self._ellipsis(ticket.summary or "无摘要", 51),
                                fill="#cbd5e1", font=self.font_body, anchor="w")
        self.canvas.create_text(24, y + 76, text=self._short_time(ticket.submit_time),
                                fill=self.MUTED, font=self.font_small, anchor="w")
        self.canvas.create_text(width - 24, y + 76,
                                text=self._ellipsis(ticket.status or "未知", 18),
                                fill="#7dd3fc", font=self.font_small, anchor="e")

    def _draw_risk_ticket(self, ticket: RiskTicket, y: int, width: int) -> None:
        color = {"warning": self.AMBER, "critical": "#ff375f", "breached": "#ff1744"}[ticket.risk_level]
        background = {"warning": "#332b1a", "critical": "#481827", "breached": "#5c1023"}[ticket.risk_level]
        label = {"warning": "临近", "critical": "紧急", "breached": "已超时"}[ticket.risk_level]
        highlighted = ticket.ticket_id in self.changed_risk_ids
        self.canvas.rounded_rectangle(14, y, width - 14, y + 113, 12, fill=background,
                                      outline=color, width=2 if highlighted else 1)
        self.canvas.rounded_rectangle(24, y + 12, 68, y + 34, 7,
                                      fill="#7c2d12" if ticket.ticket_type == "INC" else "#1e40af", outline="")
        self.canvas.create_text(46, y + 23, text=ticket.ticket_type, fill=self.INC if ticket.ticket_type == "INC" else self.WO,
                                font=self.font_small)
        self.canvas.create_text(78, y + 22, text=self._ellipsis(ticket.ticket_id, 21), fill=self.TEXT,
                                font=self.font_id, anchor="w")
        self.canvas.create_text(width - 25, y + 22, text=label, fill=color, font=self.font_small, anchor="e")
        self.canvas.create_text(24, y + 48, text=self._ellipsis(ticket.summary or "无摘要", 48),
                                fill="#f1f5f9", font=self.font_body, anchor="w")
        detail = "%s  ·  %s" % (ticket.status or "状态未知", ticket.assignee or "未分配")
        self.canvas.create_text(24, y + 69, text=self._ellipsis(detail, 42), fill="#cbd5e1",
                                font=self.font_small, anchor="w")
        bar_x1, bar_x2, bar_y = 24, width - 24, y + 83
        self.canvas.rounded_rectangle(bar_x1, bar_y, bar_x2, bar_y + 6, 3, fill="#111827", outline="")
        ratio = max(0.0, min(1.0, ticket.progress_percent / 100.0))
        if ratio > 0:
            self.canvas.rounded_rectangle(bar_x1, bar_y, bar_x1 + (bar_x2 - bar_x1) * ratio,
                                          bar_y + 6, 3, fill=color, outline="")
        self.canvas.create_text(24, y + 101, text="%.1f%%" % ticket.progress_percent, fill=color,
                                font=self.font_small, anchor="w")
        self.canvas.create_text(width - 24, y + 101, text=ticket.remaining_text or "时间未知", fill=color,
                                font=self.font_small, anchor="e")

    def _priority_color(self, priority: str) -> str:
        value = priority.strip().lower()
        if value in {"critical", "urgent"}:
            return "#f87171"
        if value == "high":
            return self.INC
        if value == "medium":
            return "#facc15"
        return "#4ade80"

    @staticmethod
    def _ellipsis(value: str, maximum: int) -> str:
        value = str(value or "").replace("\r", " ").replace("\n", " ").strip()
        return value if len(value) <= maximum else value[: max(1, maximum - 1)] + "…"

    @staticmethod
    def _short_time(value: str) -> str:
        text = str(value or "").replace("T", " ")
        return text[:16] if text else "时间未知"

    def run(self) -> None:
        self.root.mainloop()

    def close(self) -> None:
        self._stop_mouse_keep_awake(show_toast=False)
        self._save_position()
        try:
            self.root.destroy()
        except tk.TclError:
            pass


def acquire_single_instance() -> Optional[int]:
    if os.name != "nt":
        return None
    try:
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        kernel32.ReleaseMutex.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel32.CreateMutexW(None, True, "Local\\UnassignedTicketMonitorTk.Singleton")
        if not handle or kernel32.GetLastError() == 183:
            return 0
        return int(handle)
    except Exception:
        return None


def self_test() -> int:
    payload = {
        "success": True,
        "counts": {"total": 2, "inc": 1, "wo": 1},
        "items": [
            {"id": "INC001", "type": "INC", "summary": "测试", "priority": "Low", "submit_time": "2026-08-04T10:30:00"},
            {"id": "WO001", "type": "WO", "summary": "测试", "priority": "High", "submit_time": "2026-08-04T10:31:00"},
        ],
    }
    snapshot = parse_snapshot(payload)
    assert snapshot.total == 2 and snapshot.inc == 1 and snapshot.wo == 1
    assert snapshot.items[0].ticket_id == "INC001"
    assert detect_dock_side(0, 96, 1920, 18) == "left"
    assert detect_dock_side(1824, 96, 1920, 18) == "right"
    assert detect_dock_side(800, 96, 1920, 18) is None
    assert dock_target_x("left", True, 96, 1920, 32) == -64
    assert dock_target_x("right", True, 96, 1920, 32) == 1888
    risk = parse_risk_snapshot({
        "success": True,
        "counts": {"total": 1, "warning": 0, "critical": 1, "breached": 0, "inc": 1, "wo": 0},
        "items": [{
            "id": "INC-RISK", "type": "INC", "risk_level": "critical",
            "progress_percent": 95.0, "remaining_seconds": 300,
            "remaining_text": "剩余5分钟", "submit_time": "2026-08-04T10:00:00",
            "limit_time": "2026-08-04T11:00:00"
        }],
    })
    assert risk.total == 1 and risk.items[0].risk_level == "critical"
    workload = parse_workload_snapshot({
        "success": True,
        "complete": True,
        "unit": "day",
        "uf_number": "UF001234",
        "assignee": "YANG WENSHUAI , BBF-XXXX",
        "month": "2026-08",
        "target_days": 21,
        "elapsed_target_days": 20,
        "jira": {"status": "ok", "task_count": 4, "story_points": 10.5, "days": 10.5},
        "tickets": {"status": "ok", "count": 20, "days_per_ticket": 0.33625, "days": 6.725},
        "total_days": 17.225,
        "remaining_days": 3.325,
        "completion_percent": 84.2,
        "pace_percent": 88.4,
    })
    assert workload.total_days == 17.225 and workload.ticket_days == 6.725
    assert workload.uf_number == "UF001234"
    assert workload.assignee == "YANG WENSHUAI , BBF-XXXX"
    assert TicketMonitor._days_text(workload.total_days) == "17.225 天"
    ignored_key = ticket_key("INC", "INC001")
    filtered = filter_snapshot(snapshot, {ignored_key})
    assert filtered.total == 1 and filtered.inc == 0 and filtered.wo == 1
    filtered_risk = filter_risk_snapshot(risk, {ticket_key("INC", "INC-RISK")})
    assert filtered_risk.total == 0 and filtered_risk.critical == 0
    with tempfile.TemporaryDirectory() as directory:
        ignore_path = Path(directory) / "ignored-tickets.json"
        records = update_ignored_tickets(ignore_path, "add", ticket=snapshot.items[0])
        assert ignored_key in records
        loaded = read_ignored_tickets_shared(ignore_path)
        assert loaded[ignored_key].ticket_id == "INC001"
        records = update_ignored_tickets(ignore_path, "remove", key=ignored_key)
        assert not records
    print("self-test passed")
    return 0


def main() -> int:
    setup_logging()
    if "--self-test" in sys.argv:
        return self_test()
    mutex = acquire_single_instance()
    if mutex == 0:
        return 0
    try:
        TicketMonitor().run()
        return 0
    except Exception:
        logging.exception("程序启动失败")
        if os.name == "nt":
            try:
                ctypes.windll.user32.MessageBoxW(None, "程序启动失败，请查看 ticket-monitor.log", APP_NAME, 0x10)
            except Exception:
                pass
        return 1
    finally:
        if mutex and os.name == "nt":
            try:
                ctypes.windll.kernel32.ReleaseMutex(mutex)
                ctypes.windll.kernel32.CloseHandle(mutex)
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())

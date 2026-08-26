"""Read-only proxy routes for PLC switch reports."""

from __future__ import annotations

import re
import urllib.error
import urllib.parse
import urllib.request

from flask import Blueprint, Response, jsonify, request


PLC_SWITCH_API_BASE = "http://127.0.0.1:1999"
TASK_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}$")


def _proxy_get(path: str, query: dict[str, str], timeout: int) -> Response:
    query_text = urllib.parse.urlencode(query)
    url = f"{PLC_SWITCH_API_BASE}{path}"
    if query_text:
        url = f"{url}?{query_text}"

    upstream_request = urllib.request.Request(
        url,
        method="GET",
        headers={"Accept": "application/json, text/html"},
    )
    # The target is localhost. Ignore machine-wide HTTP proxy settings so the
    # report request never leaves this Windows server.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(upstream_request, timeout=timeout) as upstream:
            body = upstream.read()
            response = Response(
                body,
                status=getattr(upstream, "status", 200),
                content_type=upstream.headers.get("Content-Type")
                or "application/octet-stream",
            )
            disposition = upstream.headers.get("Content-Disposition")
            if disposition:
                response.headers["Content-Disposition"] = disposition
            response.headers["Cache-Control"] = "no-store"
            return response
    except urllib.error.HTTPError as exc:
        body = exc.read()
        response = Response(
            body,
            status=exc.code,
            content_type=exc.headers.get("Content-Type") or "application/json",
        )
        response.headers["Cache-Control"] = "no-store"
        return response
    except (urllib.error.URLError, TimeoutError, OSError):
        return (
            jsonify(
                {
                    "success": False,
                    "error": "PLC报告服务当前无法连接",
                }
            ),
            502,
        )


def create_plc_report_blueprint() -> Blueprint:
    blueprint = Blueprint("plc_switch_reports", __name__)

    @blueprint.route("/api/widgets/plc-switch-reports/records", methods=["GET"])
    def api_plc_switch_report_records():
        try:
            page = int(request.args.get("page", "1"))
            page_size = int(request.args.get("page_size", "200"))
        except ValueError:
            return jsonify({"success": False, "error": "分页参数必须是整数"}), 400
        if page < 1 or page_size < 1 or page_size > 200:
            return jsonify({"success": False, "error": "分页参数超出允许范围"}), 400
        return _proxy_get(
            "/api/plc-switch/records",
            {"page": str(page), "page_size": str(page_size)},
            timeout=10,
        )

    @blueprint.route(
        "/api/widgets/plc-switch-reports/report/<task_id>", methods=["GET"]
    )
    def api_plc_switch_report_download(task_id: str):
        if not TASK_ID_RE.fullmatch(task_id):
            return jsonify({"success": False, "error": "任务ID格式不合法"}), 400
        quoted_task_id = urllib.parse.quote(task_id, safe="")
        return _proxy_get(
            f"/api/plc-switch/export-report/{quoted_task_id}",
            {"format": "html", "download": "1"},
            timeout=30,
        )

    return blueprint

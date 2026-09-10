"""Flask routes for the unassigned-ticket monitor."""

from __future__ import annotations

import os

from flask import Blueprint, jsonify, render_template, request

from core.unassigned_ticket_service import (
    TicketDatabaseNotConfigured,
    TicketQueryFailed,
    UnassignedTicketService,
)
from core.sla_risk_service import SlaRiskService
from core.workload_service import InvalidWorkloadRequest, WorkloadService


def create_unassigned_ticket_blueprint(
    service: UnassignedTicketService,
    sla_service: SlaRiskService | None = None,
    workload_service: WorkloadService | None = None,
) -> Blueprint:
    if workload_service is None:
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        workload_service = WorkloadService.from_environment(project_root)
    blueprint = Blueprint("unassigned_ticket", __name__)

    @blueprint.route("/api/unassigned-tickets", methods=["GET"])
    def api_unassigned_tickets():
        force = str(request.args.get("refresh") or "").lower() in {"1", "true", "yes"}
        try:
            return jsonify(service.get_snapshot(force=force))
        except TicketDatabaseNotConfigured:
            return (
                jsonify(
                    {
                        "success": False,
                        "code": "DATABASE_NOT_CONFIGURED",
                        "error": "未配置工单数据库",
                    }
                ),
                503,
            )
        except TicketQueryFailed:
            return (
                jsonify(
                    {
                        "success": False,
                        "code": "DATABASE_QUERY_FAILED",
                        "error": "工单数据库查询失败",
                    }
                ),
                503,
            )

    @blueprint.route("/ticket-monitor", methods=["GET"])
    def ticket_monitor():
        return render_template("ticket_monitor.html")

    @blueprint.route("/api/sla-risk-tickets", methods=["GET"])
    def api_sla_risk_tickets():
        if sla_service is None:
            return jsonify({"success": False, "error": "SLA风险服务未启用"}), 503
        force = str(request.args.get("refresh") or "").lower() in {"1", "true", "yes"}
        try:
            return jsonify(sla_service.get_snapshot(force=force))
        except TicketDatabaseNotConfigured:
            return jsonify({"success": False, "error": "未配置工单数据库"}), 503
        except TicketQueryFailed:
            return jsonify({"success": False, "error": "SLA工单数据库查询失败"}), 503

    @blueprint.route("/api/workload/summary", methods=["GET"])
    def api_workload_summary():
        legacy_employee_id = str(request.args.get("employee_id") or "").strip()
        uf_number = str(request.args.get("uf_number") or legacy_employee_id).strip()
        assignee = str(request.args.get("assignee") or legacy_employee_id).strip()
        month = str(request.args.get("month") or "").strip()
        if not month:
            from datetime import date
            month = date.today().strftime("%Y-%m")
        force = str(request.args.get("refresh") or "").lower() in {"1", "true", "yes"}
        try:
            return jsonify(
                workload_service.get_summary(
                    uf_number,
                    assignee,
                    month,
                    force=force,
                )
            )
        except InvalidWorkloadRequest as error:
            return jsonify({"success": False, "error": str(error)}), 400

    return blueprint

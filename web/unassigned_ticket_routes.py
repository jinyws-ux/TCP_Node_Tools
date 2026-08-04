"""Flask routes for the unassigned-ticket monitor."""

from __future__ import annotations

from flask import Blueprint, jsonify, render_template, request

from core.unassigned_ticket_service import (
    TicketDatabaseNotConfigured,
    TicketQueryFailed,
    UnassignedTicketService,
)


def create_unassigned_ticket_blueprint(
    service: UnassignedTicketService,
) -> Blueprint:
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

    return blueprint

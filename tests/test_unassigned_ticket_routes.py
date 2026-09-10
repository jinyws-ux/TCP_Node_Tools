import unittest

try:
    from flask import Flask
    from web.unassigned_ticket_routes import create_unassigned_ticket_blueprint
except ModuleNotFoundError:
    Flask = None
    create_unassigned_ticket_blueprint = None


class StubService:
    def __init__(self):
        self.force_values = []

    def get_snapshot(self, *, force=False):
        self.force_values.append(force)
        return {
            "success": True,
            "counts": {"total": 1, "inc": 1, "wo": 0},
            "items": [{"id": "INC0001", "type": "INC"}],
            "stale": False,
        }


class StubSlaService:
    def __init__(self):
        self.force_values = []

    def get_snapshot(self, *, force=False):
        self.force_values.append(force)
        return {
            "success": True,
            "counts": {"total": 1, "warning": 1, "critical": 0, "breached": 0},
            "items": [{"id": "INC-RISK", "risk_level": "warning"}],
            "stale": False,
        }


class StubWorkloadService:
    def __init__(self):
        self.calls = []

    def get_summary(self, uf_number, assignee, month, *, force=False):
        self.calls.append((uf_number, assignee, month, force))
        return {
            "success": True,
            "complete": True,
            "uf_number": uf_number,
            "assignee": assignee,
            "month": month,
            "target_days": 21,
            "total_days": 17.675,
        }


@unittest.skipIf(Flask is None, "Flask is not installed in the test environment")
class UnassignedTicketRouteTests(unittest.TestCase):
    def setUp(self):
        self.service = StubService()
        self.sla_service = StubSlaService()
        self.workload_service = StubWorkloadService()
        app = Flask(__name__, template_folder="../web/templates")
        app.register_blueprint(
            create_unassigned_ticket_blueprint(
                self.service,
                self.sla_service,
                self.workload_service,
            )
        )
        self.client = app.test_client()

    def test_returns_snapshot(self):
        response = self.client.get("/api/unassigned-tickets")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["counts"]["total"], 1)
        self.assertEqual(self.service.force_values, [False])

    def test_manual_refresh_flag(self):
        response = self.client.get("/api/unassigned-tickets?refresh=1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.service.force_values, [True])

    def test_returns_sla_snapshot(self):
        response = self.client.get("/api/sla-risk-tickets?refresh=1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["counts"]["warning"], 1)
        self.assertEqual(self.sla_service.force_values, [True])

    def test_returns_workload_summary(self):
        response = self.client.get(
            "/api/workload/summary?uf_number=UF10001234&assignee=YANG%20WENSHUAI%20%2C%20BBF-XXXX&month=2026-08&refresh=1"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["target_days"], 21)
        self.assertEqual(
            self.workload_service.calls,
            [("UF10001234", "YANG WENSHUAI , BBF-XXXX", "2026-08", True)],
        )


if __name__ == "__main__":
    unittest.main()

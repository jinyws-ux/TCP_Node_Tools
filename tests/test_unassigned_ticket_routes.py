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


@unittest.skipIf(Flask is None, "Flask is not installed in the test environment")
class UnassignedTicketRouteTests(unittest.TestCase):
    def setUp(self):
        self.service = StubService()
        app = Flask(__name__, template_folder="../web/templates")
        app.register_blueprint(create_unassigned_ticket_blueprint(self.service))
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


if __name__ == "__main__":
    unittest.main()

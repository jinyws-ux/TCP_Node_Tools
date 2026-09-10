import unittest
from datetime import datetime, timedelta, timezone

from core.sla_risk_service import SlaRiskService


class SlaRiskServiceTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 8, 13, 12, 0, tzinfo=timezone.utc)

    def row(self, ticket_id, elapsed_percent, *, ticket_type="Incident"):
        total = timedelta(hours=4)
        submit = self.now - total * (elapsed_percent / 100.0)
        return {
            "id": ticket_id,
            "ticket_type": ticket_type,
            "summary": "SLA test",
            "priority": "High",
            "status": "In Progress",
            "assignee": "tester",
            "submit_time": submit,
            "limit_time": submit + total,
        }

    def snapshot(self, rows):
        return SlaRiskService(
            {"slaCacheSeconds": 60},
            query_executor=lambda: rows,
            now_provider=lambda: self.now,
        ).get_snapshot()

    def test_filters_below_75_percent_and_classifies_levels(self):
        snapshot = self.snapshot(
            [
                self.row("INC-NORMAL", 74),
                self.row("INC-WARNING", 80),
                self.row("INC-CRITICAL", 95),
                self.row("WO-BREACHED", 110, ticket_type="WorkOrder"),
            ]
        )
        self.assertEqual(snapshot["counts"]["total"], 3)
        self.assertEqual(snapshot["counts"]["warning"], 1)
        self.assertEqual(snapshot["counts"]["critical"], 1)
        self.assertEqual(snapshot["counts"]["breached"], 1)
        self.assertEqual([item["risk_level"] for item in snapshot["items"]], [
            "breached", "critical", "warning"
        ])

    def test_skips_invalid_time_ranges(self):
        invalid = self.row("INC-BAD", 80)
        invalid["limit_time"] = invalid["submit_time"]
        self.assertEqual(self.snapshot([invalid])["items"], [])

    def test_closed_ticket_is_never_returned(self):
        closed = self.row("INC-CLOSED", 110)
        closed["status"] = "Closed"
        self.assertEqual(self.snapshot([closed])["items"], [])


if __name__ == "__main__":
    unittest.main()

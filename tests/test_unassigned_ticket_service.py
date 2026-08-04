import unittest
from datetime import datetime, timezone

from core.unassigned_ticket_service import (
    TicketDatabaseNotConfigured,
    UnassignedTicketService,
)


class FakeClock:
    def __init__(self):
        self.value = 100.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class UnassignedTicketServiceTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.calls = 0

    def query(self):
        self.calls += 1
        return [
            {
                "id": "INC0002",
                "ticket_type": "Incident",
                "summary": "Second incident",
                "priority": "High",
                "submit_time": datetime(2026, 8, 4, 10, 0, tzinfo=timezone.utc),
            },
            {
                "id": "WO0001",
                "ticket_type": "WorkOrder",
                "summary": "First work order",
                "priority": "Low",
                "submit_time": datetime(2026, 8, 4, 9, 0, tzinfo=timezone.utc),
            },
        ]

    def make_service(self):
        return UnassignedTicketService(
            {"cacheSeconds": 300, "minForceIntervalSeconds": 10},
            query_executor=self.query,
            clock=self.clock,
        )

    def test_maps_ticket_types_and_counts(self):
        snapshot = self.make_service().get_snapshot()
        self.assertEqual(snapshot["counts"], {"total": 2, "inc": 1, "wo": 1})
        self.assertEqual([item["type"] for item in snapshot["items"]], ["INC", "WO"])
        self.assertEqual(snapshot["source"], "database")

    def test_reuses_cache_for_five_minutes(self):
        service = self.make_service()
        service.get_snapshot()
        cached = service.get_snapshot()
        self.assertEqual(self.calls, 1)
        self.assertEqual(cached["source"], "cache")

        self.clock.advance(301)
        service.get_snapshot()
        self.assertEqual(self.calls, 2)

    def test_force_refresh_is_rate_limited(self):
        service = self.make_service()
        service.get_snapshot()
        service.get_snapshot(force=True)
        self.assertEqual(self.calls, 1)

        self.clock.advance(11)
        service.get_snapshot(force=True)
        self.assertEqual(self.calls, 2)

    def test_returns_stale_cache_when_database_fails(self):
        service = self.make_service()
        service.get_snapshot()

        def failing_query():
            raise RuntimeError("database unavailable")

        service._query_executor = failing_query
        self.clock.advance(301)
        snapshot = service.get_snapshot()
        self.assertTrue(snapshot["stale"])
        self.assertEqual(snapshot["source"], "stale-cache")
        self.assertEqual(len(snapshot["items"]), 2)

    def test_missing_database_configuration_is_explicit(self):
        service = UnassignedTicketService({})
        with self.assertRaises(TicketDatabaseNotConfigured):
            service.get_snapshot()


if __name__ == "__main__":
    unittest.main()

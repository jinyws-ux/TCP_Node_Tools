import unittest
import json
from datetime import date
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from core.workload_service import (
    InvalidWorkloadRequest,
    WorkCalendar,
    WorkloadService,
)


class WorkCalendarTests(unittest.TestCase):
    def test_weekdays_with_holiday_and_extra_workday(self):
        calendar = WorkCalendar(
            {
                "holidays": ["2026-08-03"],
                "extraWorkdays": ["2026-08-01"],
            }
        )
        target, source = calendar.target_days("2026-08")
        self.assertEqual(target, 21)
        self.assertEqual(source, "work_calendar")

    def test_monthly_override(self):
        target, source = WorkCalendar(
            {"monthlyTargetOverrides": {"2026-08": 19.5}}
        ).target_days("2026-08")
        self.assertEqual(target, 19.5)
        self.assertEqual(source, "monthly_override")


class WorkloadServiceTests(unittest.TestCase):
    def make_service(self):
        return WorkloadService(
            {
                "ticketDaysPerTicket": 0.35875,
                "calendar": {"monthlyTargetOverrides": {"2026-08": 21}},
            },
            jira_executor=lambda uf_number, start, end: (4, 10.5),
            ticket_executor=lambda assignee, start, end: 20,
            today_provider=lambda: date(2026, 8, 28),
        )

    def test_calculates_everything_in_days(self):
        summary = self.make_service().get_summary(
            "UF10001234", "YANG WENSHUAI , BBF-XXXX", "2026-08"
        )
        self.assertTrue(summary["complete"])
        self.assertEqual(summary["jira"]["days"], 10.5)
        self.assertEqual(summary["tickets"]["days"], 7.175)
        self.assertEqual(summary["total_days"], 17.675)
        self.assertEqual(summary["target_days"], 21)
        self.assertEqual(summary["completion_percent"], 84.2)
        self.assertEqual(summary["remaining_days"], 3.325)

    def test_unconfigured_sources_are_not_reported_as_zero_work(self):
        summary = WorkloadService(
            {"calendar": {"monthlyTargetOverrides": {"2026-08": 21}}}
        ).get_summary("UF10001234", "YANG WENSHUAI , BBF-XXXX", "2026-08")
        self.assertFalse(summary["complete"])
        self.assertIsNone(summary["total_days"])
        self.assertEqual(summary["jira"]["status"], "not_configured")
        self.assertEqual(summary["tickets"]["status"], "not_configured")

    def test_rejects_invalid_employee_or_month(self):
        service = self.make_service()
        with self.assertRaises(InvalidWorkloadRequest):
            service.get_summary("1' OR 1=1", "YANG WENSHUAI", "2026-08")
        with self.assertRaises(InvalidWorkloadRequest):
            service.get_summary("UF10001234", "YANG WENSHUAI", "2026-13")
        with self.assertRaises(InvalidWorkloadRequest):
            service.get_summary("UF10001234", "", "2026-08")

    def test_uses_separate_identities_for_jira_and_remedy(self):
        seen = {}

        def jira(uf_number, start, end):
            seen["jira"] = uf_number
            return 1, 1.5

        def tickets(assignee, start, end):
            seen["ticket"] = assignee
            return 2

        service = WorkloadService(
            {"calendar": {"monthlyTargetOverrides": {"2026-08": 21}}},
            jira_executor=jira,
            ticket_executor=tickets,
        )
        summary = service.get_summary(
            "UF12345", "YANG WENSHUAI , BBF-XXXX", "2026-08"
        )
        self.assertEqual(seen["jira"], "UF12345")
        self.assertEqual(seen["ticket"], "YANG WENSHUAI , BBF-XXXX")
        self.assertEqual(summary["uf_number"], "UF12345")
        self.assertEqual(summary["assignee"], "YANG WENSHUAI , BBF-XXXX")

    def test_jira_keeps_existing_time_filter_and_only_replaces_current(self):
        captured = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, _limit):
                return json.dumps(
                    {
                        "total": 1,
                        "issues": [{"fields": {"customfield_10002": 1.5}}],
                    }
                ).encode("utf-8")

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["authorization"] = request.headers.get("Authorization")
            return Response()

        service = WorkloadService(
            {
                "jira": {
                    "baseUrl": "https://jira.example.invalid",
                    "authMode": "bearer",
                    "tokenEnv": "TEST_JIRA_TOKEN",
                    "storyPointField": "customfield_10002",
                    "employeePlaceholder": "current",
                    "jqlTemplate": "assignee = current AND created >= startOfMonth()",
                }
            }
        )
        with patch.dict("os.environ", {"TEST_JIRA_TOKEN": "temporary-test-token"}):
            with patch("urllib.request.urlopen", fake_urlopen):
                count, points = service._query_jira(
                    "UF12345", date(2026, 8, 1), date(2026, 9, 1)
                )
        jql = parse_qs(urlparse(captured["url"]).query)["jql"][0]
        self.assertEqual(jql, "assignee = UF12345 AND created >= startOfMonth()")
        self.assertNotIn("2026-08-01", jql)
        self.assertEqual(captured["authorization"], "Bearer temporary-test-token")
        self.assertEqual((count, points), (1, 1.5))
        service.config["jira"]["token"] = "config-test-token"
        with patch.dict("os.environ", {"TEST_JIRA_TOKEN": "env-test-token"}):
            with patch("urllib.request.urlopen", fake_urlopen):
                service._query_jira("UF12345", date(2026, 8, 1), date(2026, 9, 1))
        self.assertEqual(captured["authorization"], "Bearer config-test-token")



if __name__ == "__main__":
    unittest.main()

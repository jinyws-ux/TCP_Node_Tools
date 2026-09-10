import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
import nas_update
from publish_update import publish


class ReleaseTests(unittest.TestCase):
    def test_publish_stage_and_existing_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            exe = root / 'client.exe'
            exe.write_bytes(b'MZ' + b'fixture' * 100)
            nas = root / 'nas'
            config = root / 'ticket-monitor.json'
            config.write_text('{"ufNumber":"personal"}')
            publish(exe, nas, '2.5.1', '说明')
            manifest = nas_update.read_manifest(nas / 'version.json')
            staged = nas_update.stage_update(manifest)
            self.assertEqual(staged.read_bytes(), exe.read_bytes())
            import shutil
            shutil.rmtree(staged.parent)
            self.assertEqual(config.read_text(), '{"ufNumber":"personal"}')
            with self.assertRaises(FileExistsError):
                publish(exe, nas, '2.5.1', '')
            self.assertEqual(nas_update.version_tuple(manifest['version']), (2, 5, 1))

    def test_corrupt_download_and_unavailable_source(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'a.exe'
            path.write_bytes(b'MZbad')
            with self.assertRaisesRegex(ValueError, '校验失败'):
                nas_update.stage_update(dict(source=str(path), sha256='0' * 64))
            with self.assertRaises(FileNotFoundError):
                nas_update.read_manifest(Path(directory) / 'missing.json')

    def test_invalid_manifest_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'version.json'
            for name in ('../x.exe', 'C:\\x.exe', '\\\\server\\x.exe', 'x.ps1'):
                path.write_text(json.dumps(dict(version='2.5.1', file=name, sha256='0'*64, packageType='onefile')))
                with self.assertRaises(ValueError):
                    nas_update.read_manifest(path)

    def monitor(self):
        app = main.TicketMonitor.__new__(main.TicketMonitor)
        app.root = None
        app.active_page = 'unassigned'
        app.filter_name = 'ALL'
        app.expanded = True
        app.window_width = 392
        app.list_top, app.list_bottom, app.scroll_offset = 194, 572, 0
        app.snapshot = main.parse_snapshot(dict(success=True, items=[
            dict(id='INC1', type='INC', handling_kind='unassigned'),
            dict(id='WO2', type='WO', handling_kind='agent_handoff', status='In Progress')]))
        return app

    def test_sections_hit_testing_and_filter(self):
        app = self.monitor()
        rows, height = app._list_layout()
        headers = [r[1] for r in rows if r[0] == 'header']
        self.assertEqual([x[:2] for x in headers], [('待人工处理', 1), ('未分配', 1)])
        for kind, value, top, size in rows:
            if kind == 'ticket':
                self.assertIs(app._ticket_at_position(40, app.list_top + top + 10), value)
            elif kind == 'header':
                self.assertIsNone(app._ticket_at_position(40, app.list_top + top + 10))
        app.scroll_offset = 70
        ticket_row = next(r for r in rows if r[0] == 'ticket' and r[1].ticket_id == 'INC1')
        self.assertEqual(app._ticket_at_position(40, app.list_top + ticket_row[2] - 70 + 10).ticket_id, 'INC1')
        app.filter_name = 'INC'
        rows, _ = app._list_layout()
        self.assertEqual([r[1][1] for r in rows if r[0] == 'header'], [0, 1])
        self.assertEqual(len([r for r in rows if r[0] == 'empty']), 1)

    def test_failed_update_keeps_app_running(self):
        app = self.monitor()
        app.close = lambda: self.fail('must not close on failed preparation')
        with patch.object(main.messagebox, 'showerror') as show:
            app._handle_update_result('update_ready', False, 'blocked')
            show.assert_called_once()
        self.assertFalse(app.update_busy)

    def test_numeric_versions(self):
        self.assertGreater(nas_update.version_tuple('2.10.0'), nas_update.version_tuple('2.9.0'))
        self.assertEqual(nas_update.version_tuple('2.4.0-agent-handoff'), (2, 4, 0))


if __name__ == '__main__':
    unittest.main()

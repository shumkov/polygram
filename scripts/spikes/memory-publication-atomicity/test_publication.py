import sqlite3
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from publication import PublicationBootGate, PublicationNotReady, PublicationStore
from run_gate import main


FIXTURE = "A sanitized durable partner fact."


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="memory-publication-test-")
        self.store = PublicationStore(Path(self.temporary.name))
        self.store.initialize(FIXTURE)

    def tearDown(self):
        self.temporary.cleanup()

    def test_inactive_prepared_siblings_are_not_recallable(self):
        self.assertEqual([], self.store.recall("partner"))
        self.assertEqual([], self.store.recall("general"))

    def test_fully_prepared_siblings_stay_hidden_before_activation(self):
        def inject_crash():
            raise RuntimeError("injected crash")

        with self.assertRaises(RuntimeError):
            self.store.reconcile("before_activation", crash=inject_crash)
        self.assertEqual(
            {
                "partner": {"body": 1, "index": 1},
                "general": {"body": 1, "index": 1},
            },
            self.store.artifact_counts(),
        )
        self.assertEqual([], self.store.recall("partner"))
        self.assertEqual([], self.store.recall("general"))

    def test_one_reconciliation_activates_both_siblings(self):
        self.store.reconcile()
        self.assertEqual([FIXTURE], self.store.recall("partner"))
        self.assertEqual([FIXTURE], self.store.recall("general"))

    def test_partial_staged_file_is_rebuilt_from_the_checkpoint(self):
        staged = (
            Path(self.temporary.name)
            / "scopes"
            / "partner"
            / "staged"
            / "record_partner_gate.md"
        )
        staged.write_text("partial", encoding="utf-8")
        self.store.reconcile()
        self.assertEqual([FIXTURE], self.store.recall("partner"))
        self.assertEqual([FIXTURE], self.store.recall("general"))

    def test_persisted_destination_set_is_authoritative(self):
        with sqlite3.connect(Path(self.temporary.name) / "state.sqlite") as connection:
            connection.execute(
                "DELETE FROM destinations WHERE logical_id = ? AND scope = ?",
                ("logical_partner_gate", "general"),
            )
        with self.assertRaises(PublicationNotReady):
            self.store.reconcile()

    def test_durable_snapshot_observes_unexpected_artifacts(self):
        self.store.reconcile()
        before = self.store.durable_snapshot()
        extra = Path(self.temporary.name) / "scopes" / "partner" / "records" / "extra.md"
        extra.write_text("unexpected", encoding="utf-8")
        with sqlite3.connect(
            Path(self.temporary.name) / "scopes" / "general" / "index.sqlite"
        ) as connection:
            connection.execute(
                "INSERT INTO entries(record_id, content) VALUES (?, ?)",
                ("extra", "unexpected"),
            )
        self.assertNotEqual(before, self.store.durable_snapshot())

    def test_active_artifact_damage_fails_closed_until_boot_repair(self):
        self.store.reconcile()
        self.store.remove_index_for_gate("partner")
        with self.assertRaises(PublicationNotReady):
            self.store.recall("general")

        boot = PublicationBootGate(self.store)
        with self.assertRaises(PublicationNotReady):
            boot.recall("partner")
        boot.open()
        self.assertEqual([FIXTURE], boot.recall("partner"))
        self.assertEqual([FIXTURE], boot.recall("general"))

    def test_standalone_failure_output_is_sanitized(self):
        output = StringIO()
        with (
            patch("run_gate.run_gate", side_effect=RuntimeError("sensitive /tmp/path")),
            patch("sys.argv", ["run_gate.py"]),
            redirect_stdout(output),
        ):
            self.assertEqual(1, main())
        rendered = output.getvalue()
        self.assertIn('"error_code": "publication-gate-exception"', rendered)
        self.assertNotIn("sensitive", rendered)
        self.assertNotIn("/tmp/path", rendered)


if __name__ == "__main__":
    unittest.main()

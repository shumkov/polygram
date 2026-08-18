"""Self-tests: every oracle must reject a backend that misbehaves.

Without these, a green gate could mean "the backend removes records" or "the
harness cannot tell the difference". These pin the second reading out. Several
cases here correspond to backends that an earlier version of this gate accepted
while removing nothing.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


def _load(module_name: str):
    """Load a sibling module by path.

    The isolation spike next door has modules with the same basenames, so this
    never relies on ``sys.path`` order. The module is registered under its own
    name because ``dataclasses`` resolves a class's module through ``sys.modules``.
    """
    source = Path(__file__).resolve().parent / f"{module_name}.py"
    spec = importlib.util.spec_from_file_location(f"deletion_{module_name}", source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


gate = _load("gate")
fake_adapter = _load("fake_adapter")
FakeDeletionAdapter = fake_adapter.FakeDeletionAdapter


def phase(result, name: str):
    return next(item for item in result.phases if item.name == name)


class DeletionGateOracleTest(unittest.TestCase):
    def test_healthy_backend_selects_record_level_removal(self):
        result = gate.run_gate(FakeDeletionAdapter())
        self.assertTrue(result.passed)
        self.assertEqual(result.selected_mechanism, "record-level-removal")
        self.assertTrue(phase(result, "record-level-force").passed)

    def test_rebuild_that_retains_the_deleted_record_fails_record_level(self):
        result = gate.run_gate(FakeDeletionAdapter(retain_deleted_record=True))
        record_level = phase(result, "record-level-force")
        self.assertFalse(record_level.passed)
        self.assertFalse(record_level.checks["target_absent_after"])
        # The scope-level fallback is what R54 must then document.
        self.assertEqual(result.selected_mechanism, "scope-level-rebuild-fallback")

    def test_no_mechanism_when_both_paths_retain_the_record(self):
        result = gate.run_gate(FakeDeletionAdapter(
            retain_deleted_record=True,
            scope_rebuild_retains_record=True,
        ))
        self.assertFalse(result.passed)
        self.assertEqual(result.selected_mechanism, "none")

    def test_rebuild_that_drops_siblings_fails_even_with_negative_recall(self):
        result = gate.run_gate(FakeDeletionAdapter(force_rebuild_loses_siblings=True))
        record_level = phase(result, "record-level-force")
        self.assertFalse(record_level.passed)
        self.assertTrue(record_level.checks["target_absent_after"])
        self.assertFalse(record_level.checks["siblings_present_after"])

    def test_backend_that_never_returns_results_cannot_pass_vacuously(self):
        result = gate.run_gate(FakeDeletionAdapter(search_returns_nothing=True))
        record_level = phase(result, "record-level-force")
        self.assertFalse(record_level.passed)
        self.assertFalse(record_level.checks["target_indexed_before"])
        self.assertFalse(result.passed)
        self.assertEqual(result.selected_mechanism, "none")

    def test_incremental_phase_is_informational_only(self):
        result = gate.run_gate(FakeDeletionAdapter(incremental_retains_record=True))
        incremental = phase(result, "record-level-incremental")
        self.assertFalse(incremental.passed)
        self.assertEqual(incremental.role, gate.INFORMATIONAL)
        # A stale incremental index must not veto a proven force rebuild.
        self.assertTrue(result.passed)
        self.assertEqual(result.selected_mechanism, "record-level-removal")

    def test_backend_that_only_hides_missing_sources_fails_attribution(self):
        """The rebuild must be what removes the record, not the file vanishing."""
        result = gate.run_gate(FakeDeletionAdapter(
            hide_records_with_missing_sources=True,
            retain_deleted_record=True,
        ))
        record_level = phase(result, "record-level-force")
        self.assertFalse(record_level.passed)
        self.assertFalse(record_level.checks["target_present_before_rebuild"])
        # Negative recall alone would have looked like a clean removal.
        self.assertTrue(record_level.checks["target_absent_after"])

    def test_rebuild_that_wipes_other_scopes_fails_containment(self):
        result = gate.run_gate(FakeDeletionAdapter(rebuild_wipes_other_scopes=True))
        record_level = phase(result, "record-level-force")
        self.assertFalse(record_level.passed)
        self.assertFalse(record_level.checks["other_scopes_intact"])

    def test_removal_that_does_not_survive_reopen_fails_durability(self):
        result = gate.run_gate(FakeDeletionAdapter(removal_is_not_durable=True))
        record_level = phase(result, "record-level-force")
        self.assertFalse(record_level.passed)
        self.assertTrue(record_level.checks["target_absent_after"])
        self.assertFalse(record_level.checks["target_absent_after_reopen"])

    def test_saturated_search_window_cannot_prove_absence(self):
        result = gate.run_gate(FakeDeletionAdapter(saturate_search_window=True))
        record_level = phase(result, "record-level-force")
        self.assertFalse(record_level.passed)
        self.assertFalse(record_level.checks["target_absent_after"])

    def test_precondition_phase_fails_when_file_paths_mode_also_prunes(self):
        """The precondition must be characterized, not assumed either way."""
        result = gate.run_gate(FakeDeletionAdapter(file_paths_mode_prunes=True))
        precondition = phase(result, "file-paths-precondition")
        self.assertEqual(precondition.role, gate.PRECONDITION)
        self.assertFalse(precondition.checks["file_paths_mode_retains_record"])
        # A record-level PASS must not stand while its precondition is unproven.
        self.assertEqual(result.selected_mechanism, "record-level-removal")
        self.assertFalse(result.passed)

    def test_presence_check_refuses_an_empty_record_list(self):
        with self.assertRaises(ValueError):
            gate._all_present(FakeDeletionAdapter(), "alpha", [])


class PublicSurfaceTest(unittest.TestCase):
    def setUp(self):
        # Importing the module must not require memsearch to be installed.
        self.module = _load("deployed_adapter")

        class FakeMemSearch:
            def __init__(self):
                self.store = object()

            def search(self):
                return "ok"

        self.surface = self.module.PublicSurface(FakeMemSearch())

    def test_documented_calls_resolve(self):
        self.assertEqual(self.surface.search(), "ok")

    def test_private_attributes_are_refused(self):
        with self.assertRaises(self.module.PrivateSurfaceUsed):
            _ = self.surface.store

    def test_wrapped_instance_is_not_reachable(self):
        """The wrapped object must not be retrievable by any accessor."""
        for accessor in (
            lambda: self.surface._instance,
            lambda: object.__getattribute__(self.surface, "_instance"),
            lambda: vars(self.surface),
            lambda: self.surface.__dict__,
        ):
            with self.assertRaises((self.module.PrivateSurfaceUsed, AttributeError, TypeError)):
                accessor()

    def test_mutation_is_refused(self):
        with self.assertRaises(self.module.PrivateSurfaceUsed):
            self.surface.anything = 1
        with self.assertRaises(self.module.PrivateSurfaceUsed):
            del self.surface.search


if __name__ == "__main__":
    unittest.main()

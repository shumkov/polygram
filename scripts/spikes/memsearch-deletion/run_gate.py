"""Runner for the scoped-memory deletion-mechanism gate.

Emits a sanitized result: mechanism, per-phase checks, the configuration that
was exercised, and the exact backend versions. It never emits fixture text,
queries, or absolute paths.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import stat
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path


def _load_sibling(module_name: str):
    """Import a sibling module by path.

    The sibling isolation spike has modules with the same basenames, so this
    never puts either directory on ``sys.path``.
    """
    source = Path(__file__).resolve().parent / f"{module_name}.py"
    spec = importlib.util.spec_from_file_location(
        f"memsearch_deletion_{module_name}", source,
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_adapter(spec: str, work_dir: Path):
    module_name, _, factory_name = spec.partition(":")
    if not module_name or not factory_name:
        raise SystemExit("adapter must be given as module:function")
    module = _load_sibling(module_name)
    return getattr(module, factory_name)(work_dir=work_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--adapter",
        required=True,
        help="module:function factory; use deployed_adapter:create_adapter for "
             "the authoritative run",
    )
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--allow-non-authoritative",
        action="store_true",
        help="exit 0 for a harness-only run that proves the oracles, not memsearch",
    )
    args = parser.parse_args()

    gate = _load_sibling("gate")

    owned_temp = None
    work_dir = args.work_dir
    if work_dir is None:
        owned_temp = tempfile.TemporaryDirectory(prefix="memsearch-deletion-")
        work_dir = Path(owned_temp.name)
    else:
        if not work_dir.is_absolute():
            parser.error("--work-dir must be absolute")
        if work_dir.is_symlink():
            parser.error("--work-dir must not be a symlink")
        if work_dir.exists():
            if not work_dir.is_dir():
                parser.error("--work-dir must be a directory")
            if stat.S_IMODE(work_dir.stat().st_mode) != 0o700:
                parser.error("existing --work-dir must have mode 0700")
            if any(work_dir.iterdir()):
                parser.error("existing --work-dir must be empty")
        else:
            work_dir.mkdir(parents=True, mode=0o700)

    # Fixtures, index files and the sanitized artifact stay owner-only.
    os.umask(0o077)

    adapter = load_adapter(args.adapter, work_dir)
    try:
        result = gate.run_gate(adapter)
    finally:
        close = getattr(adapter, "close", None)
        if callable(close):
            close()
        if owned_temp is not None:
            owned_temp.cleanup()

    payload = {
        "gate": "scoped-memory-deletion-mechanism",
        "adapter": result.adapter,
        "backend_version": result.backend_version,
        "authoritative": result.authoritative,
        "configuration": result.configuration,
        "selected_mechanism": result.selected_mechanism,
        "passed": result.passed,
        "phases": [asdict(phase) for phase in result.phases],
    }
    rendered = json.dumps(payload, indent=2, sort_keys=True)
    if args.output:
        if not args.output.is_absolute():
            parser.error("--output must be absolute")
        if args.output.exists():
            parser.error("--output must not already exist")
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)

    if not result.authoritative:
        # A harness-only run proves the oracles can fail, not that memsearch
        # removes anything. It must not be mistakable for the real evidence by
        # exit code alone.
        print(
            "\nNON-AUTHORITATIVE adapter: this run proves the oracles, not memsearch.",
        )
        return 0 if args.allow_non_authoritative else 2

    return 0 if result.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())

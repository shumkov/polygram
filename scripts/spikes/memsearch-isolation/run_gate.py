#!/usr/bin/env python3
"""Run the scoped-memsearch gate and emit sanitized JSON evidence."""

from __future__ import annotations

import argparse
import importlib
import json
import stat
import tempfile
from pathlib import Path

from gate import GateThresholds, run_matrix


def _factory(spec: str):
    module_name, separator, attribute = spec.partition(":")
    if not separator or not module_name or not attribute:
        raise ValueError("--adapter must be module:function")
    return getattr(importlib.import_module(module_name), attribute)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--adapter", default="fake_adapter:create_adapter")
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--samples", type=int, default=40)
    parser.add_argument(
        "--topology",
        action="append",
        choices=("shared-file", "per-scope-file"),
        dest="topologies",
    )
    args = parser.parse_args()

    if args.samples < 5:
        parser.error("--samples must be at least 5")

    owned_temp = None
    work_dir = args.work_dir
    if work_dir is None:
        owned_temp = tempfile.TemporaryDirectory(prefix="memsearch-isolation-")
        work_dir = Path(owned_temp.name)
    else:
        if not work_dir.is_absolute():
            parser.error("--work-dir must be absolute")
        if work_dir.is_symlink():
            parser.error("--work-dir must not be a symlink")
        if work_dir.exists():
            if not work_dir.is_dir():
                parser.error("--work-dir must be a directory")
            mode = stat.S_IMODE(work_dir.stat().st_mode)
            if mode != 0o700:
                parser.error("existing --work-dir must have mode 0700")
            if any(work_dir.iterdir()):
                parser.error("existing --work-dir must be empty")
        else:
            work_dir.mkdir(parents=True, mode=0o700)

    evidence = run_matrix(
        adapter_factory=_factory(args.adapter),
        work_dir=work_dir,
        topologies=tuple(args.topologies or ("shared-file", "per-scope-file")),
        thresholds=GateThresholds(samples=args.samples),
    )
    rendered = json.dumps(evidence, indent=2, sort_keys=True)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    if not evidence["authoritative"]:
        print(
            f"HARNESS {evidence['status']} (NON-AUTHORITATIVE): "
            "run an attested real memsearch adapter"
        )
    if owned_temp is not None:
        owned_temp.cleanup()
    return 0 if evidence["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())

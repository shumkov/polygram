#!/usr/bin/env python3
"""Sanitized Linux gate for exact systemd MainPID peer attestation."""

from __future__ import annotations

import argparse
import json
import os
import platform
import select
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import uuid
from pathlib import Path

from attestation import PeerAttestor, ProcessEvidence, UnitSnapshot


MAX_RESPONSE = 4096
# Linux UAPI value from asm-generic/socket.h. Python 3.12 on the target kernel
# does not expose the constant, but getsockopt supports it.
SO_PEERPIDFD = 77


def systemd_snapshot(unit: str, *, user_manager: bool) -> UnitSnapshot:
    command = ["systemctl"]
    if user_manager:
        command.append("--user")
    command.extend([
        "show",
        unit,
        "--no-pager",
        "--property=MainPID",
        "--property=InvocationID",
        "--property=ControlGroup",
        "--property=ActiveState",
        "--property=SubState",
    ])
    completed = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    )
    properties = {}
    for line in completed.stdout.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            properties[key] = value
    required = {"MainPID", "InvocationID", "ControlGroup", "ActiveState", "SubState"}
    if set(properties) != required:
        raise RuntimeError("systemd identity properties are incomplete")
    return UnitSnapshot(
        main_pid=int(properties["MainPID"]),
        invocation_id=properties["InvocationID"],
        control_group=properties["ControlGroup"],
        active_state=properties["ActiveState"],
        sub_state=properties["SubState"],
    )


def process_evidence(pid: int) -> ProcessEvidence:
    proc = Path("/proc") / str(pid)
    executable = os.readlink(proc / "exe")
    cgroups = []
    for line in (proc / "cgroup").read_text(encoding="utf-8").splitlines():
        _hierarchy, _controllers, path = line.split(":", 2)
        cgroups.append(path)
    return ProcessEvidence(executable=executable, cgroups=tuple(cgroups))


def live_pidfd_process_id(peer_pidfd: int) -> int:
    poller = select.poll()
    poller.register(peer_pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
    if poller.poll(0):
        raise OSError("peer exited")

    fields = {}
    for line in Path(f"/proc/self/fdinfo/{peer_pidfd}").read_text(
        encoding="utf-8"
    ).splitlines():
        key, separator, value = line.partition(":")
        if separator:
            fields[key] = value.strip()
    peer_pid = int(fields["Pid"])
    if peer_pid <= 0:
        raise OSError("peer exited")
    return peer_pid


class RequestReadTracker:
    def __init__(self) -> None:
        self.calls = 0

    def read(self, connection: socket.socket, *, allowed: bool) -> int:
        if not allowed:
            return 0
        self.calls += 1
        return len(connection.recv(1))


def peer_credentials(connection: socket.socket) -> tuple[int, int, int]:
    raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, _gid = struct.unpack("3i", raw)
    pidfd_raw = connection.getsockopt(socket.SOL_SOCKET, SO_PEERPIDFD, struct.calcsize("i"))
    peer_pidfd = struct.unpack("i", pidfd_raw)[0]
    if peer_pidfd < 0:
        raise OSError("SO_PEERPIDFD returned an invalid descriptor")
    return pid, uid, peer_pidfd


def connect_once(socket_path: str) -> dict[str, object]:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.connect(socket_path)
        client.sendall(b"{")
        response = client.recv(MAX_RESPONSE)
    return json.loads(response)


def child_mode(socket_path: str) -> int:
    response = connect_once(socket_path)
    return 0 if response == {
        "allowed": False,
        "code": "not-main-pid",
        "request_bytes_read": 0,
    } else 1


def client_mode(socket_path: str) -> int:
    direct = connect_once(socket_path)
    child = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "--child", socket_path],
        check=False,
        timeout=10,
    )
    return 0 if (
        direct == {
            "allowed": True,
            "code": "accepted",
            "request_bytes_read": 1,
        }
        and child.returncode == 0
    ) else 1


def run_server(
    *,
    socket_path: Path,
    unit: str,
    ready: threading.Event,
    results: list[dict[str, object]],
    request_reader: RequestReadTracker,
    errors: list[str],
) -> None:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(str(socket_path))
        os.chmod(socket_path, 0o600)
        server.listen(2)
        server.settimeout(20)
        ready.set()
        attestor = PeerAttestor(
            expected_uid=os.getuid(),
            expected_executable=sys.executable,
            snapshot_reader=lambda: systemd_snapshot(unit, user_manager=True),
            process_reader=process_evidence,
            pidfd_reader=live_pidfd_process_id,
        )
        for _ordinal in range(2):
            try:
                connection, _address = server.accept()
            except TimeoutError:
                errors.append("server-accept-timeout")
                return
            with connection:
                try:
                    pid, uid, peer_pidfd = peer_credentials(connection)
                except OSError:
                    result = {
                        "allowed": False,
                        "code": "peer-pidfd-unavailable",
                        "request_bytes_read": 0,
                    }
                    results.append(result)
                    connection.sendall(json.dumps(result, sort_keys=True).encode("utf-8"))
                    continue
                decision = attestor.verify(
                    peer_pid=pid,
                    peer_uid=uid,
                    peer_pidfd=peer_pidfd,
                )
                request_bytes = request_reader.read(connection, allowed=decision.allowed)
                result = {
                    "allowed": decision.allowed,
                    "code": decision.code,
                    "request_bytes_read": request_bytes,
                }
                results.append(result)
                connection.sendall(json.dumps(result, sort_keys=True).encode("utf-8"))


def cleanup_transient_user_unit(unit: str) -> None:
    for action in ("stop", "reset-failed"):
        try:
            subprocess.run(
                ["systemctl", "--user", action, unit],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
        except subprocess.TimeoutExpired:
            pass


def transient_user_unit_is_absent(unit: str) -> bool:
    try:
        completed = subprocess.run(
            [
                "systemctl",
                "--user",
                "show",
                unit,
                "--property=LoadState",
                "--value",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except subprocess.TimeoutExpired:
        return False
    return completed.returncode != 0 or completed.stdout.strip() == "not-found"


def gate_mode() -> int:
    if platform.system() != "Linux" or not hasattr(socket, "SO_PEERCRED"):
        print(json.dumps({"status": "BLOCKED", "error_code": "linux-so-peercred-required"}))
        return 2
    with tempfile.TemporaryDirectory(prefix="memory-peer-attestation-") as temporary:
        directory = Path(temporary)
        os.chmod(directory, 0o700)
        socket_path = directory / "gate.sock"
        unit = f"polygram-memory-peer-gate-{os.getpid()}-{uuid.uuid4().hex[:8]}.service"
        ready = threading.Event()
        results: list[dict[str, object]] = []
        errors: list[str] = []
        request_reader = RequestReadTracker()
        server = threading.Thread(
            target=run_server,
            kwargs={
                "socket_path": socket_path,
                "unit": unit,
                "ready": ready,
                "results": results,
                "request_reader": request_reader,
                "errors": errors,
            },
            name="memory-peer-attestation-gate",
        )
        server.start()
        if not ready.wait(timeout=5):
            print(json.dumps({"status": "FAIL", "error_code": "socket-start-timeout"}))
            return 1
        completed_returncode = None
        run_error_code = None
        try:
            completed = subprocess.run(
                [
                    "systemd-run",
                    "--user",
                    f"--unit={unit}",
                    "--collect",
                    "--wait",
                    "--quiet",
                    "--property=Type=exec",
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--client",
                    str(socket_path),
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
            completed_returncode = completed.returncode
        except subprocess.TimeoutExpired:
            run_error_code = "systemd-run-timeout"
        finally:
            cleanup_transient_user_unit(unit)

        server.join(timeout=25)
        unit_absent = transient_user_unit_is_absent(unit)
        checks = {
            "main_pid_accepted": len(results) == 2 and results[0].get("allowed") is True,
            "same_uid_child_rejected": len(results) == 2 and results[1].get("code") == "not-main-pid",
            "rejection_before_request_parse": len(results) == 2
            and results[1].get("request_bytes_read") == 0
            and request_reader.calls == 1,
            "transient_unit_clean_exit": completed_returncode == 0,
            "transient_unit_absent": unit_absent,
            "server_completed": not server.is_alive() and not errors,
        }
        evidence = {
            "status": "PASS" if all(checks.values()) else "FAIL",
            "platform": "linux",
            "peer_pidfd": True,
            "checks": checks,
            "result_codes": [result.get("code") for result in results],
        }
        if run_error_code:
            evidence["error_code"] = run_error_code
        print(json.dumps(evidence, sort_keys=True))
        return 0 if evidence["status"] == "PASS" else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--client")
    modes.add_argument("--child")
    args = parser.parse_args()
    if args.client:
        return client_mode(args.client)
    if args.child:
        return child_mode(args.child)
    return gate_mode()


if __name__ == "__main__":
    raise SystemExit(main())

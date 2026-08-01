import unittest

from attestation import (
    PeerAttestor,
    ProcessEvidence,
    UnitSnapshot,
)


SNAPSHOT = UnitSnapshot(
    main_pid=4242,
    invocation_id="a" * 32,
    control_group="/user.slice/gate.service",
    active_state="active",
    sub_state="running",
)
PROCESS = ProcessEvidence(
    executable="/usr/bin/python3",
    cgroups=("/user.slice/gate.service",),
)


class FakePidfd:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class PeerAttestationTests(unittest.TestCase):
    def attestor(
        self,
        *,
        snapshots=(SNAPSHOT, SNAPSHOT),
        process=PROCESS,
        peer_pidfd_pid=4242,
    ):
        snapshot_iter = iter(snapshots)
        pidfd = FakePidfd()
        attestor = PeerAttestor(
            expected_uid=1000,
            expected_executable="/usr/bin/python3",
            snapshot_reader=lambda: next(snapshot_iter),
            process_reader=lambda _pid: process,
            pidfd_reader=lambda _pidfd: peer_pidfd_pid,
        )
        return attestor, pidfd

    def test_exact_main_pid_invocation_cgroup_and_executable_are_accepted(self):
        attestor, pidfd = self.attestor()
        decision = attestor.verify(peer_pid=4242, peer_uid=1000, peer_pidfd=pidfd)
        self.assertTrue(decision.allowed)
        self.assertEqual("accepted", decision.code)
        self.assertTrue(pidfd.closed)

    def test_same_uid_child_is_rejected_before_request_parsing(self):
        attestor, _pidfd = self.attestor(peer_pidfd_pid=4243)
        decision = attestor.verify(peer_pid=4243, peer_uid=1000, peer_pidfd=_pidfd)
        self.assertFalse(decision.allowed)
        self.assertEqual("not-main-pid", decision.code)

    def test_missing_identity_evidence_fails_closed(self):
        cases = [
            UnitSnapshot(4242, "", SNAPSHOT.control_group, "active", "running"),
            UnitSnapshot(4242, SNAPSHOT.invocation_id, "", "active", "running"),
            UnitSnapshot(4242, SNAPSHOT.invocation_id, SNAPSHOT.control_group, "inactive", "dead"),
        ]
        for snapshot in cases:
            with self.subTest(snapshot=snapshot):
                attestor, _pidfd = self.attestor(snapshots=(snapshot, snapshot))
                decision = attestor.verify(peer_pid=4242, peer_uid=1000, peer_pidfd=_pidfd)
                self.assertFalse(decision.allowed)

    def test_executable_or_cgroup_mismatch_fails_closed(self):
        for process in [
            ProcessEvidence("/tmp/python3", PROCESS.cgroups),
            ProcessEvidence(PROCESS.executable, ("/user.slice/provider.scope",)),
        ]:
            with self.subTest(process=process):
                attestor, _pidfd = self.attestor(process=process)
                decision = attestor.verify(peer_pid=4242, peer_uid=1000, peer_pidfd=_pidfd)
                self.assertFalse(decision.allowed)

    def test_unit_generation_change_during_check_fails_closed(self):
        changed = UnitSnapshot(
            main_pid=4242,
            invocation_id="b" * 32,
            control_group=SNAPSHOT.control_group,
            active_state="active",
            sub_state="running",
        )
        attestor, _pidfd = self.attestor(snapshots=(SNAPSHOT, changed))
        decision = attestor.verify(peer_pid=4242, peer_uid=1000, peer_pidfd=_pidfd)
        self.assertFalse(decision.allowed)
        self.assertEqual("unit-changed", decision.code)

    def test_unavailable_pidfd_or_proc_evidence_fails_closed(self):
        attestor = PeerAttestor(
            expected_uid=1000,
            expected_executable="/usr/bin/python3",
            snapshot_reader=lambda: SNAPSHOT,
            process_reader=lambda _pid: PROCESS,
            pidfd_reader=lambda _pidfd: 4242,
        )
        decision = attestor.verify(peer_pid=4242, peer_uid=1000, peer_pidfd=None)
        self.assertFalse(decision.allowed)
        self.assertEqual("peer-pidfd-unavailable", decision.code)

    def test_peer_exit_during_proc_check_fails_closed(self):
        observations = iter((4242, OSError("peer exited")))

        def read_pidfd(_pidfd):
            observation = next(observations)
            if isinstance(observation, Exception):
                raise observation
            return observation

        pidfd = FakePidfd()
        attestor = PeerAttestor(
            expected_uid=1000,
            expected_executable="/usr/bin/python3",
            snapshot_reader=lambda: SNAPSHOT,
            process_reader=lambda _pid: PROCESS,
            pidfd_reader=read_pidfd,
        )
        decision = attestor.verify(peer_pid=4242, peer_uid=1000, peer_pidfd=pidfd)
        self.assertFalse(decision.allowed)
        self.assertEqual("peer-exited", decision.code)
        self.assertTrue(pidfd.closed)


if __name__ == "__main__":
    unittest.main()

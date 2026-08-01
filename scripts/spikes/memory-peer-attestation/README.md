# Scoped-memory peer-attestation gate

The pure tests pin fail-closed decisions for uid, a socket-derived pidfd bound
to the peer PID, exact systemd `MainPID`, non-empty/stable invocation ID,
cgroup membership, executable, and request parsing only after authorization.

```sh
python3 -m unittest discover \
  -s scripts/spikes/memory-peer-attestation -p 'test_*.py'
```

On the target Linux host, `linux_gate.py` creates one disposable collected user
unit. Its exact main process and a child at the same uid both connect to a
private Unix socket with malformed request bytes. The server reads
`SO_PEERCRED`, obtains `SO_PEERPIDFD` from the accepted socket, correlates its
`/proc/self/fdinfo` PID with the credential PID, and checks pidfd liveness
before and after the numeric `/proc/<pid>` reads. A single instrumented reader
can consume request bytes only after authorization. The main process must be
accepted, the child rejected without parsing, and the collected transient unit
confirmed absent afterward.

```sh
python3 scripts/spikes/memory-peer-attestation/linux_gate.py
```

The transient user-unit run proves the kernel/systemd mechanics but not the
final cross-owner deployment boundary. U10 must repeat the gate with the
memoryd service identity against a root-owned disposable system unit using the
same hardening as production. That gate must also prove the client identity
cannot start, stop, or reconfigure the allowlisted unit; all unit, executable,
script, argv, and package inputs are root-owned and immutable to it; executable
and package digests match the deployed allowlist; and both identities share
the required PID namespace and hardened `/proc` visibility. Any inability to
read the required executable/cgroup evidence or system-manager snapshot blocks
U3.

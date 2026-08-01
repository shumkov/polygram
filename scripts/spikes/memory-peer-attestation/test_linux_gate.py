import unittest

from linux_gate import RequestReadTracker


class FakeConnection:
    def __init__(self) -> None:
        self.recv_calls = 0

    def recv(self, _size: int) -> bytes:
        self.recv_calls += 1
        return b"{"


class RequestReadTrackerTests(unittest.TestCase):
    def test_rejected_peer_is_not_read_before_authorization(self):
        connection = FakeConnection()
        tracker = RequestReadTracker()

        self.assertEqual(0, tracker.read(connection, allowed=False))
        self.assertEqual(0, tracker.calls)
        self.assertEqual(0, connection.recv_calls)

        self.assertEqual(1, tracker.read(connection, allowed=True))
        self.assertEqual(1, tracker.calls)
        self.assertEqual(1, connection.recv_calls)


if __name__ == "__main__":
    unittest.main()

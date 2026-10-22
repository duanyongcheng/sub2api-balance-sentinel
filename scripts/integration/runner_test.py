import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("integration_runner", Path(__file__).with_name("run-real-sub2api.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerSafetyTests(unittest.TestCase):
    def test_secret_file_is_private_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "secret"
            runner.private_file(file, "synthetic credential")
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                runner.private_file(file, "replacement")
            self.assertEqual(file.read_text(), "synthetic credential")

    def test_failed_commands_do_not_expose_captured_secrets(self):
        result = subprocess.CompletedProcess(["docker", "start"], 1, b"synthetic secret", b"another secret")
        with patch.object(runner.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "raw output withheld") as caught:
                runner.command("docker", "start", "temporary-test-container")
        self.assertNotIn("secret", str(caught.exception))

    def test_timed_out_commands_have_a_bounded_safe_error(self):
        with patch.object(runner.subprocess, "run", side_effect=subprocess.TimeoutExpired("docker", 600)):
            with self.assertRaisesRegex(RuntimeError, "timed out; raw output withheld"):
                runner.command("docker", "start", "temporary-test-container")

    def test_bootstrap_request_does_not_follow_redirects_or_inherited_proxies(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.path, self.headers.get("Authorization")))
                self.send_response(302)
                self.send_header("Content-Type", "application/json")
                self.send_header("Location", "/must-not-receive-token")
                self.end_headers()
                self.wfile.write(b'{"code":302,"message":"sensitive upstream body"}')

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:1", "http_proxy": "http://127.0.0.1:1", "NO_PROXY": ""}):
                result = subprocess.run(["node", str(Path(__file__).with_name("request.mjs"))], capture_output=True,
                    input=json.dumps({"baseUrl": f"http://127.0.0.1:{server.server_port}",
                                      "route": "/api/v1/admin/users", "bearer": "test-token"}).encode(), timeout=15)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(requests, [("/api/v1/admin/users", "Bearer test-token")])
            self.assertEqual(result.stdout, b"")
            self.assertNotIn(b"sensitive upstream body", result.stderr)
            self.assertNotIn(b"test-token", result.stderr)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_bootstrap_rejects_non_loopback_before_sending_credentials(self):
        result = subprocess.run(["node", str(Path(__file__).with_name("request.mjs"))], capture_output=True,
            input=json.dumps({"baseUrl": "http://192.0.2.1", "route": "/api/v1/admin/users",
                              "bearer": "test-token"}).encode(), timeout=15)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"Isolated bootstrap request failed; response withheld\n")


if __name__ == "__main__":
    unittest.main()

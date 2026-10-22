#!/usr/bin/env python3
"""Build a tracked source snapshot and test only a disposable Sub2API instance."""

import argparse
import datetime
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tarfile
import tempfile
import time
import uuid


ROOT = Path(__file__).resolve().parents[2]
LABEL = "sentinel.integration.run"


def command(*args, stdin=None, quiet=False):
    try:
        result = subprocess.run(args, input=stdin, capture_output=True, check=False, timeout=600)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{args[0]} {args[1]} timed out; raw output withheld") from None
    if result.returncode:
        # Never dump Docker inspect/env, upstream responses, or container logs.
        raise RuntimeError(f"{args[0]} {args[1]} failed (exit {result.returncode}); raw output withheld")
    if not quiet:
        return result.stdout.decode().strip()
    return ""


def private_file(path, content):
    with path.open("x", encoding="utf-8") as handle:
        os.chmod(path, 0o600)
        handle.write(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Local Sub2API Git repository; never reads .env")
    parser.add_argument("--ref", default="HEAD", help="Explicit tracked source revision to archive")
    parser.add_argument("--report", type=Path, required=True, help="New sanitized JSON evidence file (will not overwrite)")
    args = parser.parse_args()
    report_path = args.report.resolve()
    if report_path.exists() or not report_path.parent.is_dir():
        parser.error("report must be a new file in an existing directory")
    commit = command("git", "-C", str(args.source.resolve()), "rev-parse", "--verify", "--end-of-options", args.ref + "^{commit}")
    if not re.fullmatch(r"[0-9a-f]{40,64}", commit):
        raise RuntimeError("invalid source commit")
    run_id = uuid.uuid4().hex
    prefix = f"sentinel-it-{run_id[:12]}"
    image = f"sub2api-sentinel-integration:{commit[:12]}"
    network = prefix + "-net"
    volume = prefix + "-pgdata"
    pg, redis, server = [prefix + suffix for suffix in ("-pg", "-redis", "-api")]
    created_containers = []
    created_network = False
    created_volume = False
    report = {"started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "source_commit": commit, "scope": "disposable-local-source-instance",
              "passed": False, "cleanup_complete": False}
    failure = None
    with tempfile.TemporaryDirectory(prefix=prefix + "-") as scratch:
        scratch = Path(scratch)
        os.chmod(scratch, 0o700)
        try:
            print(f"Archiving tracked Sub2API source {commit[:12]}", flush=True)
            archive = subprocess.run(["git", "-C", str(args.source.resolve()), "archive", commit, "backend"],
                                     capture_output=True, check=True, timeout=120).stdout
            context = scratch / "context"
            context.mkdir()
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                # Python's data filter refuses archive path traversal and unsafe links.
                tar.extractall(context, filter="data")
            compliance = (context / "backend/internal/service/admin_compliance.go").read_text()
            version_match = re.search(r'AdminComplianceVersion\s*=\s*"([A-Za-z0-9.\-]+)"', compliance)
            if not version_match:
                raise RuntimeError("unsupported compliance fixture schema")
            version = version_match[1]
            shutil.copyfile(ROOT / "scripts/integration/sub2api.Dockerfile", context / "Dockerfile")
            print("Building API-only source image (serialized Go compilation)", flush=True)
            # Build logs contain no credentials: build precedes all fixture generation.
            with (scratch / "build.log").open("wb") as log:
                build = subprocess.run(["docker", "build", "--build-arg", f"SOURCE_COMMIT={commit}",
                                        "-t", image, str(context)], stdout=log, stderr=subprocess.STDOUT, timeout=1800)
            if build.returncode:
                # Only this credential-free build log can be emitted on failure.
                print((scratch / "build.log").read_text()[-8000:], flush=True)
                raise RuntimeError("source image build failed")
            report["source_image_id"] = command("docker", "image", "inspect", "--format", "{{.Id}}", image)
            print("Building the current Sentinel probe image", flush=True)
            probe_image = "sub2api-balance-sentinel:integration-probe"
            with (scratch / "probe-build.log").open("wb") as log:
                build = subprocess.run(["docker", "build", "-t", probe_image, str(ROOT)],
                                       stdout=log, stderr=subprocess.STDOUT, timeout=1200)
            if build.returncode:
                raise RuntimeError("Sentinel probe image build failed; build output withheld")
            report["probe_image_id"] = command("docker", "image", "inspect", "--format", "{{.Id}}", probe_image)
            probe_root = scratch / "probe"
            shutil.copytree(ROOT / "server/src", probe_root / "server/src")
            (probe_root / "scripts/integration").mkdir(parents=True)
            for script in ("probe-real-sub2api.mjs", "request.mjs"):
                shutil.copyfile(ROOT / "scripts/integration" / script, probe_root / "scripts/integration" / script)
            (probe_root / "node_modules").symlink_to("/app/node_modules", target_is_directory=True)
            private_file(probe_root / "package.json", '{"type":"module"}\n')
            # This read-only mount contains code only. Its secret-bearing parent stays 0700.
            for file in probe_root.rglob("*"):
                if not file.is_symlink():
                    os.chmod(file, 0o755 if file.is_dir() else 0o644)
            os.chmod(probe_root, 0o755)
            for dependency in ("postgres:18-alpine", "redis:8-alpine"):
                command("docker", "pull", dependency, quiet=True)
            report["dependency_images"] = {
                tag: command("docker", "image", "inspect", "--format", "{{.Id}}", tag)
                for tag in ("postgres:18-alpine", "redis:8-alpine")}
            command("docker", "network", "create", "--internal", "--label", f"{LABEL}={run_id}", network)
            created_network = True
            command("docker", "volume", "create", "--label", f"{LABEL}={run_id}", volume)
            created_volume = True
            password, admin_password = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            email = "integration-admin@example.invalid"
            pg_env = scratch / "postgres.env"
            private_file(pg_env, f"POSTGRES_USER=sentinel_test\nPOSTGRES_DB=sentinel_test\nPOSTGRES_PASSWORD={password}\n")
            api_env = scratch / "api.env"
            settings = {
                "AUTO_SETUP": "true", "DATA_DIR": "/app/data", "DATABASE_HOST": pg,
                "DATABASE_PORT": "5432", "DATABASE_USER": "sentinel_test", "DATABASE_PASSWORD": password,
                "DATABASE_DBNAME": "sentinel_test", "DATABASE_SSLMODE": "disable",
                "REDIS_HOST": redis, "REDIS_PORT": "6379", "REDIS_PASSWORD": "",
                "ADMIN_EMAIL": email, "ADMIN_PASSWORD": admin_password,
                "JWT_SECRET": secrets.token_hex(32), "TOTP_ENCRYPTION_KEY": secrets.token_hex(32),
                "SERVER_HOST": "0.0.0.0", "SERVER_PORT": "8080", "SERVER_MODE": "release", "TZ": "UTC",
                "BATCH_IMAGE_ENABLED": "false", "DASHBOARD_AGGREGATION_ENABLED": "false",
                "USAGE_CLEANUP_ENABLED": "false", "OPS_ENABLED": "false", "LOG_OUTPUT_TO_FILE": "false",
                "PRICING_REMOTE_URL": "http://127.0.0.1:9/unavailable",
                "PRICING_HASH_URL": "http://127.0.0.1:9/unavailable",
                "HTTP_PROXY": "", "HTTPS_PROXY": "", "ALL_PROXY": "", "NO_PROXY": "*", "GOMEMLIMIT": "512MiB",
            }
            private_file(api_env, "".join(f"{key}={value}\n" for key, value in settings.items()))

            def create(name, *extra):
                command("docker", "create", "--name", name, "--label", f"{LABEL}={run_id}",
                        "--network", network, "--pids-limit", "128", "--log-opt", "max-size=2m",
                        "--log-opt", "max-file=1", *extra)
                created_containers.append(name)
                command("docker", "start", name, quiet=True)

            create(pg, "--memory", "384m", "--env-file", str(pg_env), "--mount",
                   f"type=volume,src={volume},dst=/var/lib/postgresql", report["dependency_images"]["postgres:18-alpine"])
            create(redis, "--memory", "128m", "--read-only", "--tmpfs", "/data:rw,nosuid,noexec,size=16m",
                   report["dependency_images"]["redis:8-alpine"], "redis-server", "--save", "", "--appendonly", "no")
            ready = False
            for _ in range(60):
                try:
                    # The image briefly starts a socket-only initialization server.
                    # Wait for TCP, which is the transport the API will actually use.
                    command("docker", "exec", pg, "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "sentinel_test", quiet=True)
                    ready = True
                    break
                except RuntimeError:
                    time.sleep(1)
            if not ready:
                raise RuntimeError("isolated PostgreSQL readiness timeout")
            create(server, "--memory", "768m", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges",
                   "--tmpfs", "/app/data:rw,nosuid,noexec,uid=10001,gid=10001,mode=0700,size=32m",
                   "--tmpfs", "/tmp:rw,nosuid,noexec,size=32m", "--env-file", str(api_env),
                   report["source_image_id"])
            # Internal networks may intentionally disable published ports (Docker 29).
            # Both the bootstrap and probe share only this new API's network namespace.
            def node_container(name, script, payload):
                command("docker", "create", "-i", "--name", name, "--label", f"{LABEL}={run_id}",
                        "--network", f"container:{server}", "--log-driver", "none", "--memory", "256m",
                        "--pids-limit", "64", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges",
                        "--tmpfs", "/tmp:rw,nosuid,noexec,mode=1777,size=32m", "--mount",
                        f"type=bind,src={probe_root},dst=/probe,readonly", "--entrypoint", "node",
                        report["probe_image_id"], f"/probe/scripts/integration/{script}")
                created_containers.append(name)
                try:
                    result = subprocess.run(["docker", "start", "--attach", "--interactive", name],
                                            input=json.dumps(payload).encode(), capture_output=True, timeout=180)
                    if result.returncode:
                        # Node scripts return controlled stage names, never raw upstream errors.
                        raise RuntimeError("isolated Node task failed; " + result.stderr.decode().strip()[:1000])
                    return json.loads(result.stdout)
                finally:
                    command("docker", "rm", "-f", "-v", name, quiet=True)
                    created_containers.remove(name)

            def api(route, body=None, bearer=None):
                payload = {"route": route}
                if body is not None:
                    payload["body"] = body
                if bearer:
                    payload["bearer"] = bearer
                result = node_container(prefix + "-bootstrap", "request.mjs", payload)
                return result["status"], result["body"]

            print("Waiting for isolated API startup", flush=True)
            ready = False
            for _ in range(120):
                try:
                    command("docker", "exec", server, "wget", "-q", "-T", "2", "-t", "1", "-O", "-", "http://127.0.0.1:8080/health", quiet=True)
                    ready = True
                    break
                except RuntimeError:
                    state = command("docker", "inspect", "--format", "{{.State.Status}}", server)
                    if state in ("exited", "dead"):
                        raise RuntimeError("isolated API exited before readiness; no upstream logs emitted")
                time.sleep(1)
            if not ready:
                raise RuntimeError("isolated API readiness timeout; no upstream logs emitted")
            code, body = api("/api/v1/auth/login", {"email": email, "password": admin_password})
            if code != 200 or body.get("code") != 0:
                raise RuntimeError("synthetic administrator login failed")
            token = body["data"]["access_token"]
            code, body = api("/api/v1/admin/users", bearer=token)
            if code != 423 or body.get("code") != "ADMIN_COMPLIANCE_ACK_REQUIRED":
                raise RuntimeError("unsupported compliance guard contract")
            report["compliance_guard_http_status"] = code
            # Synthetic test fixture only. Never calls the agreement acceptance endpoint,
            # never targets an existing database, and never represents a human signature.
            fixture_sql = f"""
INSERT INTO settings (key, value, updated_at)
SELECT 'admin_compliance_acknowledgement:' || id,
 json_build_object('version', '{version}', 'admin_user_id', id,
 'user_agent', 'SYNTHETIC TEST FIXTURE - NOT A HUMAN ACKNOWLEDGEMENT',
 'accepted_at', now())::text, now()
FROM users WHERE email = '{email}' AND role = 'admin';
"""
            command("docker", "exec", "-i", pg, "psql", "-v", "ON_ERROR_STOP=1", "-U", "sentinel_test",
                    "-d", "sentinel_test", stdin=fixture_sql.encode(), quiet=True)
            report["compliance_fixture"] = "synthetic disposable DB row; no human acknowledgement or production change"
            code, body = api("/api/v1/admin/settings/admin-api-key/regenerate", {}, bearer=token)
            if code != 200 or body.get("code") != 0 or not body.get("data", {}).get("key"):
                raise RuntimeError("test administrator API key generation failed")
            probe_input = {"baseUrl": "http://127.0.0.1:8080", "adminKey": body["data"]["key"]}
            print("Probing real API with temporary users and an independent ledger", flush=True)
            report["checks"] = node_container(prefix + "-probe", "probe-real-sub2api.mjs", probe_input)
            report["passed"] = True
        except Exception as error:
            # Exceptions must be from controlled messages, not raw HTTP response bodies.
            failure = type(error).__name__ if not isinstance(error, RuntimeError) else str(error)
            report["error"] = failure
            if server in created_containers:
                try:
                    state = command("docker", "inspect", "--format", "{{.State.Status}}/{{.State.ExitCode}}/{{.State.OOMKilled}}", server)
                    report["api_failure_state"] = state
                    log_result = subprocess.run(["docker", "logs", server], capture_output=True, timeout=15)
                    logs = (log_result.stdout + log_result.stderr).decode(errors="replace")
                    report["api_log_indicators"] = [marker for marker in
                        ("permission denied", "read-only file system", "operation not permitted", "connection refused", "panic", "fatal", "invalid configuration")
                        if marker in logs.lower()]
                except RuntimeError:
                    pass
        finally:
            cleanup_errors = []
            for name in reversed(created_containers):
                try:
                    command("docker", "rm", "-f", "-v", name, quiet=True)
                except RuntimeError:
                    cleanup_errors.append(name)
            if created_volume:
                try:
                    command("docker", "volume", "rm", volume, quiet=True)
                except RuntimeError:
                    cleanup_errors.append(volume)
            if created_network:
                try:
                    command("docker", "network", "rm", network, quiet=True)
                except RuntimeError:
                    cleanup_errors.append(network)
            report["cleanup_complete"] = not cleanup_errors
            if cleanup_errors:
                report["cleanup_required"] = cleanup_errors
            report["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            private_file(report_path, json.dumps(report, indent=2) + "\n")
    print(f"Report: {report_path}", flush=True)
    if failure or not report["cleanup_complete"]:
        raise SystemExit(failure or "cleanup incomplete; inspect sanitized report")
    print("Real source integration passed; temporary runtime resources and credentials removed", flush=True)


if __name__ == "__main__":
    main()

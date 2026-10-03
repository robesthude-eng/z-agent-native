"""Offline contract checks; no remote connections or real credentials."""
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.modules["paramiko"] = SimpleNamespace()
spec = importlib.util.spec_from_file_location("ssh_tool", Path(__file__).parent.parent / "server" / "ssh_tool.py")
ssh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ssh)


class Input(io.StringIO):
    def close(self):
        self.closed_value = self.getvalue()
        super().close()


class Client:
    def exec_command(self, command, **kwargs):
        self.command = command
        self.stdin = Input()
        out = io.BytesIO(b"ok")
        out.channel = SimpleNamespace(recv_exit_status=lambda: 0)
        return self.stdin, out, io.BytesIO()

    def close(self):
        pass


class LocalSftp:
    """A local stand-in exercising failed writes before the atomic rename."""
    def __init__(self, root):
        self.root = Path(root)
        self.fail_write = False

    def stat(self, name):
        return (self.root / name).stat()

    def file(self, name, mode):
        if self.fail_write and ".tmp." in name:
            raise OSError("disk full")
        return (self.root / name).open(mode)

    def chmod(self, name, mode):
        (self.root / name).chmod(mode)

    def posix_rename(self, source, dest):
        (self.root / source).replace(self.root / dest)

    def remove(self, name):
        (self.root / name).unlink()


class Contracts(unittest.TestCase):
    def test_sudo_uses_env_password_on_stdin(self):
        os.environ["Z_AGENT_SSH_PASSWORD"] = "test'password;$(false)"
        try:
            client = Client()
            args = SimpleNamespace(password=None, user="operator", timeout=10)
            ssh.exec_remote(client, args, "printf '%s' hello", sudo=True)
            self.assertTrue(client.command.startswith("sudo -S -p '' -- sh -c "))
            self.assertNotIn(os.environ["Z_AGENT_SSH_PASSWORD"], client.command)
            self.assertEqual(client.stdin.closed_value, os.environ["Z_AGENT_SSH_PASSWORD"] + "\n")
        finally:
            del os.environ["Z_AGENT_SSH_PASSWORD"]

    def test_service_reload_logs_and_stop(self):
        for action, fragment in [("reload", "systemctl reload -- nginx"), ("logs", "journalctl --unit=nginx -n 17"), ("stop", "systemctl stop -- nginx")]:
            client = Client()
            ssh.get_client = lambda *args: client
            args = SimpleNamespace(host="unused", user="root", password=None, key=None, port=22, timeout=10, sudo=False, name="nginx", action=action, lines=17)
            with self.assertRaises(SystemExit) as stopped:
                ssh.cmd_service(args)
            self.assertEqual(stopped.exception.code, 0)
            self.assertIn(fragment, client.command)
            # An intentionally stopped service must not fail a subsequent status probe.
            self.assertNotIn("&& systemctl status", client.command)

    def test_atomic_write_keeps_original_on_failure_and_backups_on_success(self):
        with tempfile.TemporaryDirectory() as root:
            live = Path(root) / "app.txt"
            live.write_text("original")
            live.chmod(0o640)
            sftp = LocalSftp(root)
            sftp.fail_write = True
            with self.assertRaisesRegex(OSError, "disk full"):
                ssh.atomic_write(sftp, "app.txt", "replacement")
            self.assertEqual(live.read_text(), "original")
            sftp.fail_write = False
            ssh.atomic_write(sftp, "app.txt", "replacement")
            self.assertEqual(live.read_text(), "replacement")
            self.assertEqual(live.stat().st_mode & 0o777, 0o640)
            self.assertTrue(all(p.read_text() == "original" for p in Path(root).glob("*.bak.*")))
            self.assertEqual(list(Path(root).glob("*.tmp.*")), [])
            ssh.atomic_write(sftp, "new.txt", "new")
            self.assertEqual((Path(root) / "new.txt").read_text(), "new")


if __name__ == "__main__":
    unittest.main()

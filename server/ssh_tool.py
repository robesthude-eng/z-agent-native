#!/usr/bin/env python3
"""
ssh_tool - Robust Remote Operations & Management CLI for Z Agent.
Enables reliable execution, remote file reading, atomic editing with backups,
file transfers, and systemd service management over SSH.
"""

from __future__ import annotations

import argparse
import datetime
import os
import sys
import tempfile
from pathlib import Path

try:
    import paramiko
except ImportError:
    print("Error: paramiko is required for ssh_tool. Run: pip install paramiko", file=sys.stderr)
    sys.exit(1)


def get_client(host: str, user: str, password: str | None = None, key_file: str | None = None, port: int = 22, timeout: int = 15) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    connect_kwargs = {
        "hostname": host,
        "username": user,
        "port": port,
        "timeout": timeout,
        "banner_timeout": timeout,
        "auth_timeout": timeout,
    }
    
    if key_file and os.path.exists(key_file):
        try:
            connect_kwargs["key_filename"] = key_file
        except Exception as e:
            print(f"Warning: Failed to load key file {key_file}: {e}", file=sys.stderr)
            
    if password:
        connect_kwargs["password"] = password
        
    try:
        client.connect(**connect_kwargs)
        return client
    except Exception as e:
        # If key failed and password provided, retry password
        if key_file and password:
            connect_kwargs.pop("key_filename", None)
            client.connect(**connect_kwargs)
            return client
        raise e


def cmd_test(args):
    try:
        client = get_client(args.host, args.user, args.password, args.key, args.port, args.timeout)
        stdin, stdout, stderr = client.exec_command("whoami && hostname && uname -a && uptime")
        out = stdout.read().decode("utf-8", errors="replace").strip()
        client.close()
        print(f"✓ Connection SUCCESS to {args.user}@{args.host}:{args.port}")
        print("System Info:")
        print(out)
    except Exception as e:
        print(f"✗ Connection FAILED to {args.user}@{args.host}:{args.port} - {e}", file=sys.stderr)
        sys.exit(1)


def cmd_exec(args):
    try:
        client = get_client(args.host, args.user, args.password, args.key, args.port, args.timeout)
        cmd = args.cmd
        if args.sudo and args.user != "root":
            if args.password:
                cmd = f"echo '{args.password}' | sudo -S {cmd}"
            else:
                cmd = f"sudo {cmd}"
                
        stdin, stdout, stderr = client.exec_command(cmd, timeout=args.timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        exit_code = stdout.channel.recv_exit_status()
        client.close()
        
        if out:
            print(out, end="" if out.endswith("\n") else "\n")
        if err:
            print(err, file=sys.stderr, end="" if err.endswith("\n") else "\n")
        sys.exit(exit_code)
    except Exception as e:
        print(f"Error executing command: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_read(args):
    try:
        client = get_client(args.host, args.user, args.password, args.key, args.port, args.timeout)
        sftp = client.open_sftp()
        try:
            with sftp.file(args.path, "r") as f:
                content = f.read().decode("utf-8", errors="replace")
        finally:
            sftp.close()
            client.close()
            
        lines = content.splitlines()
        offset = max(0, args.offset - 1) if args.offset > 0 else 0
        limit = args.limit if args.limit > 0 else len(lines)
        slice_lines = lines[offset : offset + limit]
        
        for i, line in enumerate(slice_lines, start=offset + 1):
            print(f"{i:5d} | {line}")
            
        print(f"\n[Total lines: {len(lines)}, displayed: {len(slice_lines)}]")
    except Exception as e:
        print(f"Error reading remote file {args.path}: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_write(args):
    try:
        content = args.content
        if content is None and args.file:
            content = Path(args.file).read_text(encoding="utf-8")
        elif content is None:
            content = sys.stdin.read()
            
        client = get_client(args.host, args.user, args.password, args.key, args.port, args.timeout)
        sftp = client.open_sftp()
        
        # Backup remote file if it exists
        remote_path = args.path
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = f"{remote_path}.bak.{timestamp}"
        try:
            sftp.stat(remote_path)
            # File exists -> make backup
            sftp.posix_rename(remote_path, backup_path)
            print(f"✓ Created remote backup: {backup_path}")
        except IOError:
            # File doesn't exist yet
            pass
            
        # Write new content
        with sftp.file(remote_path, "w") as f:
            f.write(content.encode("utf-8"))
            
        sftp.close()
        client.close()
        print(f"✓ Successfully wrote {len(content)} characters to {remote_path}")
    except Exception as e:
        print(f"Error writing to remote file {args.path}: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_patch(args):
    try:
        client = get_client(args.host, args.user, args.password, args.key, args.port, args.timeout)
        sftp = client.open_sftp()
        remote_path = args.path
        
        # Read current content
        with sftp.file(remote_path, "r") as f:
            content = f.read().decode("utf-8", errors="replace")
            
        old_text = args.old
        new_text = args.new
        
        if old_text not in content:
            # Try normalized whitespace
            import re
            norm_old = re.sub(r"\s+", " ", old_text).strip()
            norm_content = re.sub(r"\s+", " ", content)
            if norm_old not in norm_content:
                sftp.close()
                client.close()
                print(f"Error: Target text not found in {remote_path}", file=sys.stderr)
                sys.exit(1)
            else:
                sftp.close()
                client.close()
                print(f"Error: Target text matched only with loose whitespace in {remote_path}. Please provide exact match.", file=sys.stderr)
                sys.exit(1)
                
        # Create backup
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = f"{remote_path}.bak.{timestamp}"
        # Copy to backup
        with sftp.file(backup_path, "w") as f:
            f.write(content.encode("utf-8"))
        print(f"✓ Created remote backup: {backup_path}")
        
        # Replace only first occurrence
        updated_content = content.replace(old_text, new_text, 1)
        
        with sftp.file(remote_path, "w") as f:
            f.write(updated_content.encode("utf-8"))
            
        sftp.close()
        client.close()
        print(f"✓ Successfully applied patch to {remote_path}")
    except Exception as e:
        print(f"Error patching remote file {args.path}: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_service(args):
    try:
        client = get_client(args.host, args.user, args.password, args.key, args.port, args.timeout)
        srv = args.name
        action = args.action.lower()
        
        sudo_prefix = ""
        if args.user != "root":
            sudo_prefix = f"echo '{args.password}' | sudo -S " if args.password else "sudo "
            
        if action == "status":
            cmd = f"systemctl status {srv} --no-pager"
        elif action == "restart":
            cmd = f"{sudo_prefix}systemctl restart {srv} && systemctl status {srv} --no-pager"
        elif action == "start":
            cmd = f"{sudo_prefix}systemctl start {srv} && systemctl status {srv} --no-pager"
        elif action == "stop":
            cmd = f"{sudo_prefix}systemctl stop {srv} && systemctl status {srv} --no-pager"
        elif action == "logs":
            cmd = f"journalctl -u {srv} -n 50 --no-pager"
        else:
            print(f"Unknown action: {action}", file=sys.stderr)
            sys.exit(1)
            
        stdin, stdout, stderr = client.exec_command(cmd)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        exit_code = stdout.channel.recv_exit_status()
        client.close()
        
        print(f"=== Service {srv} ({action}) ===")
        if out:
            print(out)
        if err:
            print(err, file=sys.stderr)
        sys.exit(exit_code)
    except Exception as e:
        print(f"Error managing service {args.name}: {e}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="ssh_tool - Remote Server Management & Automation")
    subparsers = parser.add_subparsers(dest="command", required=True)
    
    # Common connection options
    def add_conn_args(p):
        p.add_argument("--host", required=True, help="Remote host IP or hostname")
        p.add_argument("--user", default="root", help="SSH username (default: root)")
        p.add_argument("--password", help="SSH password (optional if key is used)")
        p.add_argument("--key", help="SSH private key path")
        p.add_argument("--port", type=int, default=22, help="SSH port (default: 22)")
        p.add_argument("--timeout", type=int, default=15, help="Timeout in seconds (default: 15)")
        p.add_argument("--sudo", action="store_true", help="Run with sudo")

    # 1. test
    p_test = subparsers.add_parser("test", help="Test SSH connectivity")
    add_conn_args(p_test)
    p_test.set_defaults(func=cmd_test)
    
    # 2. exec
    p_exec = subparsers.add_parser("exec", help="Execute remote command")
    add_conn_args(p_exec)
    p_exec.add_argument("--cmd", required=True, help="Command to execute on remote server")
    p_exec.set_defaults(func=cmd_exec)
    
    # 3. read
    p_read = subparsers.add_parser("read", help="Read remote file contents")
    add_conn_args(p_read)
    p_read.add_argument("--path", required=True, help="Remote file path")
    p_read.add_argument("--offset", type=int, default=1, help="Starting line (1-based)")
    p_read.add_argument("--limit", type=int, default=200, help="Maximum lines to read")
    p_read.set_defaults(func=cmd_read)
    
    # 4. write
    p_write = subparsers.add_parser("write", help="Write/overwrite remote file with automatic backup")
    add_conn_args(p_write)
    p_write.add_argument("--path", required=True, help="Remote file path")
    p_write.add_argument("--content", help="New file content")
    p_write.add_argument("--file", help="Local file to upload as content")
    p_write.set_defaults(func=cmd_write)
    
    # 5. patch
    p_patch = subparsers.add_parser("patch", help="Search & replace text in remote file with automatic backup")
    add_conn_args(p_patch)
    p_patch.add_argument("--path", required=True, help="Remote file path")
    p_patch.add_argument("--old", required=True, help="Exact old text to find")
    p_patch.add_argument("--new", required=True, help="New replacement text")
    p_patch.set_defaults(func=cmd_patch)
    
    # 6. service
    p_srv = subparsers.add_parser("service", help="Manage remote systemd service")
    add_conn_args(p_srv)
    p_srv.add_argument("--name", required=True, help="Service name (e.g. nginx, travian_player)")
    p_srv.add_argument("--action", default="status", choices=["status", "restart", "start", "stop", "logs"], help="Service action")
    p_srv.set_defaults(func=cmd_service)
    
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Push local files to paths on the HA box (base64 via ha_shell.py).

Usage: push_files.py <local1>:<remote1> [<local2>:<remote2> ...]

Writes each file atomically (tmp + mv) and prints the remote sha256 next to the
local one so a truncated transfer is loud, not silent.
"""
import base64, hashlib, subprocess, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))

pairs = [a.split(":", 1) for a in sys.argv[1:]]
assert pairs, __doc__

script_lines = []
for local, remote in pairs:
    data = open(local, "rb").read()
    b64 = base64.b64encode(data).decode()
    print(f"{local} -> {remote} ({len(data)} bytes, sha256 {hashlib.sha256(data).hexdigest()[:12]})")
    script_lines.append(f"rm -f /tmp/.push_b64")
    for i in range(0, len(b64), 4096):
        script_lines.append(f"printf %s '{b64[i:i+4096]}' >> /tmp/.push_b64")
    script_lines.append(f"base64 -d /tmp/.push_b64 > '{remote}.tmp' && mv '{remote}.tmp' '{remote}'")
    script_lines.append(f"echo REMOTE $(sha256sum '{remote}' | cut -c1-12) '{remote}'")
script_lines.append("rm -f /tmp/.push_b64")

script = "\n".join(script_lines)
proc = subprocess.run(
    ["python3", os.path.join(HERE, "ha_shell.py"), "/dev/stdin"],
    input=script.encode(),
    capture_output=False,
)
sys.exit(proc.returncode)

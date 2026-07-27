#!/usr/bin/env python3
"""Run a shell script on the HA box via the Advanced SSH & Web Terminal add-on's
ingress ttyd WebSocket, reached at $CHICKADEE_HA_HOST.

Usage: python3 ha_shell.py <script-file>
       python3 ha_shell.py -c 'command string'

Output between __START__/__DONE__ markers is printed; exits with the remote rc.
"""
import asyncio, json, os, sys, uuid

import websockets

HA = os.environ.get("CHICKADEE_HA_HOST") or exit("set CHICKADEE_HA_HOST to your HA hostname (e.g. homeassistant.local:8123 or your remote URL host)")
SSH_ADDON = "a0d7b954_ssh"
TOKEN = open(os.path.expanduser("~/.ha_token")).read().strip()


async def sup_api(ws, wid, endpoint, method="get", data=None):
    msg = {"id": wid, "type": "supervisor/api", "endpoint": endpoint, "method": method}
    if data is not None:
        msg["data"] = data
    await ws.send(json.dumps(msg))
    while True:
        resp = json.loads(await ws.recv())
        if resp.get("id") == wid and resp.get("type") == "result":
            if not resp.get("success"):
                raise RuntimeError(f"supervisor/api {endpoint} failed: {resp}")
            return resp.get("result")


async def main():
    if sys.argv[1] == "-c":
        script = sys.argv[2]
    else:
        script = open(sys.argv[1]).read()

    nonce = uuid.uuid4().hex[:8]

    # 1) HA WS: auth, get ingress session + the ssh add-on's ingress token
    async with websockets.connect(f"wss://{HA}/api/websocket", max_size=16 * 1024 * 1024) as ws:
        await ws.recv()
        await ws.send(json.dumps({"type": "auth", "access_token": TOKEN}))
        auth = json.loads(await ws.recv())
        assert auth.get("type") == "auth_ok", auth
        session = (await sup_api(ws, 1, "/ingress/session", "post"))["session"]
        info = await sup_api(ws, 2, f"/addons/{SSH_ADDON}/info")
        ingress = info["ingress_entry"]

    # 2) ttyd WS through ingress
    url = f"wss://{HA}{ingress}/ws"
    headers = {"Cookie": f"ingress_session={session}"}
    out = []
    started = False
    async with websockets.connect(
        url, subprotocols=["tty"], additional_headers=headers, max_size=16 * 1024 * 1024
    ) as tty:
        await tty.send(json.dumps({"AuthToken": "", "columns": 500, "rows": 50}))

        async def send_line(line):
            await tty.send("0" + line + "\n")

        # Markers live INSIDE the b64 payload so the terminal's echo of typed
        # command lines can never contain them (base64 alphabet has no '_').
        wrapped = (
            f"echo __START_{nonce}__\n"
            "(\n" + script + "\n) 2>&1\n"
            f"echo __DONE_{nonce}_$?__\n"
        )
        b64 = __import__("base64").b64encode(wrapped.encode()).decode()
        await asyncio.sleep(1.0)  # let the shell start
        await send_line("stty -echo 2>/dev/null; export PS1=''")
        # stream the script as base64 printf-appends (avoids echo/quoting hell)
        await send_line(f"rm -f /tmp/.chk_{nonce}")
        for i in range(0, len(b64), 4096):
            await send_line(f"printf %s '{b64[i:i+4096]}' >> /tmp/.chk_{nonce}")
        await send_line(
            f"bash -c 'base64 -d /tmp/.chk_{nonce} > /tmp/.run_{nonce}.sh; "
            f"bash /tmp/.run_{nonce}.sh; rm -f /tmp/.chk_{nonce} /tmp/.run_{nonce}.sh'"
        )

        buf = ""
        rc = None
        try:
            while True:
                m = await asyncio.wait_for(tty.recv(), timeout=180)
                if isinstance(m, bytes):
                    kind, data = m[:1].decode(), m[1:].decode("utf-8", "replace")
                else:
                    kind, data = m[:1], m[1:]
                if kind != "0":
                    continue
                buf += data
                if not started and f"__START_{nonce}__" in buf:
                    started = True
                    buf = buf.split(f"__START_{nonce}__", 1)[1]
                if started and f"__DONE_{nonce}_" in buf:
                    body, tail = buf.split(f"__DONE_{nonce}_", 1)
                    out.append(body)
                    rc = int(tail.split("__", 1)[0])
                    break
        except asyncio.TimeoutError:
            print("[ha_shell] TIMEOUT waiting for command", file=sys.stderr)
            print(buf[-3000:], file=sys.stderr)
            sys.exit(124)

    text = "".join(out)
    # strip \r and ANSI escape sequences that the tty inserts
    import re
    text = text.replace("\r\n", "\n").replace("\r", "")
    text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\([0-9A-Za-z]|\x1b[=>]", "", text)
    sys.stdout.write(text)
    sys.exit(rc if rc is not None else 1)


asyncio.run(main())

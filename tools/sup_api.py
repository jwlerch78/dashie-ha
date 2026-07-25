#!/usr/bin/env python3
"""One-shot Supervisor API call via the HA WebSocket proxy.
Usage: sup_api.py <endpoint> [method] [json-data] [timeout-s]"""
import asyncio, json, os, sys
import websockets

HA = "ha.dashieapp.com"
TOKEN = open(os.path.expanduser("~/.ha_token")).read().strip()


async def main():
    endpoint = sys.argv[1]
    method = sys.argv[2] if len(sys.argv) > 2 else "get"
    data = json.loads(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else None
    timeout = float(sys.argv[4]) if len(sys.argv) > 4 else 120
    async with websockets.connect(f"wss://{HA}/api/websocket", max_size=32 * 1024 * 1024) as ws:
        await ws.recv()
        await ws.send(json.dumps({"type": "auth", "access_token": TOKEN}))
        assert json.loads(await ws.recv()).get("type") == "auth_ok"
        msg = {"id": 1, "type": "supervisor/api", "endpoint": endpoint, "method": method}
        if data is not None:
            msg["data"] = data
        await ws.send(json.dumps(msg))
        while True:
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
            if resp.get("id") == 1 and resp.get("type") == "result":
                print(json.dumps(resp, indent=1, default=str)[:4000])
                sys.exit(0 if resp.get("success") else 1)


asyncio.run(main())

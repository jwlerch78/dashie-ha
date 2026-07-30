#!/usr/bin/env python3
"""Drive Dashie Voice config-entry lifecycle on the HA box headlessly (REST + WS).

Usage:
  entry_flow.py list                     # dashie_voice config entries
  entry_flow.py delete                   # delete the dashie_voice config entry
  entry_flow.py add [assistant-name]     # config flow: create the entry
  entry_flow.py options [new-name]       # options flow: show status / rename
  entry_flow.py pipelines                # list Assist pipelines (name, engines)
  entry_flow.py delete-pipeline <name>   # delete a pipeline by exact name

Built for the auto-create-pipeline verify: delete + re-add the entry without the
UI, then check the pipeline appeared. Auth from ~/.ha_token via your HA host (DASHIE_HA_HOST).
"""
import asyncio, json, os, sys, urllib.request

HA = os.environ.get("DASHIE_HA_HOST") or exit("set DASHIE_HA_HOST to your HA hostname (e.g. homeassistant.local:8123 or your remote URL host)")
TOKEN = open(os.path.expanduser("~/.ha_token")).read().strip()
HDRS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
    "User-Agent": "dashie-ha-rig/1.0",
}


def rest(path, method="GET", body=None):
    req = urllib.request.Request(
        f"https://{HA}{path}",
        method=method,
        headers=HDRS,
        data=json.dumps(body).encode() if body is not None else None,
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else None


def dashie_voice_entries():
    return [e for e in rest("/api/config/config_entries/entry") if e["domain"] == "dashie-ha"]


async def ws_cmd(msg):
    import websockets

    async with websockets.connect(f"wss://{HA}/api/websocket", max_size=16 * 1024 * 1024) as ws:
        await ws.recv()
        await ws.send(json.dumps({"type": "auth", "access_token": TOKEN}))
        assert json.loads(await ws.recv()).get("type") == "auth_ok"
        await ws.send(json.dumps({"id": 1, **msg}))
        while True:
            resp = json.loads(await ws.recv())
            if resp.get("id") == 1 and resp.get("type") == "result":
                if not resp.get("success"):
                    raise RuntimeError(f"{msg['type']} failed: {resp}")
                return resp.get("result")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"

    if cmd == "list":
        for e in dashie_voice_entries():
            print(e["entry_id"], e["state"], repr(e["title"]), e["data"] if "data" in e else "")
        return

    if cmd == "delete":
        entries = dashie_voice_entries()
        if not entries:
            print("no dashie_voice entry")
            return
        for e in entries:
            print("deleting", e["entry_id"], rest(f"/api/config/config_entries/entry/{e['entry_id']}", "DELETE"))
        return

    if cmd == "add":
        name = sys.argv[2] if len(sys.argv) > 2 else "Dashie"
        flow = rest("/api/config/config_entries/flow", "POST", {"handler": "dashie-ha", "show_advanced_options": False})
        print("flow step:", flow["type"], flow.get("step_id"), "errors:", flow.get("errors"))
        step = rest(f"/api/config/config_entries/flow/{flow['flow_id']}", "POST", {"assistant_name": name})
        if step["type"] == "form" and step.get("errors"):
            # add-on unreachable path — take the explicit override
            print("form errors:", step["errors"], "-> retrying with ignore_addon")
            step = rest(
                f"/api/config/config_entries/flow/{step['flow_id']}",
                "POST",
                {"assistant_name": name, "ignore_addon": True},
            )
        print("result:", step["type"], step.get("title"), step.get("result", {}))
        return

    if cmd == "options":
        entries = dashie_voice_entries()
        assert entries, "no dashie_voice entry"
        flow = rest("/api/config/config_entries/options/flow", "POST", {"handler": entries[0]["entry_id"]})
        print("options step:", flow["type"], flow.get("step_id"))
        print("description_placeholders:", flow.get("description_placeholders"))
        if len(sys.argv) > 2:
            step = rest(
                f"/api/config/config_entries/options/flow/{flow['flow_id']}",
                "POST",
                {"assistant_name": sys.argv[2]},
            )
            print("result:", step["type"])
        return

    if cmd == "pipelines":
        res = asyncio.run(ws_cmd({"type": "assist_pipeline/pipeline/list"}))
        for p in res["pipelines"]:
            mark = " (preferred)" if p["id"] == res.get("preferred_pipeline") else ""
            print(f"{p['id']} {p['name']!r}{mark} conv={p['conversation_engine']} stt={p['stt_engine']} tts={p['tts_engine']} voice={p['tts_voice']}")
        return

    if cmd == "delete-pipeline":
        target = sys.argv[2]
        res = asyncio.run(ws_cmd({"type": "assist_pipeline/pipeline/list"}))
        pipe = next((p for p in res["pipelines"] if p["name"] == target), None)
        assert pipe, f"no pipeline named {target!r}"
        print("deleting", pipe["id"], asyncio.run(ws_cmd({"type": "assist_pipeline/pipeline/delete", "pipeline_id": pipe["id"]})))
        return

    sys.exit(f"unknown command {cmd}")


main()

#!/usr/bin/env python3
"""Run a full Chickadee Assist pipeline over the HA WebSocket:
16 kHz PCM audio in → stt.chickadee_stt → conversation.chickadee → tts.chickadee_tts.

Usage: pipeline_run.py <wav-file> [pipeline-name]
With no name, targets "Chickadee (full)" and creates it if missing (legacy rig
behavior). With an explicit name it must already exist — no silent create, so a
missing auto-created pipeline FAILS instead of being masked.
Prints each pipeline event's essentials; downloads the TTS result to /tmp/pipeline-tts-out.wav.
"""
import asyncio, json, os, sys, wave

import websockets

HA = "ha.dashieapp.com"
TOKEN = open(os.path.expanduser("~/.ha_token")).read().strip()
PIPELINE_NAME = sys.argv[2] if len(sys.argv) > 2 else "Chickadee (full)"
ALLOW_CREATE = len(sys.argv) <= 2


async def ws_cmd(ws, wid, msg):
    msg = {"id": wid, **msg}
    await ws.send(json.dumps(msg))
    while True:
        resp = json.loads(await ws.recv())
        if resp.get("id") == wid and resp.get("type") == "result":
            if not resp.get("success"):
                raise RuntimeError(f"{msg['type']} failed: {resp}")
            return resp.get("result")


async def main():
    wav = wave.open(sys.argv[1], "rb")
    assert wav.getframerate() == 16000 and wav.getnchannels() == 1 and wav.getsampwidth() == 2, "need 16k mono pcm16"
    pcm = wav.readframes(wav.getnframes())

    async with websockets.connect(f"wss://{HA}/api/websocket", max_size=32 * 1024 * 1024) as ws:
        await ws.recv()
        await ws.send(json.dumps({"type": "auth", "access_token": TOKEN}))
        assert json.loads(await ws.recv()).get("type") == "auth_ok"

        # Find-or-create the pipeline
        pipelines = await ws_cmd(ws, 1, {"type": "assist_pipeline/pipeline/list"})
        pipe = next((p for p in pipelines["pipelines"] if p["name"] == PIPELINE_NAME), None)
        if not pipe and not ALLOW_CREATE:
            print(f"FAIL: pipeline '{PIPELINE_NAME}' not found (and explicit name = no create)")
            print("have:", [p["name"] for p in pipelines["pipelines"]])
            sys.exit(1)
        if not pipe:
            pipe = await ws_cmd(ws, 2, {
                "type": "assist_pipeline/pipeline/create",
                "name": PIPELINE_NAME,
                "language": "en",
                "conversation_engine": "conversation.chickadee",
                "conversation_language": "en",
                "stt_engine": "stt.chickadee_stt",
                "stt_language": "en",
                "tts_engine": "tts.chickadee_tts",
                "tts_language": "en-US",
                "tts_voice": "af_heart",
                "wake_word_entity": None,
                "wake_word_id": None,
            })
            print("created pipeline", pipe["id"])
        else:
            print("using pipeline", pipe["id"])

        # Run: audio in → tts out
        run_id = 10
        await ws.send(json.dumps({
            "id": run_id, "type": "assist_pipeline/run",
            "start_stage": "stt", "end_stage": "tts",
            "input": {"sample_rate": 16000},
            "pipeline": pipe["id"],
        }))
        handler = None
        tts_url = None
        deadline = asyncio.get_event_loop().time() + 120
        sent = False
        while True:
            timeout = deadline - asyncio.get_event_loop().time()
            raw = await asyncio.wait_for(ws.recv(), timeout=max(1, timeout))
            if isinstance(raw, bytes):
                continue
            msg = json.loads(raw)
            if msg.get("id") != run_id:
                continue
            if msg.get("type") == "result":
                if not msg.get("success"):
                    print("RUN REFUSED:", msg); return
                continue
            ev = msg.get("event", {})
            etype, data = ev.get("type"), ev.get("data") or {}
            if etype == "run-start":
                handler = data["runner_data"]["stt_binary_handler_id"]
                print("run-start; handler", handler)
                # stream the audio then an end-of-stream frame
                prefix = bytes([handler])
                for i in range(0, len(pcm), 4096):
                    await ws.send(prefix + pcm[i:i + 4096])
                await ws.send(prefix)
                sent = True
            elif etype == "stt-end":
                print("STT TEXT:", json.dumps(data.get("stt_output", {}).get("text")))
            elif etype == "intent-end":
                speech = (((data.get("intent_output") or {}).get("response") or {})
                          .get("speech") or {}).get("plain", {}).get("speech")
                print("INTENT SPEECH:", speech)
            elif etype == "tts-end":
                tts_url = (data.get("tts_output") or {}).get("url")
                print("TTS URL:", tts_url)
            elif etype == "error":
                print("PIPELINE ERROR:", data); return
            elif etype == "run-end":
                print("run-end")
                break
        if tts_url:
            # Best-effort: tts_proxy URLs are short-lived/one-shot — an expired
            # fetch is a warning, not a failed run (the pipeline itself succeeded).
            import urllib.request
            try:
                req = urllib.request.Request(
                    f"https://{HA}{tts_url}", headers={"Authorization": f"Bearer {TOKEN}"}
                )
                audio = urllib.request.urlopen(req, timeout=30).read()
                open("/tmp/pipeline-tts-out.wav", "wb").write(audio)
                print("TTS AUDIO:", len(audio), "bytes -> /tmp/pipeline-tts-out.wav")
            except Exception as err:
                print(f"TTS AUDIO fetch skipped ({err}) — pipeline itself completed")


asyncio.run(main())

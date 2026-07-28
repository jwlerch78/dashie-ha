# Dev rig — remote HA-box test tools

Drive a dev HA box from a workstation without LAN/Tailscale (everything rides
$CHICKADEE_HA_HOST; auth from `~/.ha_token`). Python deps: `websockets`.

| Tool | What it does |
|---|---|
| `ha_shell.py <script\|-c 'cmd'>` | Root shell on the box via the SSH add-on's ingress ttyd WebSocket. Used to copy files into `/config/custom_components` + `/addons` (base64 payload pattern) and to read `docker logs`. |
| `sup_api.py <endpoint> [method] [json] [timeout]` | Supervisor API via the HA WS `supervisor/api` proxy (REST `/api/hassio/*` 401s). Store reload / addon install / update / options / restart / core restart. |
| `pipeline_run.py <16k-mono-wav> [pipeline-name]` | Full Assist pipeline run over WS: audio → chickadee STT → brain → chickadee TTS. Prints stt text / intent speech / tts URL. Explicit name = must exist (no silent create). |
| `entry_flow.py list\|delete\|add\|options\|pipelines\|delete-pipeline` | Headless chickadee config-entry lifecycle (REST) + Assist pipeline list/delete (WS). Built for the auto-create-pipeline verify. |
| `push_files.py <local>:<remote> ...` | Copy files onto the box via ha_shell (base64, atomic mv, sha256-checked). |

Gotchas (hard-won): $CHICKADEE_HA_HOST drops responses >~2 min (drive long calls
ON-box via ha_shell + nohup); the ttyd terminal replays old screen content, so
grep tool output out of the noise; local add-on slug is `local_chickadee`
(container `addon_local_chickadee`, hostname `local-chickadee`).

# Local patches for dependencies

## hermes-session-stream-stop.patch (Hermes Agent `gateway/platforms/api_server.py`)

Office agents run through Hermes' `POST /api/sessions/{id}/chat/stream`. Upstream, a client
disconnect only cancels the asyncio wrapper (the agent thread keeps running) and
`POST /v1/runs/{run_id}/stop` returns 404 for these runs, so `office-ctl stop` cannot stop them.
The patch registers each session-chat run's agent so stop and disconnect interrupt it.

`hermes update` can overwrite it. The adapter logs
`Hermes could not stop run … (404): is patches/hermes-session-stream-stop.patch applied?` when it is missing.

```bash
cd ~/.hermes/hermes-agent
git apply --check ~/claw3d/patches/hermes-session-stream-stop.patch && git apply ~/claw3d/patches/hermes-session-stream-stop.patch
systemctl --user restart hermes-gateway-claw3d
```

Verify with the E2E check FT5 (`scripts/test-shared-session-e2e.mjs`).

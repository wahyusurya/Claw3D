# Local patches for dependencies

## Current patches

None. `hermes-session-stream-stop.patch` (session-chat runs could not be stopped) was retired on
2026-10-18: Hermes v0.22 fixes it upstream (stop returns 200, `run.cancelled`, command interrupted;
E2E FT5 verifies it).

`apply-hermes-patches.sh` stays as the mechanism for any future `hermes-*.patch`: it re-applies every patch
before each gateway start (no-op when applied, warning when it no longer fits, never blocks the start),
because `hermes update` stashes local changes and restores them only if they still fit. Install it as a
systemd drop-in:

```bash
mkdir -p ~/.config/systemd/user/hermes-gateway-claw3d.service.d
printf '[Service]\nExecStartPre=-/bin/sh %s/patches/apply-hermes-patches.sh\n' ~/claw3d \
  > ~/.config/systemd/user/hermes-gateway-claw3d.service.d/claw3d-patches.conf
systemctl --user daemon-reload
```

Check the gateway journal for `claw3d-patches:` lines to see what it did at the last start.

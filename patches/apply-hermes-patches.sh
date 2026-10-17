#!/bin/sh
# Re-apply Claw3D's local Hermes patches (`hermes update` can drop them). Run before the Hermes
# gateway starts (systemd ExecStartPre). Never blocks the start: a patch that no longer fits is
# only reported, and the adapter's "could not stop run (404)" warning stays the alarm for it.
HERMES_DIR="${HERMES_DIR:-$HOME/.hermes/hermes-agent}"
PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$HERMES_DIR" || exit 0
for patch in "$PATCH_DIR"/hermes-*.patch; do
  [ -f "$patch" ] || continue
  name=$(basename "$patch")
  if git apply --reverse --check "$patch" 2>/dev/null; then
    echo "claw3d-patches: $name already applied"
  elif git apply "$patch" 2>/dev/null; then
    echo "claw3d-patches: $name re-applied"
  else
    echo "claw3d-patches: WARNING $name does not apply to this Hermes version; update the patch (see patches/README.md)" >&2
  fi
done
exit 0

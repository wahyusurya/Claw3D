#!/usr/bin/env bash
# Set the Claw3D Studio username/password. Only an scrypt hash is stored (in .env.docker),
# then the studio container is recreated to pick it up. Run it in your own terminal.
set -euo pipefail
cd "$(dirname "$0")"

read -rp "Username: " LOGIN_USER
[[ "$LOGIN_USER" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "Username: 1-64 chars of letters, digits, . _ -" >&2; exit 1; }
read -rsp "Password: " LOGIN_PASSWORD; echo
read -rsp "Repeat password: " LOGIN_PASSWORD2; echo
[[ "$LOGIN_PASSWORD" == "$LOGIN_PASSWORD2" ]] || { echo "Passwords do not match." >&2; exit 1; }
(( ${#LOGIN_PASSWORD} >= 8 )) || { echo "Use at least 8 characters." >&2; exit 1; }

# Same parameters as Node's crypto.scryptSync defaults (N=16384, r=8, p=1, 32-byte key).
HASH=$(LOGIN_PASSWORD="$LOGIN_PASSWORD" python3 -c '
import hashlib, os
salt = os.urandom(16)
key = hashlib.scrypt(os.environ["LOGIN_PASSWORD"].encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
print(f"scrypt:{salt.hex()}:{key.hex()}")')
unset LOGIN_PASSWORD LOGIN_PASSWORD2

umask 077
grep -vE '^STUDIO_LOGIN_(USER|PASSWORD_HASH)=' .env.docker > .env.docker.tmp || true
printf 'STUDIO_LOGIN_USER=%s\nSTUDIO_LOGIN_PASSWORD_HASH=%s\n' "$LOGIN_USER" "$HASH" >> .env.docker.tmp
mv .env.docker.tmp .env.docker

docker compose up -d studio
HOST=$(sed -n 's/^CLAW3D_HOST=//p' .env 2>/dev/null | tail -1)
PORT=$(sed -n 's/^CLAW3D_PORT=//p' .env 2>/dev/null | tail -1)
echo "Done. Sign in at http://${HOST:-<CLAW3D_HOST>}:${PORT:-3005} as '$LOGIN_USER'."

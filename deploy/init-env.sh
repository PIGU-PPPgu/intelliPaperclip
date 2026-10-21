#!/usr/bin/env bash
set -euo pipefail

deploy_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
env_file="$deploy_dir/.env"

if [[ $# -ne 2 || ( "$1" != private && "$1" != public ) ]]; then
  printf 'Usage: %s private|public https://paperclip.example.com\n' "$0" >&2
  exit 2
fi
exposure=$1
origin=${2%/}
if [[ ! $origin =~ ^https://([A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])$ ]]; then
  printf 'Supply one HTTPS origin without a port, path, query, or fragment.\n' >&2
  exit 2
fi
hostname=${BASH_REMATCH[1]}
if [[ -e $env_file ]]; then
  printf 'Refusing to replace %s. Keep its values for database and login continuity.\n' "$env_file" >&2
  exit 1
fi
command -v openssl >/dev/null || { printf 'openssl is required to generate secrets.\n' >&2; exit 1; }

umask 077
cat > "$env_file" <<EOF
COMPOSE_PROJECT_NAME=intellipaperclip
PAPERCLIP_DEPLOYMENT_EXPOSURE=$exposure
PAPERCLIP_PUBLIC_URL=$origin
PAPERCLIP_HOSTNAME=$hostname
PAPERCLIP_INTERNAL_PORT=3102
PAPERCLIP_ZH_PORT=3100
POSTGRES_PASSWORD=$(openssl rand -hex 32)
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
PAPERCLIP_AGENT_JWT_SECRET=$(openssl rand -hex 32)
PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32)
EOF
printf 'Created %s with mode 0600. Keep it with your private backups.\n' "$env_file"

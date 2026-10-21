#!/usr/bin/env bash
set -euo pipefail

deploy_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
env_file="$deploy_dir/.env"
[[ -f $env_file ]] || { printf 'Missing deploy/.env.\n' >&2; exit 1; }
compose=(docker compose --env-file "$env_file" -f "$deploy_dir/compose.yaml")
[[ -n $("${compose[@]}" ps --status running -q paperclip) ]] || {
  printf 'Paperclip must be running before this backup.\n' >&2; exit 1;
}

umask 077
backup_dir="$deploy_dir/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$deploy_dir/backups"
mkdir "$backup_dir"
stopped=false
resume() {
  if [[ $stopped == true ]]; then
    "${compose[@]}" up -d --wait paperclip >/dev/null || printf 'Restart Paperclip manually: deploy/up.sh\n' >&2
  fi
}
trap resume EXIT

# Pause writes so the database dump and the file/secret snapshot describe one state.
"${compose[@]}" stop paperclip
stopped=true
"${compose[@]}" exec -T db pg_dump -U paperclip -d paperclip -Fc > "$backup_dir/database.dump"
docker run --rm --volume intellipaperclip-home:/source:ro alpine:3.21 \
  tar -C /source -czf - . > "$backup_dir/paperclip-home.tar.gz"
cp "$env_file" "$backup_dir/env.backup"
(
  cd "$backup_dir"
  sha256sum database.dump paperclip-home.tar.gz env.backup > SHA256SUMS
)
printf 'Backup saved in %s. Store this directory encrypted outside the server.\n' "$backup_dir"

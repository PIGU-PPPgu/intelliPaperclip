#!/usr/bin/env bash
set -euo pipefail

deploy_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ $# -ne 1 ]]; then
  printf 'Usage: %s /absolute/path/to/backup-directory\n' "$0" >&2
  exit 2
fi
backup_dir=$(cd "$1" && pwd)
env_file="$deploy_dir/.env"
[[ -f $env_file && -f $backup_dir/env.backup ]] || {
  printf 'Restore requires deploy/.env and the matching env.backup.\n' >&2; exit 1;
}
cmp -s "$env_file" "$backup_dir/env.backup" || {
  printf 'deploy/.env differs from env.backup. Use the backed-up values before restoring.\n' >&2; exit 1;
}
(cd "$backup_dir" && sha256sum -c SHA256SUMS)
compose=(docker compose --env-file "$env_file" -f "$deploy_dir/compose.yaml")
[[ -z $("${compose[@]}" ps --status running -q paperclip) ]] || {
  printf 'Stop Paperclip before restoring. This script will not overwrite a live instance.\n' >&2; exit 1;
}
"${compose[@]}" up -d --wait db
table_count=$("${compose[@]}" exec -T db psql -U paperclip -d paperclip -Atqc \
  "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")
[[ $table_count == 0 ]] || { printf 'Database is not empty; restore refused.\n' >&2; exit 1; }
docker volume create intellipaperclip-home >/dev/null
docker run --rm --volume intellipaperclip-home:/target:ro alpine:3.21 \
  sh -c 'test -z "$(ls -A /target)"' || { printf 'Paperclip home volume is not empty; restore refused.\n' >&2; exit 1; }

"${compose[@]}" exec -T db pg_restore --list < "$backup_dir/database.dump" >/dev/null
docker run --rm --volume "$backup_dir:/backup:ro" alpine:3.21 \
  tar -tzf /backup/paperclip-home.tar.gz >/dev/null

"${compose[@]}" exec -T db pg_restore -U paperclip -d paperclip --no-owner --no-acl --single-transaction \
  < "$backup_dir/database.dump"
docker run --rm --volume intellipaperclip-home:/target \
  --volume "$backup_dir:/backup:ro" alpine:3.21 \
  tar -C /target -xzf /backup/paperclip-home.tar.gz
printf 'Restore complete. Run deploy/up.sh, then verify login, tasks, files, plugins and agent paths.\n'

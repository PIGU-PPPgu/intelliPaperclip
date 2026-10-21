#!/usr/bin/env bash
set -euo pipefail

deploy_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
env_file="$deploy_dir/.env"
if [[ ! -f $env_file ]]; then
  printf 'Missing %s. Run deploy/init-env.sh first.\n' "$env_file" >&2
  exit 1
fi
if grep -q EXAMPLE_NOT_FOR_DEPLOYMENT "$env_file"; then
  printf 'Refusing example credentials. Run deploy/init-env.sh.\n' >&2
  exit 1
fi
exposure=$(sed -n 's/^PAPERCLIP_DEPLOYMENT_EXPOSURE=//p' "$env_file" | tail -n 1)
case $exposure in private|public) ;; *) printf 'Invalid deployment exposure.\n' >&2; exit 1 ;; esac

compose=(docker compose --env-file "$env_file" -f "$deploy_dir/compose.yaml")
if [[ $exposure == public ]]; then compose+=(--profile public); fi
"${compose[@]}" config -q
"${compose[@]}" up -d --build --wait
public_url=$(sed -n 's/^PAPERCLIP_PUBLIC_URL=//p' "$env_file" | tail -n 1)
printf 'Paperclip and PostgreSQL are healthy. Open %s\n' "$public_url"

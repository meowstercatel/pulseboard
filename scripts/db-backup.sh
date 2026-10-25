#!/usr/bin/env bash
# Takes a backup right now and prints its path on the host.
#   scripts/db-backup.sh [--project NAME]    (default: $COMPOSE_PROJECT_NAME or pulseboard)
# Uses plain docker so it works over ssh without POSTGRES_PASSWORD set.
set -euo pipefail

die() {
    echo "db-backup: $*" >&2
    exit 1
}

project=${COMPOSE_PROJECT_NAME:-pulseboard}
while [ $# -gt 0 ]; do
    case $1 in
    --project) project=${2:?--project needs a name} && shift 2 ;;
    --project=*) project=${1#*=} && shift ;;
    *) die "usage: $0 [--project NAME]" ;;
    esac
done

backup=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=backup)
[ -n "$backup" ] || die "no running backup container in project $project"

path=$(docker exec "$backup" pg-backup.sh manual)
host_dir=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/backups"}}{{.Source}}{{end}}{{end}}' "$backup")
echo "$host_dir${path#/backups}"

#!/usr/bin/env bash
# Replaces a compose project's database with a pg_dump -Fc file.
#   scripts/db-restore.sh <file> [--project NAME] [--yes] [--prod]
# Every project except pulseboard-staging counts as production and needs --prod.
# Uses plain docker so it works over ssh without POSTGRES_PASSWORD set.
set -euo pipefail

die() {
    echo "db-restore: $*" >&2
    exit 1
}
usage() { die "usage: $0 <file> [--project NAME] [--yes] [--prod]"; }

project=${COMPOSE_PROJECT_NAME:-pulseboard}
file=
yes=
prod=
while [ $# -gt 0 ]; do
    case $1 in
    --project) project=${2:?--project needs a name} && shift 2 ;;
    --project=*) project=${1#*=} && shift ;;
    --yes) yes=1 && shift ;;
    --prod) prod=1 && shift ;;
    -*) usage ;;
    *)
        [ -z "$file" ] || usage
        file=$1 && shift
        ;;
    esac
done
[ -n "$file" ] || usage
[ -f "$file" ] && [ -r "$file" ] || die "cannot read $file"

if [ "$project" != pulseboard-staging ] && [ -z "$prod" ]; then
    die "$project is treated as production, pass --prod to restore into it"
fi

find_container() {
    docker ps "${@:2}" --format '{{.Names}}' --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$1"
}
db=$(find_container db)
backup=$(find_container backup)
migrate=$(find_container migrate -a)
[ -n "$db" ] || die "no running db container in project $project"
[ -n "$backup" ] || die "no running backup container in project $project (needed for the safety backup)"
[ -n "$migrate" ] || die "no migrate container in project $project, deploy once first"

docker exec -i "$db" pg_restore --list <"$file" >/dev/null || die "$file is not a readable pg_dump -Fc file"

if [ -z "$yes" ]; then
    echo "This replaces the entire $project database with $file."
    read -r -p "Type the project name to continue: " answer
    [ "$answer" = "$project" ] || die "aborted"
fi

safety=$(docker exec "$backup" pg-backup.sh pre-restore)
safety=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/backups"}}{{.Source}}{{end}}{{end}}' "$backup")${safety#/backups}
echo "Safety backup: $safety"

# On failure the database may be empty, so leave the app stopped rather than serve it.
stopped=()
trap 'echo "db-restore: failed, ${stopped[*]:-nothing} left stopped. To roll back: $0 $safety --project $project --yes${prod:+ --prod}" >&2' ERR
for service in server pgweb; do
    container=$(find_container "$service")
    if [ -n "$container" ]; then
        docker stop "$container" >/dev/null
        stopped+=("$container")
    fi
done

echo "Restoring $file into $project..."
# local socket connections need no password in the postgres image
docker exec "$db" sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$POSTGRES_DB\""'
docker exec -i "$db" sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --single-transaction --exit-on-error' <"$file"

echo "Bringing the schema up to the Prisma contract..."
docker start -a "$migrate"

trap - ERR
for container in ${stopped[@]+"${stopped[@]}"}; do
    docker start "$container" >/dev/null
done
echo "Restore of $project finished."

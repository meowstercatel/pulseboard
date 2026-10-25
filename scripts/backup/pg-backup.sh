#!/bin/sh
# Usage: pg-backup.sh daily|manual|pre-restore
# Dumps the database into /backups/<kind>/ and prints the file's path.
# Only daily runs prune: 7 daily and 4 weekly (Sunday) dumps are kept.
set -eu
umask 077

kind=${1:-}
case $kind in
daily | manual | pre-restore) ;;
*)
    echo "usage: pg-backup.sh daily|manual|pre-restore" >&2
    exit 2
    ;;
esac

root=/backups
# hand everything to the owner of the host folder so it can be copied off without sudo
owner=$(stat -c %u:%g "$root")
dir=$root/$kind
mkdir -p "$dir"
chown "$owner" "$dir"

name=pulseboard-$(date -u +%Y-%m-%dT%H%MZ).dump
if [ -e "$dir/$name" ]; then
    name=pulseboard-$(date -u +%Y-%m-%dT%H%M%SZ).dump
fi
tmp=$dir/.$name.tmp
trap 'rm -f "$tmp"' EXIT

pg_dump -Fc -f "$tmp"
pg_restore --list "$tmp" >/dev/null
chown "$owner" "$tmp"
mv "$tmp" "$dir/$name"

prune() {
    [ -d "$1" ] || return 0
    find "$1" -maxdepth 1 -name 'pulseboard-*.dump' | sort -r | tail -n +$(($2 + 1)) | xargs -r rm -f
}

if [ "$kind" = daily ]; then
    if [ "${BACKUP_WEEKDAY:-$(date -u +%u)}" = 7 ]; then
        mkdir -p "$root/weekly"
        chown "$owner" "$root/weekly"
        ln -f "$dir/$name" "$root/weekly/$name"
    fi
    prune "$dir" 7
    prune "$root/weekly" 4
fi

echo "$dir/$name"

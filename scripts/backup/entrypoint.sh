#!/bin/sh
set -eu

# cron jobs don't inherit the container environment
(
    umask 077
    export -p | grep -E '^export (PATH|PG(HOST|PORT|USER|PASSWORD|DATABASE))=' >/etc/pg-backup.env
)
echo '0 3 * * * . /etc/pg-backup.env && /usr/local/bin/pg-backup.sh daily >/proc/1/fd/1 2>&1' >/etc/crontabs/root

if ! ls /backups/daily/pulseboard-*.dump >/dev/null 2>&1; then
    tries=0
    until pg_isready -q || [ "$tries" -ge 30 ]; do
        tries=$((tries + 1))
        sleep 2
    done
    pg-backup.sh daily || echo "initial backup failed, next attempt at 03:00 UTC" >&2
fi

exec crond -f -d 8

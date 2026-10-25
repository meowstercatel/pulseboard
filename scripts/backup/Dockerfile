# Same image as the db service so pg_dump always matches the server version.
FROM postgres:17-alpine

COPY entrypoint.sh pg-backup.sh /usr/local/bin/

HEALTHCHECK --interval=10m --start-period=5m \
    CMD find /backups/daily -name 'pulseboard-*.dump' -mmin -1560 | grep -q .

ENTRYPOINT ["entrypoint.sh"]

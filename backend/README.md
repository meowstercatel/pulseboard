```
npm install
npm run dev
```

```
open http://localhost:3000
```

## Backups & restore

The `backup` service runs `pg_dump -Fc` every day at 03:00 UTC (and once on first start). Dumps live on the host in `/var/backups/pulseboard/<compose project>/` (`BACKUP_DIR` overrides the base), so `pulseboard` and `pulseboard-staging` each have their own folder:

- `daily/` keeps the last 7 dumps, `weekly/` the last 4 Sunday dumps
- `manual/` and `pre-restore/` are never pruned, delete old ones by hand

The backups are on the same disk as the database, copy important ones off the server.

The scripts only need `docker`, so run them from your own clone of the repo on the server (the runner's checkout under `/home/runner` isn't readable by other users). They default to `$COMPOSE_PROJECT_NAME`, or `pulseboard` (production):

```
scripts/db-backup.sh --project pulseboard-staging    # take a backup now, e.g. before a risky migration
scripts/db-restore.sh <file> --project pulseboard-staging
scp italy:/var/backups/pulseboard/pulseboard/daily/pulseboard-2026-10-24T0300Z.dump .
```

`db-restore.sh` asks you to type the project name (skip with `--yes`) and refuses production without `--prod`. It takes a `pre-restore/` backup, stops `server` and `pgweb`, recreates the database from the dump, runs `migrate` and starts them again. If it fails, it leaves the app stopped and prints the command to roll back to the safety backup.

If `docker ps` shows the backup container as unhealthy, there has been no daily dump for over 26 hours, check `docker logs <project>-backup-1`.

# Sample data

Synthetic server metrics for trying out and testing CSV import. Every file has the columns PulseBoard imports:

```
timestamp,host,cpu_percent,ram_percent,disk_percent,net_in_mbps,net_out_mbps
2026-09-01T00:00:00Z,web-01,27.3,55.1,59.3,14.15,5.01
```

Timestamps are UTC, one reading every 15 minutes starting 2026-09-01. CPU and RAM peak in the afternoon and drop at weekends; disk usage grows slowly with a weekly cleanup, so capacity forecasts have a trend to find.

| File                         | Hosts | Days | What it covers                                                                               |
| ---------------------------- | ----- | ---- | -------------------------------------------------------------------------------------------- |
| `servers-30d.csv`            | 3     | 30   | Clean data, long enough for forecasts (14 days minimum)                                      |
| `excel-pl-7d.csv`            | 1     | 7    | Excel with Polish settings: `;` separator, decimal comma, BOM, CRLF. Too short for forecasts |
| `gaps-and-anomalies-14d.csv` | 2     | 14   | Missing readings and CPU, RAM and network spikes (listed below)                              |
| `invalid-3-percent.csv`      | 1     | 7    | 22 of 672 rows broken (3.3%): imports, with an error report                                  |
| `invalid-10-percent.csv`     | 1     | 7    | 59 of 672 rows broken (8.8%): over the 5% limit, rejected                                    |

`gaps-and-anomalies-14d.csv` contains:

- gaps: `web-01` 2026-09-04 09:00–15:00, `db-01` 2026-09-09 22:00 – 09-11 04:00
- spikes: `web-01` CPU 2026-09-03 14:00–16:00, `db-01` RAM 2026-09-06 03:00–04:00, `web-01` network 2026-09-11 19:00–22:00

The broken rows have a bad or impossible timestamp, an empty host, a non-numeric, empty, negative or over-100% value, or a missing or extra column.

## Regenerating

The files come from `scripts/generate-samples.mjs` and are reproducible: the same options and seed give the same bytes.

```sh
pnpm run samples                # rewrite every file above
pnpm run samples --help         # options for a custom file
```

Files for testing the size limits (25 MB, 500k rows) are too big to commit; generate them when needed:

```sh
pnpm run samples --days 365 --hosts 15 --out /tmp/too-big.csv   # 525,600 rows, 28 MB
```

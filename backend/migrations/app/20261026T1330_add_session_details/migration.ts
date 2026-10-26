#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/491b34cb2e0440598e17329e28ce57d484e36bf2cbbf5cf6e72741874b3bf1e3/contract';
import startContract from '../../snapshots/491b34cb2e0440598e17329e28ce57d484e36bf2cbbf5cf6e72741874b3bf1e3/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/de3e046d41aceb46c7e258e0bf5b0896bb99f4027b4d79f9a990484cbe8f2e61/contract';
import endContract from '../../snapshots/de3e046d41aceb46c7e258e0bf5b0896bb99f4027b4d79f9a990484cbe8f2e61/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'Session',
        column: col('ip', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Session',
        column: col('lastSeenAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-string@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Session',
        column: col('userAgent', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

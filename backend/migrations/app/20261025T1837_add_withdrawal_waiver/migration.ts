#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/491b34cb2e0440598e17329e28ce57d484e36bf2cbbf5cf6e72741874b3bf1e3/contract';
import endContract from '../../snapshots/491b34cb2e0440598e17329e28ce57d484e36bf2cbbf5cf6e72741874b3bf1e3/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/d7d041a2cacd34b2a9695ea8115b3b4fe1d1c4c75e90c1d8cd370a6ad66a7062/contract';
import startContract from '../../snapshots/d7d041a2cacd34b2a9695ea8115b3b4fe1d1c4c75e90c1d8cd370a6ad66a7062/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'User',
        column: col('withdrawalWaiverAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-string@1' },
        }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

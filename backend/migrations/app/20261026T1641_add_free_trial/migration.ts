#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/d1912bdc422b3741b6f42b4845428ea2d87bb3665e09b5f4b4e5653b04dfe5f1/contract';
import endContract from '../../snapshots/d1912bdc422b3741b6f42b4845428ea2d87bb3665e09b5f4b4e5653b04dfe5f1/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/de3e046d41aceb46c7e258e0bf5b0896bb99f4027b4d79f9a990484cbe8f2e61/contract';
import startContract from '../../snapshots/de3e046d41aceb46c7e258e0bf5b0896bb99f4027b4d79f9a990484cbe8f2e61/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      // Hand-edited: existing accounts get no trial, so the column is added
      // with false for every current row, and only then defaults to true for
      // accounts created from now on. The default is dropped in between
      // because setDefault is skipped when the column already has one.
      this.addColumn({
        schema: 'public',
        table: 'User',
        column: col('trialEligible', 'bool', {
          notNull: true,
          default: lit(false),
          codecRef: { codecId: 'pg/bool@1' },
        }),
      }),
      this.dropDefault({
        schema: 'public',
        table: 'User',
        column: 'trialEligible',
      }),
      this.setDefault({
        schema: 'public',
        table: 'User',
        column: col('trialEligible', 'bool', {
          notNull: true,
          default: lit(true),
          codecRef: { codecId: 'pg/bool@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'User',
        column: col('trialEndsAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-string@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'User',
        column: col('trialRemindersSent', 'int4', {
          notNull: true,
          default: lit(0),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

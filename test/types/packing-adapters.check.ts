/**
 * Compile-time rules for the packing adapters, checked by
 * `test/contract-types.test.ts`. The direction of each adapter, and the absence
 * of any sport-job accessor, exist only in the types, so they are asserted here.
 */

import type { PackingQueueReadAdapter, PackingWriteAdapter } from '../../src/index.js';

declare const read: PackingQueueReadAdapter;
declare const write: PackingWriteAdapter;

// The read side reads and subscribes.
export const queue = read.getQueue('2026-10-15');
export const invoices = read.getInvoices();
export const off = read.subscribe(() => {});

// The write side reports a dropzone-owned rig.
export const job = write.recordPackJob('RIG-1', 'tandem');
export const note = write.raiseNote('RIG-1', 'Slider grommet has a rough edge.');

// @ts-expect-error the write adapter cannot report a sport rig: that work stays off DZGO (DZM-Q-042).
export const sportJob = write.recordPackJob('RIG-1', 'sport');

// @ts-expect-error the read adapter cannot write.
export const readWrites = read.recordPackJob('RIG-1', 'tandem');

// @ts-expect-error the write adapter cannot read the queue.
export const writeReads = write.getQueue('2026-10-15');

// @ts-expect-error the sport-rig job list is on neither adapter (PAK-Q-003 stays Kyle's call).
export const sportOnRead = read.getSportJobs();

// @ts-expect-error nor on the write adapter.
export const sportOnWrite = write.getSportJobs();

// @ts-expect-error neither adapter lists pack jobs, which would include sport jobs.
export const jobsOnRead = read.getPackJobs('2026-10-15');

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';

void test('delivery deduplication survives restart and rolls back a failed handler', (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-deliveries-'));
    const path = join(directory, 'state.sqlite');
    let store = new Store(path);
    t.after(() => {
        store.close();
        rmSync(directory, { recursive: true, force: true });
    });
    let handled = 0;
    const handle = (): void => {
        handled += 1;
    };
    store.processDelivery('first', handle, 1000);
    store.close();
    store = new Store(path);
    store.processDelivery('first', handle, 2000);
    assert.equal(handled, 1);

    assert.throws(
        () =>
            store.processDelivery(
                'retry',
                () => {
                    throw new Error('interrupted');
                },
                3000,
            ),
        /interrupted/u,
    );
    store.processDelivery('retry', handle, 4000);
    assert.equal(handled, 2);
});

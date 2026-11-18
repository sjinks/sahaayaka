import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { Engine } from '../src/engine.js';
import type { Gateway, Pull } from '../src/github.js';
import { type Policy, policySchema } from '../src/policy.js';
import { Store } from '../src/store.js';
import type { Snapshot, Target } from '../src/types.js';

function target(): Target {
    return {
        key: '1:2',
        owner: 'owner',
        repo: 'repo',
        repositoryId: 1,
        installationId: 2,
        pullNumber: 3,
        headSha: 'head',
        baseSha: 'base',
        mergeSha: null,
        draft: false,
        startedAt: 0,
        activityAt: 0,
        generation: 0,
        checkId: null,
        reviewId: null,
        signature: null,
        snapshotHash: null,
        closed: false,
    };
}

function fixture(t: TestContext): { store: Store; path: string; close: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'sahaayaka-test-'));
    const path = join(dir, 'state.sqlite');
    const store = new Store(path);
    let closed = false;
    const close = (): void => {
        if (!closed) {
            store.close();
            closed = true;
        }
    };
    t.after(() => {
        close();
        rmSync(dir, { recursive: true, force: true });
    });
    store.put(target());
    return { store, path, close };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let complete!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        complete = resolve;
    });
    return { promise, resolve: complete };
}

function fakeGateway(): {
    calls: string[];
    gateway: Gateway;
    setPull: (value: Partial<Pull>) => void;
    setPolicy: (value: Record<string, unknown>) => void;
    setSnapshot: (value: Snapshot) => void;
} {
    const calls: string[] = [];
    let pull: Pull = { headSha: 'head', baseSha: 'base', mergeSha: null, draft: false, closed: false, changedFiles: 1 };
    let policy: Policy = policySchema.parse({ settleSeconds: 10 });
    let snapshot: Snapshot = {
        checks: [{ key: 'head:build', name: 'build', appId: 1, status: 'completed', conclusion: 'success', url: '' }],
        files: ['src/index.ts'],
    };
    const gateway: Gateway = {
        pull() {
            calls.push('pull');
            return Promise.resolve({ ...pull });
        },
        policy() {
            calls.push('policy');
            return Promise.resolve(policy);
        },
        snapshot() {
            calls.push('snapshot');
            return Promise.resolve(snapshot);
        },
        create() {
            calls.push('create');
            return Promise.resolve(10);
        },
        publish(target, state) {
            calls.push(`publish:${state}`);
            assert.ok(target.checkId !== null);
            return Promise.resolve(target.checkId);
        },
        cancelPendingChecks() {
            calls.push('cancelPendingChecks');
            return Promise.resolve();
        },
        approve() {
            calls.push('approve');
            return Promise.resolve(20);
        },
        dismiss() {
            calls.push('dismiss');
            return Promise.resolve();
        },
    };
    return {
        calls,
        gateway,
        setPull(value: Partial<Pull>): void {
            pull = { ...pull, ...value };
        },
        setPolicy(value: Record<string, unknown>): void {
            policy = policySchema.parse({ settleSeconds: 10, ...value });
        },
        setSnapshot(value: Snapshot): void {
            snapshot = value;
        },
    };
}

void test('closed targets retry check cancellation and finalize only after it succeeds', async (t) => {
    const { store } = fixture(t);
    const engine = new Engine(store);
    const { gateway, setPull, calls } = fakeGateway();
    store.put({ ...target(), closed: true, checkId: 10 });
    setPull({ closed: true });
    const error = new Error('Check cancellation failed');
    t.mock.method(gateway, 'cancelPendingChecks', () => Promise.reject(error), { times: 1 });

    await assert.rejects(engine.reconcile('1:2', gateway), error);
    assert.equal(store.get('1:2')?.closedChecksFinalized, undefined);
    await engine.reconcile('1:2', gateway);
    assert.equal(store.get('1:2')?.closedChecksFinalized, true);
    await engine.reconcile('1:2', gateway);
    assert.deepEqual(calls, ['pull', 'pull', 'cancelPendingChecks']);
});

void test('reopening a pull request invalidates an in-flight cancellation', async (t) => {
    const { store } = fixture(t);
    const engine = new Engine(store);
    const { gateway, setPull } = fakeGateway();
    const cancellation = deferred<() => boolean>();
    const resume = deferred<undefined>();
    setPull({ closed: true });
    t.mock.method(gateway, 'cancelPendingChecks', async (_target: Target, stillClosed: () => boolean) => {
        cancellation.resolve(stillClosed);
        await resume.promise;
        assert.equal(stillClosed(), false);
    });

    const reconcile = engine.reconcile('1:2', gateway);
    const stillClosed = await cancellation.promise;
    assert.equal(stillClosed(), true);
    engine.invalidate('1:2');
    resume.resolve(undefined);
    await reconcile;
    assert.equal(store.get('1:2')?.closed, false);
    assert.equal(store.get('1:2')?.closedChecksFinalized, false);
});

void test('generation invalidation during an awaited snapshot suppresses stale success', async (t) => {
    const { store } = fixture(t);
    let now = 20_000;
    const engine = new Engine(store, () => now);
    const fake = fakeGateway();
    const held = deferred<Snapshot>();
    const entered = deferred<undefined>();
    const gateway = {
        ...fake.gateway,
        snapshot(): Promise<Snapshot> {
            entered.resolve(undefined);
            return held.promise;
        },
    };
    const running = engine.reconcile('1:2', gateway);
    await entered.promise;
    engine.invalidate('1:2');
    held.resolve({
        checks: [{ key: 'head:build', name: 'build', appId: 1, status: 'completed', conclusion: 'success', url: '' }],
        files: ['src/index.ts'],
    });
    await running;
    assert.deepEqual(
        fake.calls.filter((call) => call.startsWith('publish:')),
        ['publish:pending'],
    );
    assert.equal(store.get('1:2')?.generation, 1);
    assert.equal(store.get('1:2')?.signature, null);
    now += 11_000;
    await engine.reconcile('1:2', fake.gateway);
    assert.equal(fake.calls.filter((call) => call === 'publish:success').length, 0);
    now += 11_000;
    await engine.reconcile('1:2', fake.gateway);
    assert.equal(fake.calls.filter((call) => call === 'publish:success').length, 1);
});

for (const scope of ['repository', 'installation'] as const) {
    void test(`${scope} retirement during a snapshot stops publication and approval`, async (t) => {
        const { store } = fixture(t);
        const engine = new Engine(store, () => 20_000);
        const fake = fakeGateway();
        fake.setPolicy({ approve: true });
        const held = deferred<Snapshot>();
        const entered = deferred<undefined>();
        const gateway: Gateway = {
            ...fake.gateway,
            snapshot(): Promise<Snapshot> {
                entered.resolve(undefined);
                return held.promise;
            },
        };
        const running = engine.reconcile('1:2', gateway);
        await entered.promise;
        if (scope === 'repository') {
            store.retireRepository(2, 1);
        } else {
            store.retireInstallation(2);
        }
        assert.equal(store.get('1:2')?.generation, 1);
        assert.equal(store.get('1:2')?.closed, true);
        assert.equal(store.canAccess(2, 1), false);
        held.resolve({
            checks: [
                { key: 'head:build', name: 'build', appId: 1, status: 'completed', conclusion: 'success', url: '' },
            ],
            files: ['src/index.ts'],
        });
        await running;
        assert.equal(fake.calls.includes('publish:success'), false);
        assert.equal(fake.calls.includes('approve'), false);
        const callsAfterRetirement = fake.calls.length;
        await engine.reconcile('1:2', fake.gateway);
        assert.equal(fake.calls.length, callsAfterRetirement);
    });
}

void test('a denied access record prevents API calls and remains denied after restart', async (t) => {
    const { store, path, close } = fixture(t);
    const fake = fakeGateway();
    store.retireRepository(2, 1);
    await new Engine(store, () => 20_000).reconcile('1:2', fake.gateway);
    assert.deepEqual(fake.calls, []);
    close();
    const reopened = new Store(path);
    t.after(() => reopened.close());
    assert.equal(reopened.canAccess(2, 1), false);
    assert.equal(reopened.get('1:2')?.closed, true);
    await new Engine(reopened, () => 20_000).reconcile('1:2', fake.gateway);
    assert.deepEqual(fake.calls, []);
});

void test('a revision change during evaluation cannot publish success for the old head', async (t) => {
    const { store } = fixture(t);
    const engine = new Engine(store, () => 20_000);
    const fake = fakeGateway();
    let reads = 0;
    const gateway = {
        ...fake.gateway,
        pull(): Promise<Pull> {
            reads += 1;
            return Promise.resolve({
                headSha: reads === 1 ? 'head' : 'new-head',
                baseSha: 'base',
                mergeSha: null,
                draft: false,
                closed: false,
                changedFiles: 1,
            });
        },
    };
    await engine.reconcile('1:2', gateway);
    assert.equal(reads, 2);
    assert.equal(fake.calls.filter((call) => call === 'publish:success').length, 0);
    assert.equal(store.get('1:2')?.headSha, 'head');
});

void test('a review returned after invalidation is retained so the next pass can dismiss it', async (t) => {
    const { store } = fixture(t);
    let now = 20_000;
    const engine = new Engine(store, () => now);
    const fake = fakeGateway();
    fake.setPolicy({ approve: true });
    await engine.reconcile('1:2', fake.gateway);
    now += 11_000;
    const entered = deferred<undefined>();
    const held = deferred<number>();
    const gateway = {
        ...fake.gateway,
        approve(): Promise<number> {
            entered.resolve(undefined);
            return held.promise;
        },
    };
    const running = engine.reconcile('1:2', gateway);
    await entered.promise;
    engine.invalidate('1:2');
    held.resolve(33);
    await running;
    assert.equal(store.get('1:2')?.reviewId, 33);
    const dismissesBeforeRecovery = fake.calls.filter((call) => call === 'dismiss').length;
    await engine.reconcile('1:2', fake.gateway);
    assert.ok(fake.calls.filter((call) => call === 'dismiss').length > dismissesBeforeRecovery);
    assert.equal(store.get('1:2')?.reviewId, null);
});

void test('invalidating a terminal gate republishes pending and resets its timeout clock', async (t) => {
    const { store } = fixture(t);
    let now = 20_000;
    const engine = new Engine(store, () => now);
    const fake = fakeGateway();
    await engine.reconcile('1:2', fake.gateway);
    now += 11_000;
    await engine.reconcile('1:2', fake.gateway);
    assert.equal(
        store.get('1:2')?.signature,
        JSON.stringify({ state: 'success', summary: 'All 1 current checks passed.\nbuild: success' }),
    );
    engine.invalidate('1:2');
    const invalidated = store.get('1:2');
    assert.equal(invalidated?.signature, null);
    assert.equal(invalidated.startedAt, now);
    await engine.reconcile('1:2', fake.gateway);
    assert.equal(fake.calls.at(-1), 'publish:pending');
    assert.equal(fake.calls.filter((call) => call === 'publish:pending').length, 4);
    assert.equal(fake.calls.filter((call) => call === 'publish:success').length, 1);
});

void test('an invalidated pending publish cannot persist its returned check ID', async (t) => {
    const { store } = fixture(t);
    let now = 20_000;
    const engine = new Engine(store, () => now);
    const fake = fakeGateway();
    await engine.reconcile('1:2', fake.gateway);
    now += 11_000;
    await engine.reconcile('1:2', fake.gateway);
    assert.equal(store.get('1:2')?.checkId, 10);
    engine.invalidate('1:2');
    const entered = deferred<undefined>();
    const held = deferred<number>();
    const gateway: Gateway = {
        ...fake.gateway,
        publish(target, state, summary): Promise<number> {
            if (state === 'pending') {
                entered.resolve(undefined);
                return held.promise;
            }
            return fake.gateway.publish(target, state, summary);
        },
    };
    const running = engine.reconcile('1:2', gateway);
    await entered.promise;
    engine.invalidate('1:2');
    held.resolve(11);
    await running;
    assert.equal(store.get('1:2')?.checkId, 10);
    assert.equal(store.get('1:2')?.signature, null);
});

void test('review is opt-in and is dismissed for draft, failed, or opted-out gates', async (t) => {
    const { store } = fixture(t);
    let now = 20_000;
    const engine = new Engine(store, () => now);
    const fake = fakeGateway();
    const approve = t.mock.method(fake.gateway, 'approve');
    await engine.reconcile('1:2', fake.gateway);
    now += 11_000;
    await engine.reconcile('1:2', fake.gateway);
    assert.equal(fake.calls.includes('approve'), false);
    fake.setPolicy({ approve: true });
    await engine.reconcile('1:2', fake.gateway);
    assert.equal(store.get('1:2')?.reviewId, 20);
    assert.equal(approve.mock.calls[0]?.arguments[1], true);
    let dismisses = fake.calls.filter((call) => call === 'dismiss').length;
    fake.setPull({ draft: true });
    await engine.reconcile('1:2', fake.gateway);
    assert.equal(store.get('1:2')?.reviewId, null);
    assert.ok(fake.calls.filter((call) => call === 'dismiss').length > dismisses);
    fake.setPull({ draft: false });
    fake.setPolicy({ approve: true, commentOnApproval: false });
    await engine.reconcile('1:2', fake.gateway);
    assert.equal(fake.calls.filter((call) => call === 'approve').length, 2);
    assert.equal(approve.mock.calls[1]?.arguments[1], false);
    fake.setSnapshot({
        checks: [{ key: 'head:build', name: 'build', appId: 1, status: 'completed', conclusion: 'failure', url: '' }],
        files: ['src/index.ts'],
    });
    dismisses = fake.calls.filter((call) => call === 'dismiss').length;
    await engine.reconcile('1:2', fake.gateway);
    assert.equal(store.get('1:2')?.reviewId, null);
    assert.ok(fake.calls.filter((call) => call === 'dismiss').length > dismisses);
    fake.setSnapshot({
        checks: [{ key: 'head:build', name: 'build', appId: 1, status: 'completed', conclusion: 'success', url: '' }],
        files: ['src/index.ts'],
    });
    now += 11_000;
    await engine.reconcile('1:2', fake.gateway);
    now += 11_000;
    await engine.reconcile('1:2', fake.gateway);
    assert.equal(store.get('1:2')?.reviewId, 20);
    dismisses = fake.calls.filter((call) => call === 'dismiss').length;
    fake.setPolicy({ approve: false });
    await engine.reconcile('1:2', fake.gateway);
    assert.equal(store.get('1:2')?.reviewId, null);
    assert.ok(fake.calls.filter((call) => call === 'dismiss').length > dismisses);
});

void test('an evaluation error revokes an existing approval while publishing failure', async (t) => {
    const { store } = fixture(t);
    let now = 20_000;
    const engine = new Engine(store, () => now);
    const fake = fakeGateway();
    fake.setPolicy({ approve: true });
    await engine.reconcile('1:2', fake.gateway);
    now += 11_000;
    await engine.reconcile('1:2', fake.gateway);
    assert.equal(store.get('1:2')?.reviewId, 20);
    const failing = {
        ...fake.gateway,
        policy: (): Promise<Policy> => Promise.reject(new Error('Policy API unavailable')),
    };
    const dismisses = fake.calls.filter((call) => call === 'dismiss').length;
    await assert.rejects(engine.reconcile('1:2', failing), /Policy API unavailable/u);
    assert.ok(fake.calls.includes('publish:failure'));
    assert.ok(fake.calls.filter((call) => call === 'dismiss').length > dismisses);
    assert.equal(store.get('1:2')?.reviewId, null);
});

void test('an evaluation error checks for an unrecorded remote approval', async (t) => {
    const { store } = fixture(t);
    let now = 20_000;
    const engine = new Engine(store, () => now);
    const fake = fakeGateway();
    fake.setPolicy({ approve: true });
    await engine.reconcile('1:2', fake.gateway);
    now += 11_000;
    await engine.reconcile('1:2', fake.gateway);
    const approved = store.get('1:2');
    assert.ok(approved);
    store.put({ ...approved, reviewId: null });
    const failing = {
        ...fake.gateway,
        policy: (): Promise<Policy> => Promise.reject(new Error('Policy API unavailable')),
    };
    const dismisses = fake.calls.filter((call) => call === 'dismiss').length;
    await assert.rejects(engine.reconcile('1:2', failing), /Policy API unavailable/u);
    assert.ok(fake.calls.filter((call) => call === 'dismiss').length > dismisses);
});

void test('state survives store restart without creating another aggregate check', async (t) => {
    const { store, path, close } = fixture(t);
    let now = 20_000;
    const fake = fakeGateway();
    await new Engine(store, () => now).reconcile('1:2', fake.gateway);
    now += 11_000;
    await new Engine(store, () => now).reconcile('1:2', fake.gateway);
    const saved = store.get('1:2');
    close();
    const restarted = new Store(path);
    t.after(() => restarted.close());
    assert.deepEqual(restarted.get('1:2'), saved);
    await new Engine(restarted, () => now).reconcile('1:2', fake.gateway);
    assert.equal(fake.calls.filter((call) => call === 'create').length, 1);
    assert.equal(fake.calls.filter((call) => call === 'publish:success').length, 1);
});

void test('an exclusive SQLite lock rejects a second process until the owner closes', (t) => {
    const { path, close } = fixture(t);
    const storeUrl = pathToFileURL(join(process.cwd(), 'src/store.ts')).href;
    const script = `import { Store } from ${JSON.stringify(storeUrl)}; const store = new Store(process.argv[1]); store.close();`;
    const attempt = (): SpawnSyncReturns<string> =>
        spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, path], {
            cwd: process.cwd(),
            encoding: 'utf8',
            timeout: 5_000,
        });
    const blocked = attempt();
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /SQLITE_BUSY|database is locked/iu);
    close();
    const recovered = attempt();
    assert.equal(recovered.status, 0, recovered.stderr);
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Probot, ProbotOctokit } from 'probot';
import { register } from '../src/app.js';
import { Store } from '../src/store.js';

interface Call {
    path: string;
    method: string;
    body: Record<string, unknown> | null;
    query: URLSearchParams;
}

interface RemoteCheck {
    id: number;
    name: string;
    app: { id: number };
    external_id: string;
    status: 'in_progress' | 'completed';
    conclusion: string | null;
}

void test('webhooks and polling keep the aggregate check current across reopen', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
    const dir = mkdtempSync(join(tmpdir(), 'sahaayaka-app-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Store(join(dir, 'state.sqlite'));
    let pullState = 'open';
    let baseSha = 'base';
    let status: 'absent' | 'pending' | 'success' | 'failure' = 'absent';
    const checkRuns = new Map<number, RemoteCheck>();
    let nextCheckId = 10;
    const calls: Call[] = [];
    const unexpected: string[] = [];
    const readDiscovery = (call: Call): unknown => {
        if (call.path === '/app/installations') {
            return [{ id: 3, suspended_at: null }];
        }
        if (call.path === '/installation/repositories') {
            return {
                total_count: 1,
                repositories: [{ id: 1, name: 'repo', full_name: 'owner/repo', owner: { login: 'owner' } }],
            };
        }
        if (call.path === '/repos/owner/repo/pulls') {
            return pullState === 'open'
                ? [{ number: 2, head: { sha: 'head' }, base: { sha: 'base' }, merge_commit_sha: null, draft: false }]
                : [];
        }
        return undefined;
    };
    const read = (call: Call): unknown => {
        const discovery = readDiscovery(call);
        if (discovery !== undefined) {
            return discovery;
        }
        if (call.path.endsWith('/pulls/2')) {
            return {
                head: { sha: 'head' },
                base: { sha: 'base', ref: 'main' },
                merge_commit_sha: null,
                draft: false,
                state: pullState,
                changed_files: 1,
            };
        }
        if (decodeURIComponent(call.path) === '/repos/owner/repo/contents/.github/sahaayaka.json') {
            return {
                type: 'file',
                encoding: 'base64',
                content: Buffer.from('{"settleSeconds":10}').toString('base64'),
            };
        }
        if (call.path.endsWith('/branches/main')) {
            return { commit: { sha: baseSha } };
        }
        if (call.path.endsWith('/pulls/2/files')) {
            return [{ filename: 'src/main.ts' }];
        }
        if (call.path.endsWith('/actions/runs')) {
            return { total_count: 0, workflow_runs: [] };
        }
        const checkId = /^\/repos\/owner\/repo\/check-runs\/(\d+)$/u.exec(call.path)?.[1];
        if (checkId) {
            return checkRuns.get(Number(checkId));
        }
        if (call.path.endsWith('/check-runs')) {
            const runs = [...checkRuns.values()].toReversed();
            return { total_count: runs.length, check_runs: runs };
        }
        if (call.path.endsWith('/statuses')) {
            return status === 'absent' ? [] : [{ id: 20, context: 'ci', state: status }];
        }
        if (call.path.endsWith('/pulls/2/reviews')) {
            return [];
        }
        if (call.path === '/app') {
            return { slug: 'sahaayaka' };
        }
        return undefined;
    };
    const write = (call: Call): unknown => {
        if (call.path.endsWith('/check-runs') && call.method === 'POST') {
            const run: RemoteCheck = {
                id: nextCheckId++,
                name: String(call.body?.name),
                app: { id: 42 },
                external_id: String(call.body?.external_id),
                status: 'in_progress',
                conclusion: null,
            };
            checkRuns.set(run.id, run);
            return run;
        }
        const checkId = /^\/repos\/owner\/repo\/check-runs\/(\d+)$/u.exec(call.path)?.[1];
        if (checkId && call.method === 'PATCH') {
            const run = checkRuns.get(Number(checkId));
            assert.ok(run);
            if (call.body?.conclusion === null || call.body?.completed_at === null) {
                unexpected.push('GitHub rejects null conclusion or completed_at');
                throw new Error('GitHub rejects null conclusion or completed_at');
            }
            // GitHub does not reset a completed check by PATCHing in_progress.
            if (run.status !== 'completed') {
                run.status = call.body?.status === 'completed' ? 'completed' : 'in_progress';
                run.conclusion = typeof call.body?.conclusion === 'string' ? call.body.conclusion : null;
            }
            return run;
        }
        return undefined;
    };
    const fetch: typeof globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
        const call = { path: url.pathname, method: init?.method ?? 'GET', body, query: url.searchParams };
        calls.push(call);
        if (
            call.method === 'GET' &&
            decodeURIComponent(call.path) === '/repos/owner/.github/contents/.github/sahaayaka.json'
        ) {
            assert.equal(call.query.has('ref'), false);
            const response = new Response(null, { status: 404 });
            Object.defineProperty(response, 'url', { value: url.href });
            return Promise.resolve(response);
        }
        const data = call.method === 'GET' ? read(call) : write(call);
        if (data === undefined) {
            unexpected.push(`${call.method} ${call.path}`);
            throw new Error(`Unexpected GitHub request: ${call.method} ${call.path}`);
        }
        const response = new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
        Object.defineProperty(response, 'url', { value: url.href });
        return Promise.resolve(response);
    };
    const app = new Probot({
        githubToken: 'test',
        Octokit: ProbotOctokit.defaults({ request: { fetch }, throttle: { enabled: false } }),
        logLevel: 'silent',
    });
    await app.ready();
    const runtime = register(app, store, 42, 10_000, new Set(['owner/repo']));
    t.after(() => runtime.stop());
    const repository = { id: 1, name: 'repo', owner: { login: 'owner' } };
    const installation = { id: 3 };
    const pullRequest = {
        number: 2,
        head: { sha: 'head' },
        base: { sha: 'base' },
        merge_commit_sha: null,
        draft: false,
    };
    let deliveries = 0;
    const receive = async (
        name: string,
        action: string,
        payload: Record<string, unknown>,
        id?: string,
    ): Promise<string> => {
        const deliveryId = id ?? `delivery-${++deliveries}`;
        await app.receive({
            id: deliveryId,
            name,
            payload: { action, repository, installation, ...payload },
        } as Parameters<Probot['receive']>[0]);
        await runtime.drain();
        return deliveryId;
    };
    const published = (): string[] =>
        calls
            .filter((call) => /\/check-runs\/\d+$/u.test(call.path) && call.method === 'PATCH')
            .map((call) => String(call.body?.conclusion ?? call.body?.status));
    const newestCheck = (): RemoteCheck => {
        const run = [...checkRuns.values()].at(-1);
        assert.ok(run);
        return run;
    };

    const openedId = await receive('pull_request', 'opened', { pull_request: pullRequest });
    assert.equal(store.get('1:2')?.checkId, 10);
    assert.equal(store.get('1:2')?.closed, false);
    assert.equal(published().includes('success'), false);
    assert.equal(published().at(-1), 'in_progress');
    const openedGeneration = store.get('1:2')?.generation;
    const openedCalls = calls.length;
    await receive('pull_request', 'opened', { pull_request: pullRequest }, openedId);
    assert.equal(store.get('1:2')?.generation, openedGeneration);
    assert.equal(calls.length, openedCalls);
    await receive('pull_request', 'opened', {
        pull_request: pullRequest,
        repository: { id: 99, name: 'other', owner: { login: 'owner' } },
    });
    assert.equal(store.get('99:2'), undefined);
    assert.equal(calls.length, openedCalls);

    status = 'success';
    t.mock.timers.tick(11_000);
    await runtime.drain();
    assert.equal(published().at(-1), 'in_progress');
    t.mock.timers.tick(11_000);
    await runtime.drain();
    assert.equal(published().at(-1), 'success');
    assert.equal(newestCheck().id, 10);
    assert.equal(newestCheck().status, 'completed');
    assert.equal(newestCheck().conclusion, 'success');

    const generation = store.get('1:2')?.generation;
    const requestCount = calls.length;
    await receive('check_run', 'completed', { check_run: { head_sha: 'head', app: { id: 42 } } });
    assert.equal(store.get('1:2')?.generation, generation);
    assert.equal(calls.length, requestCount);

    status = 'pending';
    await receive('workflow_run', 'in_progress', { workflow_run: { head_sha: 'head' } });
    assert.equal(published().at(-1), 'in_progress');
    assert.equal(newestCheck().id, 11);
    assert.equal(newestCheck().status, 'in_progress');
    assert.equal(newestCheck().conclusion, null);
    assert.equal(store.get('1:2')?.checkId, 11);
    assert.equal(checkRuns.get(10)?.conclusion, 'success');
    const pendingTarget = store.get('1:2');
    assert.ok(pendingTarget);
    store.put({ ...pendingTarget, checkId: 10 });
    await receive('workflow_run', 'in_progress', { workflow_run: { head_sha: 'head' } });
    assert.equal(store.get('1:2')?.checkId, 11);
    assert.equal(checkRuns.size, 2);
    status = 'failure';
    await receive('workflow_run', 'completed', { workflow_run: { head_sha: 'head' } });
    assert.equal(published().at(-1), 'failure');
    assert.equal(newestCheck().id, 11);
    assert.equal(newestCheck().conclusion, 'failure');

    status = 'pending';
    baseSha = 'advanced-base';
    t.mock.timers.tick(10_000);
    await runtime.drain();
    assert.equal(newestCheck().id, 12);
    assert.equal(newestCheck().status, 'in_progress');
    assert.equal(newestCheck().external_id, '1:2:head:advanced-base');

    pullState = 'closed';
    await receive('pull_request', 'closed', { pull_request: pullRequest });
    assert.equal(store.get('1:2')?.closed, true);
    assert.equal(store.get('1:2')?.closedChecksFinalized, true);
    assert.equal(newestCheck().conclusion, 'cancelled');
    assert.equal(checkRuns.get(10)?.conclusion, 'success');
    assert.equal(checkRuns.get(11)?.conclusion, 'failure');

    pullState = 'open';
    status = 'failure';
    await receive('pull_request', 'reopened', { pull_request: pullRequest });
    assert.equal(store.get('1:2')?.closed, false);
    assert.equal(published().at(-1), 'failure');
    assert.equal(newestCheck().id, 13);
    assert.equal(store.get('1:2')?.checkId, 13);
    assert.deepEqual(unexpected, []);
});

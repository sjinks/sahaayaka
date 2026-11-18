import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProbotOctokit } from 'probot';
import { GitHub } from '../src/github.js';
import { evaluate, policySchema } from '../src/policy.js';
import type { Target } from '../src/types.js';

const target: Target = {
    key: '1:2',
    owner: 'owner',
    repo: 'repo',
    repositoryId: 1,
    installationId: 3,
    pullNumber: 2,
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
const pull = { headSha: 'head', baseSha: 'base', mergeSha: null, draft: false, closed: false, changedFiles: 1 };

interface Call {
    path: string;
    method: string;
    body: unknown;
    query: URLSearchParams;
}

function client(handler: (call: Call) => unknown): ProbotOctokit {
    const fetch: typeof globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        const response = handler({ path: url.pathname, method: init?.method ?? 'GET', body, query: url.searchParams });
        const result = new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
        Object.defineProperty(result, 'url', { value: url.href });
        return Promise.resolve(result);
    };
    return new ProbotOctokit({ auth: 'test', request: { fetch } });
}

function workflow(id: number, number: number, conclusion: string, attempt = 1): Record<string, unknown> {
    return {
        id,
        run_number: number,
        run_attempt: attempt,
        workflow_id: 9,
        event: 'pull_request',
        head_repository: { id: 1 },
        head_branch: 'feature',
        name: 'CI',
        path: '.github/workflows/ci.yml',
        check_suite_id: id * 10,
        status: 'completed',
        conclusion,
        html_url: `https://example.test/runs/${id}`,
    };
}

void test('newer workflow failure wins over a slower older success, independent of response ordering', async () => {
    const requests: Call[] = [];
    const github = new GitHub(
        client((call) => {
            requests.push(call);
            if (call.path.endsWith('/files')) {
                return [{ filename: 'src/main.ts' }];
            }
            if (call.path.endsWith('/actions/runs')) {
                return { total_count: 2, workflow_runs: [workflow(20, 2, 'failure'), workflow(10, 1, 'success')] };
            }
            if (call.path.endsWith('/check-runs')) {
                return {
                    total_count: 2,
                    check_runs: [
                        {
                            id: 100,
                            name: 'test',
                            app: { id: 15368, slug: 'github-actions' },
                            check_suite: { id: 100 },
                            status: 'completed',
                            conclusion: 'success',
                        },
                        {
                            id: 200,
                            name: 'test',
                            app: { id: 15368, slug: 'github-actions' },
                            check_suite: { id: 200 },
                            status: 'completed',
                            conclusion: 'failure',
                        },
                    ],
                };
            }
            if (call.path.endsWith('/runs/20/jobs')) {
                assert.equal(call.query.get('filter'), 'latest');
                return {
                    total_count: 1,
                    jobs: [{ id: 200, name: 'test', status: 'completed', conclusion: 'failure' }],
                };
            }
            if (call.path.endsWith('/statuses')) {
                return [];
            }
            throw new Error(`Unexpected request: ${call.path}`);
        }),
        42,
    );
    const snapshot = await github.snapshot(target, pull);
    assert.equal(evaluate(snapshot, policySchema.parse({}), 0, 0, 60000).state, 'failure');
    assert.equal(snapshot.checks.find((check) => check.name === 'test')?.appId, 15368);
    assert.equal(
        requests.some((call) => call.path.endsWith('/runs/10/jobs')),
        false,
    );
});

void test('an in-progress rerun blocks even when latest jobs still contain old successes', async () => {
    const github = new GitHub(
        client((call) => {
            if (call.path.endsWith('/files')) {
                return [{ filename: 'README.md' }];
            }
            if (call.path.endsWith('/actions/runs')) {
                return {
                    total_count: 1,
                    workflow_runs: [{ ...workflow(20, 2, 'success', 2), status: 'in_progress', conclusion: null }],
                };
            }
            if (call.path.endsWith('/jobs')) {
                return {
                    total_count: 1,
                    jobs: [{ id: 200, name: 'test', status: 'completed', conclusion: 'success' }],
                };
            }
            if (call.path.endsWith('/check-runs')) {
                return { total_count: 0, check_runs: [] };
            }
            if (call.path.endsWith('/statuses')) {
                return [];
            }
            throw new Error(`Unexpected request: ${call.path}`);
        }),
        42,
    );
    const snapshot = await github.snapshot(target, pull);
    assert.equal(evaluate(snapshot, policySchema.parse({}), 0, 0, 60000).state, 'pending');
});

void test('external check and status selection ignores older completions and the app itself', async () => {
    const github = new GitHub(
        client((call) => {
            if (call.path.endsWith('/files')) {
                return [{ filename: 'README.md' }];
            }
            if (call.path.endsWith('/actions/runs')) {
                return { total_count: 0, workflow_runs: [] };
            }
            if (call.path.endsWith('/check-runs')) {
                return {
                    total_count: 3,
                    check_runs: [
                        { id: 20, name: 'external', app: { id: 8 }, status: 'completed', conclusion: 'failure' },
                        { id: 10, name: 'external', app: { id: 8 }, status: 'completed', conclusion: 'success' },
                        { id: 30, name: 'Sahaayaka', app: { id: 42 }, status: 'in_progress', conclusion: null },
                    ],
                };
            }
            if (call.path.endsWith('/statuses')) {
                return [
                    { id: 20, context: 'legacy', state: 'failure' },
                    { id: 10, context: 'legacy', state: 'success' },
                ];
            }
            throw new Error(`Unexpected request: ${call.path}`);
        }),
        42,
    );
    const snapshot = await github.snapshot(target, pull);
    assert.deepEqual(
        snapshot.checks.map((check) => check.conclusion),
        ['failure', 'failure'],
    );
});

void test('recovering a created check after a crash does not create another check', async () => {
    const github = new GitHub(
        client((call) => {
            assert.equal(call.method, 'GET');
            return { total_count: 1, check_runs: [{ id: 25, name: 'Sahaayaka', external_id: '1:2:head:base' }] };
        }),
        42,
    );
    assert.equal(await github.create(target), 25);
});

void test('dismissal discovers orphaned approvals and ignores other reviewers and dismissed reviews', async () => {
    const dismissed: string[] = [];
    const github = new GitHub(
        client((call) => {
            if (call.path.endsWith('/reviews')) {
                return [
                    { id: 10, user: { login: 'sahaayaka[bot]' }, state: 'APPROVED', commit_id: 'old-head' },
                    { id: 11, user: { login: 'human' }, state: 'APPROVED' },
                    { id: 12, user: { login: 'sahaayaka[bot]' }, state: 'DISMISSED' },
                ];
            }
            if (call.path === '/app') {
                return { slug: 'sahaayaka' };
            }
            if (call.path.endsWith('/reviews/10/dismissals')) {
                dismissed.push(call.path);
                return {};
            }
            throw new Error(`Unexpected request: ${call.path}`);
        }),
        42,
    );
    await github.dismiss(target);
    assert.equal(dismissed.length, 1);
});

void test('policy is loaded from the trusted base commit', async () => {
    const github = new GitHub(
        client((call) => {
            assert.equal(call.query.get('ref'), 'base');
            return { type: 'file', encoding: 'base64', content: Buffer.from('{"approve":true}').toString('base64') };
        }),
        42,
    );
    assert.equal((await github.policy(target)).approve, true);
});

void test('Actions suites are resolved across source and synthetic merge commit references', async () => {
    const github = new GitHub(
        client((call) => {
            if (call.path.endsWith('/files')) {
                return [{ filename: 'README.md' }];
            }
            if (call.path.endsWith('/actions/runs')) {
                const runs = call.query.get('head_sha') === 'head' ? [workflow(20, 2, 'success')] : [];
                return { total_count: runs.length, workflow_runs: runs };
            }
            if (call.path.endsWith('/check-runs')) {
                const checks = call.path.includes('/merge/')
                    ? [
                          {
                              id: 200,
                              name: 'test',
                              app: { id: 15368, slug: 'github-actions' },
                              check_suite: { id: 200 },
                              status: 'completed',
                              conclusion: 'success',
                          },
                      ]
                    : [];
                return { total_count: checks.length, check_runs: checks };
            }
            if (call.path.endsWith('/jobs')) {
                return {
                    total_count: 1,
                    jobs: [{ id: 200, name: 'test', status: 'completed', conclusion: 'success' }],
                };
            }
            if (call.path.endsWith('/statuses')) {
                return [];
            }
            throw new Error(`Unexpected request: ${call.path}`);
        }),
        42,
    );
    const snapshot = await github.snapshot({ ...target, mergeSha: 'merge' }, { ...pull, mergeSha: 'merge' });
    assert.equal(snapshot.checks.filter((check) => check.name === 'test').length, 1);
    assert.equal(snapshot.checks.find((check) => check.name === 'test')?.appId, 15368);
    assert.equal(evaluate(snapshot, policySchema.parse({}), 0, 0, 60000).state, 'success');
});

void test('a successful current attempt replaces the earlier failed attempt', async () => {
    const github = new GitHub(
        client((call) => {
            if (call.path.endsWith('/files')) {
                return [{ filename: 'README.md' }];
            }
            if (call.path.endsWith('/actions/runs')) {
                return {
                    total_count: 2,
                    workflow_runs: [workflow(20, 2, 'failure', 1), workflow(20, 2, 'success', 2)],
                };
            }
            if (call.path.endsWith('/check-runs')) {
                return { total_count: 0, check_runs: [] };
            }
            if (call.path.endsWith('/jobs')) {
                return {
                    total_count: 1,
                    jobs: [{ id: 200, name: 'test', status: 'completed', conclusion: 'success' }],
                };
            }
            if (call.path.endsWith('/statuses')) {
                return [];
            }
            throw new Error(`Unexpected request: ${call.path}`);
        }),
        42,
    );
    const snapshot = await github.snapshot(target, pull);
    assert.equal(snapshot.checks.length, 2);
    assert.equal(evaluate(snapshot, policySchema.parse({}), 0, 0, 60000).state, 'success');
});

void test('check and file-list API inconsistencies fail closed', async () => {
    const github = new GitHub(
        client((call) => {
            if (call.path.endsWith('/files')) {
                return [{ filename: 'README.md' }];
            }
            if (call.path.endsWith('/actions/runs')) {
                return { total_count: 0, workflow_runs: [] };
            }
            if (call.path.endsWith('/check-runs')) {
                return {
                    total_count: 1,
                    check_runs: [{ id: 200, app: { id: 15368, slug: 'github-actions' }, name: 'test' }],
                };
            }
            throw new Error(`Unexpected request: ${call.path}`);
        }),
        42,
    );
    await assert.rejects(github.snapshot(target, pull), /no corresponding workflow run/u);
    await assert.rejects(github.snapshot(target, { ...pull, changedFiles: 2 }), /complete changed-file list/u);
});

void test('returning a completed aggregate to pending creates a fresh check instead of retaining success', async () => {
    const writes: Call[] = [];
    const github = new GitHub(
        client((call) => {
            if (call.method === 'GET' && call.path.endsWith('/check-runs/25')) {
                return { id: 25, status: 'completed', conclusion: 'success' };
            }
            if (call.method === 'GET' && call.path.endsWith('/check-runs')) {
                return {
                    total_count: 1,
                    check_runs: [
                        {
                            id: 25,
                            name: 'Sahaayaka',
                            external_id: '1:2:head:base',
                            status: 'completed',
                            conclusion: 'success',
                        },
                    ],
                };
            }
            writes.push(call);
            if (call.method === 'POST' && call.path.endsWith('/check-runs')) {
                return { id: 26, status: 'in_progress', conclusion: null };
            }
            if (call.method === 'PATCH' && call.path.endsWith('/check-runs/26')) {
                return { id: 26, status: 'in_progress', conclusion: null };
            }
            throw new Error(`Unexpected request: ${call.path}`);
        }),
        42,
    );
    assert.equal(await github.publish({ ...target, checkId: 25 }, 'pending', 'New execution started.'), 26);
    assert.deepEqual(
        writes.map((call) => call.method),
        ['POST', 'PATCH'],
    );
});

void test('a pending check created before a crash is reused during reset recovery', async () => {
    const github = new GitHub(
        client((call) => {
            if (call.path.endsWith('/check-runs/25')) {
                return { id: 25, status: 'completed', conclusion: 'success' };
            }
            if (call.path.endsWith('/check-runs')) {
                assert.equal(call.method, 'GET');
                return {
                    total_count: 2,
                    check_runs: [
                        { id: 25, name: 'Sahaayaka', external_id: '1:2:head:base', status: 'completed' },
                        { id: 26, name: 'Sahaayaka', external_id: '1:2:head:base', status: 'in_progress' },
                    ],
                };
            }
            assert.equal(call.path.endsWith('/check-runs/26'), true);
            return { id: 26, status: 'in_progress', conclusion: null };
        }),
        42,
    );
    assert.equal(await github.publish({ ...target, checkId: 25 }, 'pending', 'Recover interrupted reset.'), 26);
});

void test('partial rerun uses latest job outcomes even when GitHub copies a successful job under a new ID', async () => {
    const github = new GitHub(
        client((call) => {
            if (call.path.endsWith('/files')) {
                return [{ filename: 'src/edge-race.txt' }];
            }
            if (call.path.endsWith('/actions/runs')) {
                return { total_count: 1, workflow_runs: [workflow(20, 2, 'success', 2)] };
            }
            if (call.path.endsWith('/check-runs')) {
                return {
                    total_count: 1,
                    check_runs: [
                        {
                            id: 201,
                            name: 'flaky-edge',
                            app: { id: 15368, slug: 'github-actions' },
                            check_suite: { id: 200 },
                            status: 'completed',
                            conclusion: 'failure',
                        },
                    ],
                };
            }
            if (call.path.endsWith('/jobs')) {
                assert.equal(call.query.get('filter'), 'latest');
                return {
                    total_count: 2,
                    jobs: [
                        { id: 301, name: 'stable-edge', run_attempt: 2, status: 'completed', conclusion: 'success' },
                        { id: 302, name: 'flaky-edge', run_attempt: 2, status: 'completed', conclusion: 'success' },
                    ],
                };
            }
            if (call.path.endsWith('/statuses')) {
                return [];
            }
            throw new Error(`Unexpected request: ${call.path}`);
        }),
        42,
    );
    const snapshot = await github.snapshot(target, pull);
    assert.equal(snapshot.checks.length, 3);
    assert.equal(
        snapshot.checks.some((check) => check.conclusion === 'failure'),
        false,
    );
    assert.equal(evaluate(snapshot, policySchema.parse({}), 0, 0, 60000).state, 'success');
});

void test('base-branch pushes use the actual branch tip and exclude an old synthetic merge', async () => {
    const github = new GitHub(
        client((call) => {
            if (call.path.endsWith('/pulls/2')) {
                return {
                    head: { sha: 'head' },
                    base: { sha: 'old-base', ref: 'main' },
                    merge_commit_sha: 'old-merge',
                    state: 'open',
                    draft: false,
                    changed_files: 1,
                };
            }
            if (call.path.endsWith('/branches/main')) {
                return { commit: { sha: 'current-base' } };
            }
            if (call.path.endsWith('/git/commits/old-merge')) {
                return { parents: [{ sha: 'old-base' }, { sha: 'head' }] };
            }
            throw new Error(`Unexpected request: ${call.path}`);
        }),
        42,
    );
    const result = await github.pull(target);
    assert.equal(result.baseSha, 'current-base');
    assert.equal(result.mergeSha, null);
});

void test('a synthetic merge is included only when both parents match the evaluated revision', async () => {
    const github = new GitHub(
        client((call) => {
            if (call.path.endsWith('/pulls/2')) {
                return {
                    head: { sha: 'head' },
                    base: { sha: 'base', ref: 'main' },
                    merge_commit_sha: 'merge',
                    state: 'open',
                    draft: false,
                    changed_files: 1,
                };
            }
            if (call.path.endsWith('/branches/main')) {
                return { commit: { sha: 'base' } };
            }
            if (call.path.endsWith('/git/commits/merge')) {
                return { parents: [{ sha: 'base' }, { sha: 'head' }] };
            }
            throw new Error(`Unexpected request: ${call.path}`);
        }),
        42,
    );
    assert.equal((await github.pull(target)).mergeSha, 'merge');
});

void test('a closed PR stops tracking without resolving a possibly deleted base branch', async () => {
    const github = new GitHub(
        client((call) => {
            assert.equal(call.path.endsWith('/pulls/2'), true);
            return {
                head: { sha: 'head' },
                base: { sha: 'base', ref: 'deleted-base' },
                merge_commit_sha: null,
                state: 'closed',
                draft: false,
                changed_files: 1,
            };
        }),
        42,
    );
    assert.equal((await github.pull(target)).closed, true);
});

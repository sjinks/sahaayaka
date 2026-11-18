import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHub } from '../src/github.js';
import { evaluate, policySchema } from '../src/policy.js';
import type { Check, Octokit, Outcome, Snapshot, Target } from '../src/types.js';

const check = (conclusion: string | null, status = 'completed'): Check => ({
    key: 'head:check:build',
    name: 'build',
    appId: 7,
    status,
    conclusion,
    url: '',
});
const snapshot = (conclusion: string | null, status = 'completed'): Snapshot => ({
    checks: [check(conclusion, status)],
    files: ['src/index.ts'],
});
const evaluateNow = (input: Snapshot, overrides: Record<string, unknown> = {}, now = 31_000): Outcome =>
    evaluate(input, policySchema.parse(overrides), 0, 0, now);

void test('failed, cancelled, timed out, and unknown conclusions fail closed', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', null]) {
        const result = evaluateNow(snapshot(conclusion));
        assert.equal(result.state, 'failure', String(conclusion));
        assert.match(result.summary, /build:/u);
    }
});

void test('queued checks remain pending and time out from the evaluation start', () => {
    assert.equal(evaluateNow(snapshot(null, 'queued')).state, 'pending');
    const result = evaluateNow(snapshot(null, 'in_progress'), { timeoutSeconds: 60 }, 60_000);
    assert.equal(result.state, 'failure');
    assert.match(result.summary, /Timed out waiting for CI/u);
});

void test('skipped and neutral checks pass by default but can be excluded by policy', () => {
    for (const conclusion of ['skipped', 'neutral']) {
        assert.equal(evaluateNow(snapshot(conclusion)).state, 'success');
        assert.equal(evaluateNow(snapshot(conclusion), { allowedConclusions: ['success'] }).state, 'failure');
    }
});

void test('empty checks require an explicit allowEmpty policy', () => {
    const empty: Snapshot = { checks: [], files: ['src/index.ts'] };
    assert.match(evaluateNow(empty).summary, /No checks observed/u);
    assert.equal(evaluateNow(empty).state, 'pending');
    assert.equal(evaluateNow(empty, { allowEmpty: true }).state, 'success');
});

void test('required checks match changed paths and app IDs, with ignored paths excluded', () => {
    const requiredChecks = [{ name: 'build', appId: 42, paths: ['src/**'], ignorePaths: ['src/generated/**'] }];
    const changed: Snapshot = { checks: [check('success')], files: ['src/index.ts'] };
    const result = evaluateNow(changed, { requiredChecks });
    assert.equal(result.state, 'pending');
    assert.match(result.summary, /Missing required check: build/u);
    assert.equal(evaluateNow({ ...changed, files: ['src/generated/index.ts'] }, { requiredChecks }).state, 'success');
    assert.equal(
        evaluateNow({ ...changed, checks: [{ ...check('success'), appId: 42 }] }, { requiredChecks }).state,
        'success',
    );
});

void test('a missing required check times out even when observed checks passed', () => {
    const result = evaluateNow(
        snapshot('success'),
        { requiredChecks: [{ name: 'security', paths: ['src/**'] }], timeoutSeconds: 60 },
        60_000,
    );
    assert.equal(result.state, 'failure');
    assert.match(result.summary, /Missing required check: security/u);
});

void test('a renamed file applies path rules to both old and new names', async () => {
    const listFiles = (): undefined => undefined;
    const listWorkflowRunsForRepo = (): undefined => undefined;
    const listForRef = (): undefined => undefined;
    const listCommitStatusesForRef = (): undefined => undefined;
    const octokit = {
        rest: {
            pulls: { listFiles },
            actions: { listWorkflowRunsForRepo },
            checks: { listForRef },
            repos: { listCommitStatusesForRef },
        },
        paginate: (endpoint: unknown): Promise<{ filename: string; previous_filename: string }[]> =>
            Promise.resolve(
                endpoint === listFiles ? [{ filename: 'docs/new.md', previous_filename: 'src/old.ts' }] : [],
            ),
    } as unknown as Octokit;
    const target = { owner: 'owner', repo: 'repo', headSha: 'head', mergeSha: null } as Target;
    const result = await new GitHub(octokit, 1).snapshot(target, {
        headSha: 'head',
        baseSha: 'base',
        mergeSha: null,
        draft: false,
        closed: false,
        changedFiles: 1,
    });
    assert.deepEqual(result.files, ['docs/new.md', 'src/old.ts']);
    assert.match(
        evaluateNow(result, { requiredChecks: [{ name: 'legacy', paths: ['src/**'] }] }).summary,
        /Missing required check: legacy/u,
    );
    assert.equal(evaluateNow(result, { requiredChecks: [{ name: 'docs', paths: ['docs/**'] }] }).state, 'pending');
});

import { createHash } from 'node:crypto';
import type { Gateway, Pull } from './github.js';
import { Store } from './store.js';
import { evaluate } from './policy.js';
import { isRateLimitError } from './retry.js';
import type { Outcome, Target } from './types.js';

export function revisionChanged(target: Target, pull: Pull): boolean {
    return target.headSha !== pull.headSha || target.baseSha !== pull.baseSha || target.mergeSha !== pull.mergeSha;
}

export class Engine {
    public constructor(
        private readonly store: Store,
        private readonly now: () => number = Date.now,
    ) {}

    public invalidate(key: string): void {
        const target = this.store.get(key);
        if (target) {
            const terminal = target.signature !== null && !target.signature.includes('"state":"pending"');
            this.store.put({
                ...target,
                generation: target.generation + 1,
                signature: null,
                activityAt: this.now(),
                startedAt: terminal ? this.now() : target.startedAt,
                closed: false,
            });
        }
    }

    private current(target: Target): boolean {
        const current = this.store.get(target.key);
        return (
            current?.generation === target.generation &&
            !current.closed &&
            this.store.canAccess(target.installationId, target.repositoryId)
        );
    }

    public async reconcile(key: string, github: Gateway): Promise<void> {
        let target = this.store.get(key);
        if (!target || target.closed || !this.store.canAccess(target.installationId, target.repositoryId)) {
            return;
        }
        try {
            const pull = await github.pull(target);
            if (!this.current(target)) {
                return;
            }
            if (pull.closed) {
                this.store.put({ ...target, closed: true });
                return;
            }
            const preparedTarget = await this.prepare(target, pull, github);
            if (!preparedTarget) {
                return;
            }
            target = preparedTarget;
            const policy = await github.policy(target);
            const snapshot = await github.snapshot(target, pull);
            if (!this.current(target)) {
                return;
            }
            const hash = createHash('sha256')
                .update(JSON.stringify(snapshot.checks.toSorted((a, b) => a.key.localeCompare(b.key))))
                .digest('hex');
            if (hash !== target.snapshotHash) {
                target.snapshotHash = hash;
                target.activityAt = this.now();
                this.store.put(target);
            }
            const outcome = evaluate(snapshot, policy, target.startedAt, target.activityAt, this.now());
            // Re-read the PR before publishing; delayed events must not move an
            // evaluation of an older revision onto the current revision.
            const freshPull = await github.pull(target);
            if (!this.current(target) || revisionChanged(target, freshPull) || freshPull.closed) {
                return;
            }
            await this.finish(target, github, outcome, policy.approve && !freshPull.draft);
        } catch (error) {
            if (!isRateLimitError(error)) {
                await this.fail(target, github);
            }
            throw error;
        }
    }

    private async fail(target: Target, github: Gateway): Promise<void> {
        if (!this.current(target) || target.checkId === null) {
            return;
        }
        const checkId = await github.publish(
            target,
            'failure',
            'Unable to evaluate CI. Check the application logs and repository policy.',
        );
        if (!this.current(target)) {
            return;
        }
        target.checkId = checkId;
        await github.dismiss(target);
        if (this.current(target)) {
            this.store.put({ ...target, reviewId: null, signature: null });
        }
    }

    private async prepare(target: Target, pull: Pull, github: Gateway): Promise<Target | undefined> {
        if (revisionChanged(target, pull)) {
            await github.dismiss(target);
            if (!this.current(target)) {
                return undefined;
            }
            target = {
                ...target,
                ...pull,
                startedAt: this.now(),
                activityAt: this.now(),
                generation: target.generation + 1,
                checkId: null,
                reviewId: null,
                signature: null,
                snapshotHash: null,
            };
            this.store.put(target);
        }
        target.draft = pull.draft;
        if (target.checkId === null) {
            const checkId = await github.create(target);
            if (!this.current(target)) {
                return undefined;
            }
            target.checkId = checkId;
            this.store.put(target);
        }
        if (target.signature === null) {
            const checkId = await github.publish(target, 'pending', 'Reconciling current CI results.');
            if (!this.current(target)) {
                return undefined;
            }
            target.checkId = checkId;
            this.store.put(target);
            await github.dismiss(target);
            if (!this.current(target)) {
                return undefined;
            }
            target.reviewId = null;
            target.signature = JSON.stringify({ state: 'pending', summary: 'Reconciling current CI results.' });
            this.store.put(target);
        }
        return target;
    }

    private async finish(target: Target, github: Gateway, outcome: Outcome, allowApprove: boolean): Promise<void> {
        if (outcome.state !== 'success' || !allowApprove) {
            await github.dismiss(target);
            if (!this.current(target)) {
                return;
            }
            target.reviewId = null;
            this.store.put(target);
        }
        const signature = JSON.stringify(outcome);
        if (signature !== target.signature) {
            const checkId = await github.publish(target, outcome.state, outcome.summary);
            if (!this.current(target)) {
                return;
            }
            target.checkId = checkId;
            target.signature = signature;
            this.store.put(target);
        }
        if (outcome.state === 'success' && allowApprove && target.reviewId === null) {
            const reviewId = await github.approve(target);
            if (!this.current(target)) {
                // Record first so a subsequent reconciliation can dismiss it.
                const current = this.store.get(target.key);
                if (current) {
                    this.store.put({ ...current, reviewId });
                }
                return;
            }
            target.reviewId = reviewId;
            this.store.put(target);
        }
    }
}

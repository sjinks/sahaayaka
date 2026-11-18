import { minimatch } from 'minimatch';
import { z } from 'zod';
import type { Check, Outcome, Snapshot } from './types.js';

const requirementSchema = z.strictObject({
    name: z.string().min(1),
    appId: z.number().int().positive().optional(),
    paths: z.array(z.string().min(1)).min(1).optional(),
    ignorePaths: z.array(z.string().min(1)).optional(),
});

export const policySchema = z.strictObject({
    approve: z.boolean().default(false),
    settleSeconds: z.number().int().min(10).max(600).default(30),
    timeoutSeconds: z.number().int().min(60).max(604800).default(3600),
    allowEmpty: z.boolean().default(false),
    allowedConclusions: z
        .array(z.enum(['success', 'neutral', 'skipped']))
        .min(1)
        .default(['success', 'skipped', 'neutral']),
    requiredChecks: z.array(requirementSchema).default([]),
});

export type Policy = z.infer<typeof policySchema>;

function applies(requirement: Policy['requiredChecks'][number], files: string[]): boolean {
    return files.some(
        (file) =>
            (!requirement.paths || requirement.paths.some((pattern) => minimatch(file, pattern, { dot: true }))) &&
            !requirement.ignorePaths?.some((pattern) => minimatch(file, pattern, { dot: true })),
    );
}

function describe(check: Check): string {
    return `${check.name}: ${check.status === 'completed' ? (check.conclusion ?? 'unknown') : check.status}`;
}

export function evaluate(
    snapshot: Snapshot,
    policy: Policy,
    startedAt: number,
    activityAt: number,
    now: number,
): Outcome {
    const failed = snapshot.checks.filter(
        (check) =>
            check.status === 'completed' &&
            (!check.conclusion || !policy.allowedConclusions.some((conclusion) => conclusion === check.conclusion)),
    );
    if (failed.length) {
        return { state: 'failure', summary: failed.map(describe).join('\n') };
    }

    const waiting = snapshot.checks.filter((check) => check.status !== 'completed').map(describe);
    const applicable = policy.requiredChecks.filter((requirement) => applies(requirement, snapshot.files));
    for (const requirement of applicable) {
        if (
            !snapshot.checks.some(
                (check) =>
                    check.name === requirement.name &&
                    (requirement.appId === undefined || check.appId === requirement.appId),
            )
        ) {
            waiting.push(`Missing required check: ${requirement.name}`);
        }
    }

    if (!snapshot.checks.length && !applicable.length && !policy.allowEmpty) {
        waiting.push('No checks observed. Set allowEmpty explicitly to permit this.');
    }
    if (waiting.length) {
        return {
            state: now - startedAt >= policy.timeoutSeconds * 1000 ? 'failure' : 'pending',
            summary: `${now - startedAt >= policy.timeoutSeconds * 1000 ? 'Timed out waiting for CI.\n' : ''}${waiting.join('\n')}`,
        };
    }
    if (now - activityAt < policy.settleSeconds * 1000) {
        return { state: 'pending', summary: 'Waiting for additional CI runs to appear.' };
    }
    return {
        state: 'success',
        summary: snapshot.checks.length
            ? `All ${snapshot.checks.length} current checks passed.\n${snapshot.checks.map(describe).join('\n')}`
            : 'No checks are required for these changes.',
    };
}

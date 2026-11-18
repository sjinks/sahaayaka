import type { Probot } from 'probot';

export type Octokit = Awaited<ReturnType<Probot['auth']>>;

export interface Repository {
    owner: string;
    repo: string;
}

export interface Target extends Repository {
    key: string;
    repositoryId: number;
    installationId: number;
    pullNumber: number;
    headSha: string;
    baseSha: string;
    mergeSha: string | null;
    draft: boolean;
    startedAt: number;
    activityAt: number;
    generation: number;
    checkId: number | null;
    reviewId: number | null;
    signature: string | null;
    snapshotHash: string | null;
    closed: boolean;
    closedChecksFinalized?: boolean | undefined;
}

export interface Check {
    key: string;
    name: string;
    appId: number | null;
    status: string;
    conclusion: string | null;
    url: string;
}

export interface Snapshot {
    checks: Check[];
    files: string[];
}

export interface Outcome {
    state: 'pending' | 'success' | 'failure';
    summary: string;
}

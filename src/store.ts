import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Target } from './types.js';

const targetSchema = z.object({
    key: z.string(),
    owner: z.string(),
    repo: z.string(),
    repositoryId: z.number(),
    installationId: z.number(),
    pullNumber: z.number(),
    headSha: z.string(),
    baseSha: z.string(),
    mergeSha: z.string().nullable(),
    draft: z.boolean(),
    startedAt: z.number(),
    activityAt: z.number(),
    generation: z.number(),
    checkId: z.number().nullable(),
    reviewId: z.number().nullable(),
    signature: z.string().nullable(),
    snapshotHash: z.string().nullable(),
    closed: z.boolean(),
});

export class Store {
    private readonly database: DatabaseSync;
    private readonly lock: DatabaseSync;

    public constructor(path: string) {
        mkdirSync(dirname(path), { recursive: true });
        // Hold an OS-backed SQLite lock for the entire process lifetime. A second
        // publisher must never race this worker; a crash automatically releases it.
        this.lock = new DatabaseSync(`${path}.lock`);
        this.lock.exec(
            'PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER)',
        );
        this.database = new DatabaseSync(path);
        this.database.exec(
            'PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS targets (key TEXT PRIMARY KEY, data TEXT NOT NULL)',
        );
        this.database.exec('CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL)');
        this.database.exec(
            'CREATE TABLE IF NOT EXISTS installations (id INTEGER PRIMARY KEY, active INTEGER NOT NULL)',
        );
        this.database.exec(
            'CREATE TABLE IF NOT EXISTS repository_access (installation_id INTEGER NOT NULL, repository_id INTEGER NOT NULL, active INTEGER NOT NULL, PRIMARY KEY (installation_id, repository_id))',
        );
        if (
            !this.database
                .prepare('PRAGMA table_info(targets)')
                .all()
                .some((column) => column.name === 'closed_at')
        ) {
            this.database.exec('ALTER TABLE targets ADD COLUMN closed_at INTEGER');
        }
        // Existing closed targets receive a full retention period on upgrade.
        this.database
            .prepare("UPDATE targets SET closed_at = ? WHERE closed_at IS NULL AND json_extract(data, '$.closed') = 1")
            .run(Date.now());
        this.database.exec('CREATE INDEX IF NOT EXISTS targets_closed_at ON targets (closed_at)');
        this.database.exec('CREATE INDEX IF NOT EXISTS deliveries_received_at ON deliveries (received_at)');
    }

    public get(key: string): Target | undefined {
        const row = this.database.prepare('SELECT data FROM targets WHERE key = ?').get(key);
        return row ? targetSchema.parse(JSON.parse(String(row.data))) : undefined;
    }

    public put(target: Target, now = Date.now()): void {
        this.database
            .prepare(
                `INSERT INTO targets (key, data, closed_at) VALUES (?, ?, ?)
                 ON CONFLICT(key) DO UPDATE SET data = excluded.data,
                 closed_at = CASE WHEN json_extract(excluded.data, '$.closed') = 0 THEN NULL
                                  ELSE COALESCE(targets.closed_at, excluded.closed_at) END`,
            )
            .run(target.key, JSON.stringify(target), target.closed ? now : null);
    }

    public all(): Target[] {
        return this.database
            .prepare('SELECT data FROM targets')
            .all()
            .map((row) => targetSchema.parse(JSON.parse(String(row.data))));
    }

    public canAccess(installationId: number, repositoryId: number): boolean {
        return !this.installationDenied(installationId) && !this.repositoryDenied(installationId, repositoryId);
    }

    public installationDenied(installationId: number): boolean {
        const row = this.database.prepare('SELECT active FROM installations WHERE id = ?').get(installationId);
        return row?.active === 0;
    }

    public repositoryDenied(installationId: number, repositoryId: number): boolean {
        const row = this.database
            .prepare('SELECT active FROM repository_access WHERE installation_id = ? AND repository_id = ?')
            .get(installationId, repositoryId);
        return row?.active === 0;
    }

    public knownInstallationIds(): number[] {
        const ids = new Set(
            this.database
                .prepare('SELECT id FROM installations')
                .all()
                .map((row) => Number(row.id)),
        );
        for (const target of this.all()) {
            ids.add(target.installationId);
        }
        return [...ids];
    }

    public activeInstallationIds(): number[] {
        const ids = new Set(
            this.database
                .prepare('SELECT id FROM installations WHERE active = 1')
                .all()
                .map((row) => Number(row.id)),
        );
        for (const target of this.all()) {
            if (!target.closed && this.canAccess(target.installationId, target.repositoryId)) {
                ids.add(target.installationId);
            }
        }
        return [...ids];
    }

    public knownRepositoryIds(installationId: number): number[] {
        const ids = new Set(
            this.database
                .prepare('SELECT repository_id FROM repository_access WHERE installation_id = ?')
                .all(installationId)
                .map((row) => Number(row.repository_id)),
        );
        for (const target of this.all()) {
            if (target.installationId === installationId) {
                ids.add(target.repositoryId);
            }
        }
        return [...ids];
    }

    public activeRepositoryIds(installationId: number): number[] {
        if (this.installationDenied(installationId)) {
            return [];
        }
        const ids = new Set(
            this.database
                .prepare('SELECT repository_id FROM repository_access WHERE installation_id = ? AND active = 1')
                .all(installationId)
                .map((row) => Number(row.repository_id)),
        );
        for (const target of this.all()) {
            if (
                !target.closed &&
                target.installationId === installationId &&
                this.canAccess(installationId, target.repositoryId)
            ) {
                ids.add(target.repositoryId);
            }
        }
        return [...ids];
    }

    public activateInstallation(installationId: number): void {
        this.database
            .prepare('INSERT INTO installations (id, active) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET active = 1')
            .run(installationId);
    }

    public retireInstallation(installationId: number): void {
        this.database
            .prepare('INSERT INTO installations (id, active) VALUES (?, 0) ON CONFLICT(id) DO UPDATE SET active = 0')
            .run(installationId);
        for (const target of this.all()) {
            if (target.installationId === installationId) {
                this.retire(target);
            }
        }
    }

    public activateRepository(installationId: number, repositoryId: number): void {
        this.database
            .prepare(
                'INSERT INTO repository_access (installation_id, repository_id, active) VALUES (?, ?, 1) ON CONFLICT(installation_id, repository_id) DO UPDATE SET active = 1',
            )
            .run(installationId, repositoryId);
    }

    public retireRepository(installationId: number, repositoryId: number): void {
        this.database
            .prepare(
                'INSERT INTO repository_access (installation_id, repository_id, active) VALUES (?, ?, 0) ON CONFLICT(installation_id, repository_id) DO UPDATE SET active = 0',
            )
            .run(installationId, repositoryId);
        for (const target of this.all()) {
            if (target.installationId === installationId && target.repositoryId === repositoryId) {
                this.retire(target);
            }
        }
    }

    public retire(target: Target): void {
        const current = this.get(target.key);
        if (current && !current.closed) {
            this.put({ ...current, generation: current.generation + 1, closed: true });
        }
    }

    public processDelivery(id: string, callback: () => void, now = Date.now()): void {
        this.database.exec('BEGIN');
        try {
            // Expire this ID directly; general cleanup is batched outside the
            // webhook transaction so a busy delivery cannot trigger a full sweep.
            this.database
                .prepare('DELETE FROM deliveries WHERE id = ? AND received_at < ?')
                .run(id, now - 7 * 24 * 60 * 60 * 1000);
            const inserted = this.database
                .prepare('INSERT OR IGNORE INTO deliveries (id, received_at) VALUES (?, ?)')
                .run(id, now).changes;
            if (inserted > 0) {
                callback();
            }
            this.database.exec('COMMIT');
        } catch (error) {
            this.database.exec('ROLLBACK');
            throw error;
        }
    }

    public close(): void {
        this.database.close();
        this.lock.close();
    }

    public ping(): boolean {
        try {
            return this.database.prepare('SELECT 1 AS ok').get()?.ok === 1;
        } catch {
            return false;
        }
    }

    public counts(): { activeTargets: number; closedTargets: number; deliveries: number } {
        const active = this.database
            .prepare("SELECT count(*) AS count FROM targets WHERE json_extract(data, '$.closed') = 0")
            .get();
        const closed = this.database.prepare('SELECT count(*) AS count FROM targets WHERE closed_at IS NOT NULL').get();
        const deliveries = this.database.prepare('SELECT count(*) AS count FROM deliveries').get();
        return {
            activeTargets: Number(active?.count ?? 0),
            closedTargets: Number(closed?.count ?? 0),
            deliveries: Number(deliveries?.count ?? 0),
        };
    }

    public prune(retentionMs: number, now = Date.now()): { targets: number; deliveries: number } {
        if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0 || !Number.isSafeInteger(now)) {
            throw new RangeError('Retention and timestamp must be valid integer milliseconds.');
        }
        this.database.exec('BEGIN');
        try {
            const targets = this.database
                .prepare(
                    `DELETE FROM targets WHERE key IN (
                SELECT key FROM targets WHERE closed_at < ? AND json_extract(data, '$.closed') = 1
                ORDER BY closed_at LIMIT 1000)`,
                )
                .run(now - retentionMs).changes;
            const deliveries = this.database
                .prepare(
                    `DELETE FROM deliveries WHERE id IN (
                SELECT id FROM deliveries WHERE received_at < ? ORDER BY received_at LIMIT 1000)`,
                )
                .run(now - 7 * 24 * 60 * 60 * 1000).changes;
            this.database.exec('COMMIT');
            return { targets: Number(targets), deliveries: Number(deliveries) };
        } catch (error) {
            this.database.exec('ROLLBACK');
            throw error;
        }
    }
}

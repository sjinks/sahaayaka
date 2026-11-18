import { accessSync, constants, readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { createNodeMiddleware, createProbot } from 'probot';
import { type Runtime, register } from './app.js';
import { Health } from './health.js';
import { Maintenance } from './maintenance.js';
import { readSettings } from './settings.js';
import { Store } from './store.js';

const settings = readSettings();
if (!process.env.PRIVATE_KEY && !process.env.PRIVATE_KEY_PATH) {
    throw new Error('Set PRIVATE_KEY or PRIVATE_KEY_PATH.');
}

if (!process.env.PRIVATE_KEY && process.env.PRIVATE_KEY_PATH) {
    accessSync(process.env.PRIVATE_KEY_PATH, constants.R_OK);
}

const webhookSecret = process.env.WEBHOOK_SECRET_FILE
    ? readFileSync(process.env.WEBHOOK_SECRET_FILE, 'utf-8').replace(/\r?\n$/u, '')
    : process.env.WEBHOOK_SECRET;

if (process.env.NODE_ENV === 'production' && !webhookSecret) {
    throw new Error('Set WEBHOOK_SECRET or WEBHOOK_SECRET_FILE in production.');
}

const probot = createProbot({ overrides: { secret: webhookSecret ?? '' } });
await probot.ready();

const store = new Store(process.env.DATABASE_PATH ?? './data/sahaayaka.sqlite');
const maintenance = new Maintenance(store, settings.retentionMs, probot.log);

let runtime: Runtime | undefined;
const health = new Health(
    () => runtime?.status(),
    store,
    () => maintenance.status(),
    settings.maxDiscoveryAgeMs,
);

const middleware = await createNodeMiddleware(
    (app, options) => {
        runtime = register(app, store, settings.appId, settings.interval, settings.repositories);
        options.addHandler((request: IncomingMessage, response: ServerResponse) => health.handle(request, response));
    },
    { probot, webhooksPath: probot.webhookPath },
);

const server = createServer((request, response) => {
    void Promise.resolve(
        middleware(request, response, () => {
            response.writeHead(404).end();
        }),
    ).catch(() => {
        if (!response.headersSent) {
            response.writeHead(500);
        }
        response.end();
    });
});

await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, settings.host, resolve);
});

probot.log.info({ host: settings.host, port: settings.port }, 'Sahaayaka is listening');

let proxy: { close(): void } | undefined;
if (process.env.WEBHOOK_PROXY_URL) {
    const { default: SmeeClient } = await import('smee-client');
    const host = settings.host === '0.0.0.0' ? '127.0.0.1' : settings.host;
    const targetHost = host === '::' ? '::1' : host;
    const address = targetHost.includes(':') ? `[${targetHost}]` : targetHost;
    proxy = await new SmeeClient({
        source: process.env.WEBHOOK_PROXY_URL,
        target: `http://${address}:${settings.port}${probot.webhookPath}`,
        logger: probot.log,
    }).start();
}

let stopping = false;
async function stop(): Promise<void> {
    health.beginShutdown();
    maintenance.stop();
    proxy?.close();
    const deadline = setTimeout(() => {
        probot.log.error('Graceful shutdown deadline exceeded');
        server.closeAllConnections();
        process.exit(1);
    }, settings.shutdownTimeoutMs);
    deadline.unref();

    try {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
        await runtime?.stop();
    } finally {
        clearTimeout(deadline);
    }
}

function shutdown(): void {
    if (stopping) {
        return;
    }

    stopping = true;
    void stop().catch(() => {
        probot.log.error('Graceful shutdown failed');
        process.exit(1);
    });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

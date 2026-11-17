import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, Server } from 'node:http';

/** Optional process-only probe for container hosts; no tenant/dependency information. */
@Injectable()
export class WorkerLivenessService implements OnApplicationBootstrap, OnModuleDestroy {
  private server?: Server;
  constructor(private readonly config: ConfigService) {}

  async onApplicationBootstrap() {
    const raw = this.config.get<string>('WORKER_HEALTH_PORT');
    if (raw === undefined || raw === '') return;
    const port = Number(raw);
    if (!/^\d+$/.test(String(raw)) || !Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error('WORKER_HEALTH_PORT must be an integer port');
    this.server = createServer((request, response) => {
      const live = request.method === 'GET' && request.url === '/health/live';
      response.writeHead(live ? 200 : 404, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(live ? { status: 'alive' } : { error: 'not_found' }));
    });
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  async onModuleDestroy() {
    if (!this.server?.listening) return;
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}

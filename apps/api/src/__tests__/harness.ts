import './_env.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../server.js';
import { userRepo } from '../repo.js';
import { signToken, hashPassword } from '../auth.js';
import type { User } from '../types.js';

export class TestHarness {
  private server?: Server;
  base?: string;
  token?: string;

  constructor() {}

  async start(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, () => resolve());
    });
    const { port } = this.server!.address() as AddressInfo;
    this.base = `http://127.0.0.1:${port}`;
    return this.base;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  seedUser(role: User['role'], label: string): User {
    const rnd = Math.random().toString(36).slice(2, 10);
    return userRepo.create(`${label} ${rnd}`, `${label}.${rnd}@example.com`, hashPassword('pw-secret-123'), role);
  }

  mint(user: User): string {
    return signToken(user);
  }

  async fetch(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
    if (!this.base) throw new Error('Harness not started');

    const headers: Record<string, string> = { ...opts.headers, 'content-type': 'application/json' };
    if (this.token) {
        headers['authorization'] = `Bearer ${this.token}`;
    }

    return await fetch(`${this.base}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  }

  async api(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number, body: any }> {
    const res = await this.fetch(path, opts);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }
}

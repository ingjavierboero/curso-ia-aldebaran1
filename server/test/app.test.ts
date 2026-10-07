import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('GET /api/health', () => {
  let server: ReturnType<ReturnType<typeof createApp>['listen']>;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('responde ok', async () => {
    const res = await fetch(`${baseUrl}/api/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

import { describe, it, expect, vi } from 'vitest';

import {
  closeActiveServer,
  getActiveServer,
  runWithServer,
} from '../../src/cli/run-with-server.js';
import type { IAgentServerHandle } from '../../src/core/interfaces.js';

function stubServer(): IAgentServerHandle & { close: ReturnType<typeof vi.fn> } {
  return {
    baseUrl: 'http://127.0.0.1:4321',
    isAlive: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
  };
}

describe('runWithServer', () => {
  it('runs the callback and closes the server afterwards', async () => {
    const server = stubServer();
    const result = await runWithServer(server, async () => 'ok');
    expect(result).toBe('ok');
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(getActiveServer()).toBeUndefined();
  });

  it('closes the server even when the callback throws', async () => {
    const server = stubServer();
    await expect(runWithServer(server, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('exposes the active server for signal handlers while running', async () => {
    const server = stubServer();
    await runWithServer(server, async () => {
      expect(getActiveServer()).toBe(server);
    });
  });

  it('runs without a server (pi backend)', async () => {
    const result = await runWithServer(undefined, async () => 42);
    expect(result).toBe(42);
  });

  it('swallows teardown errors so the run outcome is preserved', async () => {
    const server = stubServer();
    server.close.mockRejectedValue(new Error('close failed'));
    await expect(runWithServer(server, async () => 'done')).resolves.toBe('done');
  });
});

describe('closeActiveServer', () => {
  it('closes the active server and clears it', async () => {
    const server = stubServer();
    await runWithServer(server, async () => {
      await closeActiveServer();
    });
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(getActiveServer()).toBeUndefined();
  });

  it('is a no-op when nothing is active', async () => {
    await expect(closeActiveServer()).resolves.toBeUndefined();
  });
});

/**
 * SIGINT handler tests — double-Ctrl+C gate and orchestrator.pause() integration.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Test the double-Ctrl+C gate logic in isolation (pure function, no process)
// ---------------------------------------------------------------------------

describe('SIGINT handler double-Ctrl+C gate', () => {
  let sigintCount: number;
  let sigintTimer: ReturnType<typeof setTimeout> | undefined;
  let pauseCalled: boolean;
  let exitCode: number | null;

  const simulateSigint = async (onPause: () => Promise<void>) => {
    sigintCount++;
    if (sigintCount === 1) {
      sigintTimer = setTimeout(() => {
        sigintCount = 0;
      }, 2000);

      try {
        pauseCalled = true;
        await onPause();
        exitCode = 0;
      } catch {
        exitCode = 130;
      }
    } else {
      if (sigintTimer !== undefined) {
        clearTimeout(sigintTimer);
      }
      exitCode = 130;
    }
  };

  beforeEach(() => {
    sigintCount = 0;
    sigintTimer = undefined;
    pauseCalled = false;
    exitCode = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('single SIGINT calls onPause and sets exitCode to 0', async () => {
    const pausePromise = simulateSigint(() => Promise.resolve());

    await pausePromise;

    expect(pauseCalled).toBe(true);
    expect(sigintCount).toBe(1);
    expect(exitCode).toBe(0);
  });

  it('single SIGINT with failing pause sets exitCode to 130', async () => {
    const pausePromise = simulateSigint(() => Promise.reject(new Error('pause failed')));

    await pausePromise;

    expect(pauseCalled).toBe(true);
    expect(exitCode).toBe(130);
  });

  it('double SIGINT within 2s exits with code 130', async () => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    simulateSigint(() => new Promise(() => {})); // never resolves

    // Second SIGINT within the 2s window
    await simulateSigint(async () => {});

    expect(exitCode).toBe(130);
    expect(sigintCount).toBe(2);
  });

  it('resets the counter after 2s (timeout)', async () => {
    await simulateSigint(() => Promise.resolve());

    expect(sigintCount).toBe(1);

    // Advance timers past the 2s window
    vi.advanceTimersByTime(2500);

    expect(sigintCount).toBe(0); // reset by timer
  });

  it('clears timer on second SIGINT', async () => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    simulateSigint(() => new Promise(() => {}));

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    await simulateSigint(async () => {});

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});

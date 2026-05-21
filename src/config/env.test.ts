import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from './env.js';

/**
 * loadEnv reads from `process.env`, so each test mutates + restores. We
 * stash the keys we touch and the snapshot-restore them in `t.after`.
 */
function withEnvOverrides<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(previous)) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('loadEnv: SW_MAX_*_BUDGET_USD default to 10000 / 100', () => {
  withEnvOverrides(
    { SW_MAX_DAILY_BUDGET_USD: undefined, SW_MAX_SESSION_BUDGET_USD: undefined },
    () => {
      const e = loadEnv();
      assert.equal(e.maxDailyBudgetUsd, 10000);
      assert.equal(e.maxSessionBudgetUsd, 100);
    },
  );
});

test('loadEnv: SW_MAX_*_BUDGET_USD parse positive decimals', () => {
  withEnvOverrides(
    { SW_MAX_DAILY_BUDGET_USD: '5000.50', SW_MAX_SESSION_BUDGET_USD: '0.25' },
    () => {
      const e = loadEnv();
      assert.equal(e.maxDailyBudgetUsd, 5000.5);
      assert.equal(e.maxSessionBudgetUsd, 0.25);
    },
  );
});

test('loadEnv: rejects zero or negative SW_MAX_DAILY_BUDGET_USD', () => {
  withEnvOverrides({ SW_MAX_DAILY_BUDGET_USD: '0' }, () => {
    assert.throws(() => loadEnv(), /must be a positive number/);
  });
  withEnvOverrides({ SW_MAX_DAILY_BUDGET_USD: '-5' }, () => {
    assert.throws(() => loadEnv(), /must be a positive number/);
  });
});

test('loadEnv: rejects non-numeric SW_MAX_SESSION_BUDGET_USD', () => {
  withEnvOverrides({ SW_MAX_SESSION_BUDGET_USD: 'free' }, () => {
    assert.throws(() => loadEnv(), /must be a positive number/);
  });
});

test('loadEnv: empty string falls back to default (treated as unset)', () => {
  withEnvOverrides({ SW_MAX_DAILY_BUDGET_USD: '' }, () => {
    const e = loadEnv();
    assert.equal(e.maxDailyBudgetUsd, 10000);
  });
});

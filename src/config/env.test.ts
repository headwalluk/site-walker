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

// ---------------------------------------------------------------------------
// M23 rate-limit env
// ---------------------------------------------------------------------------

test('loadEnv: SW_RATELIMIT_* defaults (enabled, 10/60/20/120 per minute)', () => {
  withEnvOverrides(
    {
      SW_RATELIMIT_ENABLED: undefined,
      SW_RATELIMIT_SESSIONS_PER_IP_PER_MINUTE: undefined,
      SW_RATELIMIT_SESSIONS_PER_CHATBOT_PER_MINUTE: undefined,
      SW_RATELIMIT_CHAT_PER_IP_PER_MINUTE: undefined,
      SW_RATELIMIT_CHAT_PER_CHATBOT_PER_MINUTE: undefined,
    },
    () => {
      const e = loadEnv();
      assert.equal(e.rateLimit.enabled, true);
      assert.equal(e.rateLimit.sessionsPerIp, 10);
      assert.equal(e.rateLimit.sessionsPerChatbot, 60);
      assert.equal(e.rateLimit.chatPerIp, 20);
      assert.equal(e.rateLimit.chatPerChatbot, 120);
    },
  );
});

test('loadEnv: SW_RATELIMIT_ENABLED accepts true/false/1/0/yes/no', () => {
  for (const truthy of ['true', 'TRUE', '1', 'yes', 'YES']) {
    withEnvOverrides({ SW_RATELIMIT_ENABLED: truthy }, () => {
      assert.equal(loadEnv().rateLimit.enabled, true, `"${truthy}" should be true`);
    });
  }
  for (const falsy of ['false', 'FALSE', '0', 'no', 'NO']) {
    withEnvOverrides({ SW_RATELIMIT_ENABLED: falsy }, () => {
      assert.equal(loadEnv().rateLimit.enabled, false, `"${falsy}" should be false`);
    });
  }
});

test('loadEnv: SW_RATELIMIT_ENABLED rejects garbage', () => {
  withEnvOverrides({ SW_RATELIMIT_ENABLED: 'maybe' }, () => {
    assert.throws(() => loadEnv(), /must be a boolean/);
  });
});

test('loadEnv: SW_RATELIMIT_*_PER_MINUTE rejects zero / negative / non-integer', () => {
  for (const bad of ['0', '-1', '1.5', 'lots']) {
    withEnvOverrides({ SW_RATELIMIT_CHAT_PER_IP_PER_MINUTE: bad }, () => {
      assert.throws(() => loadEnv(), /must be a positive integer/);
    });
  }
});

test('loadEnv: SW_RATELIMIT_*_PER_MINUTE parses valid override', () => {
  withEnvOverrides(
    {
      SW_RATELIMIT_SESSIONS_PER_IP_PER_MINUTE: '5',
      SW_RATELIMIT_CHAT_PER_CHATBOT_PER_MINUTE: '500',
    },
    () => {
      const e = loadEnv();
      assert.equal(e.rateLimit.sessionsPerIp, 5);
      assert.equal(e.rateLimit.chatPerChatbot, 500);
    },
  );
});

// ---------------------------------------------------------------------------
// M23.5 sim env
// ---------------------------------------------------------------------------

test('loadEnv: SW_SIM_*_AFTER_USER_TURNS default to null when unset', () => {
  withEnvOverrides(
    {
      SW_SIM_SOFT_HANDOFF_AFTER_USER_TURNS: undefined,
      SW_SIM_HARD_HANDOFF_AFTER_USER_TURNS: undefined,
      NODE_ENV: 'development',
    },
    () => {
      const e = loadEnv();
      assert.equal(e.sim.softHandoffAfterUserTurns, null);
      assert.equal(e.sim.hardHandoffAfterUserTurns, null);
    },
  );
});

test('loadEnv: SW_SIM_*_AFTER_USER_TURNS parses valid positive ints', () => {
  withEnvOverrides(
    {
      SW_SIM_SOFT_HANDOFF_AFTER_USER_TURNS: '5',
      SW_SIM_HARD_HANDOFF_AFTER_USER_TURNS: '7',
      NODE_ENV: 'development',
    },
    () => {
      const e = loadEnv();
      assert.equal(e.sim.softHandoffAfterUserTurns, 5);
      assert.equal(e.sim.hardHandoffAfterUserTurns, 7);
    },
  );
});

test('loadEnv: SW_SIM_*_AFTER_USER_TURNS rejects zero / negative / non-integer', () => {
  for (const bad of ['0', '-3', '1.5', 'forever']) {
    withEnvOverrides({ SW_SIM_SOFT_HANDOFF_AFTER_USER_TURNS: bad, NODE_ENV: 'development' }, () => {
      assert.throws(() => loadEnv(), /must be a positive integer/);
    });
  }
});

test('loadEnv: refuses to start in production when ANY SW_SIM_* var is set', () => {
  withEnvOverrides({ SW_SIM_SOFT_HANDOFF_AFTER_USER_TURNS: '5', NODE_ENV: 'production' }, () => {
    assert.throws(() => loadEnv(), /forbidden in production/);
    // Error message names the offending key so the operator can find it.
    try {
      loadEnv();
    } catch (err) {
      assert.match((err as Error).message, /SW_SIM_SOFT_HANDOFF_AFTER_USER_TURNS/);
    }
  });
});

test('loadEnv: production refusal triggers for any SW_SIM_* var, not just known ones', () => {
  // A future or unknown SW_SIM_* var should also block production startup.
  withEnvOverrides({ SW_SIM_FORCE_COUNTRY: 'GB', NODE_ENV: 'production' }, () => {
    assert.throws(() => loadEnv(), /SW_SIM_FORCE_COUNTRY/);
  });
});

test('loadEnv: production refusal does NOT trigger when no SW_SIM_* is set', () => {
  withEnvOverrides(
    {
      SW_SIM_SOFT_HANDOFF_AFTER_USER_TURNS: undefined,
      SW_SIM_HARD_HANDOFF_AFTER_USER_TURNS: undefined,
      NODE_ENV: 'production',
    },
    () => {
      const e = loadEnv();
      assert.equal(e.isProduction, true);
      assert.equal(e.sim.softHandoffAfterUserTurns, null);
    },
  );
});

test('loadEnv: production refusal ignores empty-string SW_SIM_* vars (treated as unset)', () => {
  withEnvOverrides(
    {
      SW_SIM_SOFT_HANDOFF_AFTER_USER_TURNS: '',
      // Also clear HARD in case the dev shell has it set in .env — empty
      // is not "set" for the refusal check.
      SW_SIM_HARD_HANDOFF_AFTER_USER_TURNS: '',
      NODE_ENV: 'production',
    },
    () => {
      // Empty string is not "set" for our purposes — matches the
      // nonEmptyOrDefault / parsePositiveIntegerOptional convention.
      const e = loadEnv();
      assert.equal(e.sim.softHandoffAfterUserTurns, null);
    },
  );
});

test('loadEnv: refuses when SW_SIM_SOFT >= SW_SIM_HARD (nonsense ordering)', () => {
  withEnvOverrides(
    {
      SW_SIM_SOFT_HANDOFF_AFTER_USER_TURNS: '5',
      SW_SIM_HARD_HANDOFF_AFTER_USER_TURNS: '5',
      NODE_ENV: 'development',
    },
    () => {
      assert.throws(() => loadEnv(), /must be less than/);
    },
  );
  withEnvOverrides(
    {
      SW_SIM_SOFT_HANDOFF_AFTER_USER_TURNS: '7',
      SW_SIM_HARD_HANDOFF_AFTER_USER_TURNS: '5',
      NODE_ENV: 'development',
    },
    () => {
      assert.throws(() => loadEnv(), /must be less than/);
    },
  );
});

test('loadEnv: sanity check is only enforced when BOTH SW_SIM_* are set', () => {
  // Soft only — allowed.
  withEnvOverrides(
    {
      SW_SIM_SOFT_HANDOFF_AFTER_USER_TURNS: '5',
      SW_SIM_HARD_HANDOFF_AFTER_USER_TURNS: undefined,
      NODE_ENV: 'development',
    },
    () => {
      const e = loadEnv();
      assert.equal(e.sim.softHandoffAfterUserTurns, 5);
      assert.equal(e.sim.hardHandoffAfterUserTurns, null);
    },
  );
  // Hard only — allowed.
  withEnvOverrides(
    {
      SW_SIM_SOFT_HANDOFF_AFTER_USER_TURNS: undefined,
      SW_SIM_HARD_HANDOFF_AFTER_USER_TURNS: '5',
      NODE_ENV: 'development',
    },
    () => {
      const e = loadEnv();
      assert.equal(e.sim.softHandoffAfterUserTurns, null);
      assert.equal(e.sim.hardHandoffAfterUserTurns, 5);
    },
  );
});

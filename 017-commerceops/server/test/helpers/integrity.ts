import { expect } from 'vitest';
import type { TestEnv } from './env.js';
import { checkIntegrity } from '../../src/modules/integrity/check.js';

export async function expectIntegrity(env: TestEnv, orgId: string) {
  const v = await env.tx(orgId, (tx) => checkIntegrity(tx));
  expect(v, JSON.stringify(v, null, 2)).toEqual([]);
}

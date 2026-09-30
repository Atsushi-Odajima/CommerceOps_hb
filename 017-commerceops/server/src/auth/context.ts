import { z } from 'zod';
import type { Permission, Role } from './permissions.js';

export const OrgSettingsSchema = z.object({
  allocation: z
    .object({
      autoAllocateOnImport: z.boolean().default(false),
      allowPartialAllocation: z.boolean().default(true),
      autoReleaseFullyAllocated: z.boolean().default(true),
    })
    .default({ autoAllocateOnImport: false, allowPartialAllocation: true, autoReleaseFullyAllocated: true }),
  assignment: z
    .object({
      claimTimeoutMinutes: z.number().int().min(5).max(480).default(30),
    })
    .default({ claimTimeoutMinutes: 30 }),
  wave: z
    .object({
      maxFulfillments: z.number().int().min(1).max(500).default(100),
    })
    .default({ maxFulfillments: 100 }),
  shipping: z
    .object({
      defaultCarrier: z.string().max(40).optional(),
      requireTracking: z.boolean().default(true),
    })
    .default({ requireTracking: true }),
});

export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

export function parseOrgSettings(raw: unknown): OrgSettings {
  const r = OrgSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : OrgSettingsSchema.parse({});
}

export interface OrgContext {
  id: string;
  name: string;
  timezone: string;
  isSample: boolean;
  settings: OrgSettings;
}

export interface AuthContext {
  sessionId: string;
  userId: string;
  userName: string;
  email: string;
  csrfToken: string;
  org: OrgContext | null;
  role: Role | null;
  permissions: ReadonlySet<Permission>;
  /** null = 全倉庫 */
  warehouseIds: string[] | null;
}

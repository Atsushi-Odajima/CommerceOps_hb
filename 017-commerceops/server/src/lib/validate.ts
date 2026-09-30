import { z } from 'zod';
import { AppError } from './errors.js';

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      '入力内容に誤りがあります',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export const zId = z.uuid({ message: 'ID の形式が不正です' });
export const IdParams = z.object({ id: zId });
export const zRequestId = z.uuid({ message: 'requestId の形式が不正です' });

/** 前後空白を除去し、空文字は undefined にする */
export const zTrimmed = (max = 500) =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim())
    .transform((s) => (s === '' ? undefined : s));

export const zPage = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

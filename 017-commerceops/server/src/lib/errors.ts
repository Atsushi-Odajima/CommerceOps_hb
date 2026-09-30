export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what = 'データ') => new AppError(404, 'NOT_FOUND', `${what}が見つかりません`);
export const forbidden = (message = 'この操作を行う権限がありません') => new AppError(403, 'FORBIDDEN', message);
export const unauthorized = (message = 'ログインしてください') => new AppError(401, 'UNAUTHORIZED', message);
export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);

/** PostgreSQL のエラーコード判定 */
export function pgCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return undefined;
}

export const isUniqueViolation = (err: unknown) => pgCode(err) === '23505';
export const isRetryableTxError = (err: unknown) => {
  const c = pgCode(err);
  return c === '40001' || c === '40P01';
};

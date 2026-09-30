import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { AppError, badRequest } from './errors.js';
import { uuidv7 } from './uuid.js';

const tooLarge = () => new AppError(413, 'FILE_TOO_LARGE', 'ファイルサイズが上限を超えています');

export interface Upload {
  buffer: Buffer;
  filename: string;
  mimetype: string;
  fields: Record<string, string>;
}

/** multipart/form-data から 1 ファイル + テキストフィールドを読む（サイズ上限は @fastify/multipart の limits） */
export async function readUpload(req: FastifyRequest): Promise<Upload> {
  if (!req.isMultipart()) throw badRequest('NOT_MULTIPART', 'ファイルを添付してください（multipart/form-data）');
  const fields: Record<string, string> = {};
  let file: { buffer: Buffer; filename: string; mimetype: string } | null = null;
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      if (file) {
        // 2 つ目以降のファイルは読み捨て
        await part.toBuffer().catch(() => undefined);
        continue;
      }
      const buffer = await part.toBuffer();
      if (part.file.truncated) throw tooLarge();
      // ファイル名はパス要素を除去して表示用にのみ使う（保存パスには使わない）
      const filename = (part.filename || 'upload').split(/[\\/]/).pop()!.slice(0, 200);
      file = { buffer, filename, mimetype: part.mimetype };
    } else {
      const v = part.value;
      if (typeof v === 'string' && v.length <= 10_000) fields[part.fieldname] = v;
    }
  }
  if (!file) throw badRequest('NO_FILE', 'ファイルが添付されていません');
  if (file.buffer.length === 0) throw badRequest('EMPTY_FILE', 'ファイルが空です');
  return { ...file, fields };
}

export interface FileUpload {
  /** サーバー生成の一時ファイル（呼び出し側で必ず削除する） */
  path: string;
  filename: string;
  size: number;
  fields: Record<string, string>;
}

/**
 * 大きなファイル（バックアップ等）を、メモリに載せずに一時ファイルへ書き出す。
 * 一時ファイル名はサーバーで生成（アップロードされたファイル名は表示用にのみ使う）。上限を超えたら削除して 413。
 */
export async function readUploadToFile(req: FastifyRequest, opts: { maxBytes: number; dir: string }): Promise<FileUpload> {
  if (!req.isMultipart()) throw badRequest('NOT_MULTIPART', 'ファイルを添付してください（multipart/form-data）');
  await mkdir(opts.dir, { recursive: true, mode: 0o700 });
  const fields: Record<string, string> = {};
  let file: FileUpload | null = null;
  const written: string[] = [];
  try {
    for await (const part of req.parts({ limits: { fileSize: opts.maxBytes, files: 1 } })) {
      if (part.type === 'file') {
        const path = join(opts.dir, `${uuidv7()}.upload`);
        written.push(path);
        await pipeline(part.file, createWriteStream(path, { mode: 0o600 }));
        if (part.file.truncated) throw tooLarge();
        file = { path, filename: (part.filename || 'upload').split(/[\\/]/).pop()!.slice(0, 200), size: (await stat(path)).size, fields };
      } else {
        const v = part.value;
        if (typeof v === 'string' && v.length <= 10_000) fields[part.fieldname] = v;
      }
    }
    if (!file) throw badRequest('NO_FILE', 'ファイルが添付されていません');
    if (file.size === 0) throw badRequest('EMPTY_FILE', 'ファイルが空です');
    return file;
  } catch (e) {
    for (const p of written) await rm(p, { force: true });
    throw e;
  }
}

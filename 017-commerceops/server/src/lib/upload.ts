import type { FastifyRequest } from 'fastify';
import { badRequest } from './errors.js';

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
      if (part.file.truncated) throw badRequest('FILE_TOO_LARGE', 'ファイルサイズが上限を超えています');
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

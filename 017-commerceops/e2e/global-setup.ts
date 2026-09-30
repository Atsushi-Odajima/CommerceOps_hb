import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bwipjs from 'bwip-js';
import { PNG } from 'pngjs';

export const CAMERA_JAN = '4901234567894';
const here = dirname(fileURLToPath(import.meta.url));

/**
 * 擬似カメラ用の映像（Y4M）を作る: 実在形式の EAN-13（JAN）を bwip-js で描画し、640x480 のグレースケール映像にする。
 * Chromium の --use-file-for-fake-video-capture でカメラとして流し、画面のカメラ読取（ZXing）で読めることを確かめる。
 */
export default async function globalSetup() {
  const png = PNG.sync.read(await bwipjs.toBuffer({ bcid: 'ean13', text: CAMERA_JAN, scale: 3, height: 22, includetext: true, paddingwidth: 10, paddingheight: 10, backgroundcolor: 'FFFFFF' }));
  const W = 640;
  const H = 480;
  const y = Buffer.alloc(W * H, 235);
  const ox = Math.floor((W - png.width) / 2);
  const oy = Math.floor((H - png.height) / 2);
  for (let r = 0; r < png.height; r++) {
    for (let c = 0; c < png.width; c++) {
      const i = (r * png.width + c) * 4;
      const lum = Math.round(0.299 * png.data[i]! + 0.587 * png.data[i + 1]! + 0.114 * png.data[i + 2]!);
      const yy = r + oy;
      const xx = c + ox;
      if (yy >= 0 && yy < H && xx >= 0 && xx < W) y[yy * W + xx] = 16 + Math.round((lum / 255) * 219);
    }
  }
  const uv = Buffer.alloc((W / 2) * (H / 2), 128);
  const frames: Buffer[] = [Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`)];
  for (let f = 0; f < 10; f++) frames.push(Buffer.from('FRAME\n'), y, uv, uv);
  mkdirSync(join(here, 'test-results'), { recursive: true });
  writeFileSync(join(here, 'test-results/fake-camera.y4m'), Buffer.concat(frames));
}

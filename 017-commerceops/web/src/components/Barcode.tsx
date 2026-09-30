import { useEffect, useState } from 'react';

type Kind = 'code128' | 'qrcode' | 'ean13';

let bwipPromise: Promise<typeof import('bwip-js/browser')> | null = null;
const loadBwip = () => (bwipPromise ??= import('bwip-js/browser'));

/** バーコード/QR を SVG で生成し <img> で表示（生成はブラウザ内。外部サービスへ送らない） */
export function Barcode({
  value,
  kind = 'code128',
  height = 12,
  scale = 2,
  showText = true,
  label,
}: {
  value: string;
  kind?: Kind;
  height?: number;
  scale?: number;
  showText?: boolean;
  label?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadBwip()
      .then((mod) => {
        const bwip = (mod as any).default ?? mod;
        // QR は height / テキスト系オプションを受け付けない（undefined を渡すと bwipp.invalidOptionType）
        const opts: Record<string, unknown> =
          kind === 'qrcode'
            ? { bcid: kind, text: value, scale }
            : { bcid: kind, text: value, scale, height, includetext: showText, textxalign: 'center', textsize: 9 };
        const svg: string = bwip.toSVG(opts);
        const url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
        if (alive) setSrc(url);
      })
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [value, kind, height, scale, showText]);
  if (error) return <span className="small muted">[{value}]</span>;
  if (!src) return <span className="small muted">…</span>;
  return <img src={src} alt={label ?? `${kind === 'qrcode' ? 'QR' : 'バーコード'}: ${value}`} style={{ maxWidth: '100%' }} />;
}

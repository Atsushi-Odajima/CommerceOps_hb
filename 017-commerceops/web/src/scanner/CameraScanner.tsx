import { useEffect, useRef, useState } from 'react';

/**
 * カメラでバーコード/QR を読む。
 * 1) ネイティブ BarcodeDetector（Android Chrome 等）  2) 非対応（iOS Safari 等）は @zxing/browser
 * 画像は端末内で処理し、外部の画像認識 API には送らない。
 * 対応済みと表記するシンボル: EAN-13(JAN) / EAN-8 / UPC-A / Code128 / Code39 / ITF（14 桁 = ITF-14）/ QR（ZXing で自動テスト済み: TEST_REPORT.md）
 * ITF はチェック文字がなく、斜めに読むと一部だけの短い値を返すことがある（テストで確認）ため 14 桁未満は採用しない。
 */
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'code_128', 'code_39', 'itf', 'qr_code'];

export function CameraScanner({ onDetected, onClose }: { onDetected: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<string>('');
  const last = useRef<{ code: string; at: number }>({ code: '', at: 0 });

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let raf = 0;
    let zxingControls: { stop: () => void } | null = null;

    const emit = (code: string) => {
      const now = Date.now();
      // 同じコードの連続検出（1.5 秒以内）は 1 回として扱う（数量の二重加算を防ぐ）
      if (code === last.current.code && now - last.current.at < 1500) return;
      last.current = { code, at: now };
      onDetected(code);
    };

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('この端末・ブラウザではカメラを利用できません。ハンディスキャナか手入力を使ってください。');
        return;
      }
      const BD = (window as any).BarcodeDetector;
      let nativeOk = false;
      if (BD) {
        try {
          const supported: string[] = await BD.getSupportedFormats();
          nativeOk = NATIVE_FORMATS.some((f) => supported.includes(f));
        } catch {
          nativeOk = false;
        }
      }
      try {
        if (nativeOk) {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
          if (stopped) return;
          const video = videoRef.current!;
          video.srcObject = stream;
          await video.play();
          const supported: string[] = await BD.getSupportedFormats();
          const detector = new BD({ formats: NATIVE_FORMATS.filter((f) => supported.includes(f)) });
          setEngine('BarcodeDetector');
          const loop = async () => {
            if (stopped) return;
            try {
              const codes: { rawValue?: string; format?: string }[] = await detector.detect(video);
              const hit = codes.find((c) => c.rawValue && !(c.format === 'itf' && String(c.rawValue).length < 14));
              if (hit) emit(String(hit.rawValue));
            } catch {
              /* フレーム取得失敗は無視 */
            }
            raf = requestAnimationFrame(() => void loop());
          };
          void loop();
        } else {
          const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
          const hints = new Map();
          hints.set(DecodeHintType.POSSIBLE_FORMATS, [
            BarcodeFormat.EAN_13,
            BarcodeFormat.EAN_8,
            BarcodeFormat.UPC_A,
            BarcodeFormat.CODE_128,
            BarcodeFormat.CODE_39,
            BarcodeFormat.ITF,
            BarcodeFormat.QR_CODE,
          ]);
          hints.set(DecodeHintType.TRY_HARDER, true);
          hints.set(DecodeHintType.ALLOWED_LENGTHS, [14]); // ITF の部分読み（短い値）を採用しない
          const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 150, delayBetweenScanSuccess: 600 });
          setEngine('ZXing');
          zxingControls = await reader.decodeFromConstraints(
            { video: { facingMode: { ideal: 'environment' } }, audio: false },
            videoRef.current!,
            (result) => {
              if (result && !stopped) emit(result.getText());
            },
          );
          if (stopped) zxingControls.stop();
        }
      } catch (e) {
        const name = (e as Error).name;
        setError(
          name === 'NotAllowedError'
            ? 'カメラの使用が許可されていません。ブラウザの設定で許可するか、ハンディスキャナ・手入力を使ってください。'
            : 'カメラを起動できませんでした。ハンディスキャナか手入力を使ってください。',
        );
      }
    };
    void start();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      zxingControls?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onDetected]);

  return (
    <div className="modal-backdrop" style={{ alignItems: 'stretch' }}>
      <div className="modal" style={{ maxWidth: 520, alignSelf: 'center' }} role="dialog" aria-modal="true" aria-label="カメラで読み取り">
        <div className="modal-header">
          <h2>カメラで読み取り</h2>
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        <div className="modal-body">
          {error ? (
            <div className="alert warning">{error}</div>
          ) : (
            <>
              <div className="camera-view">
                <video ref={videoRef} playsInline muted autoPlay />
                <div className="guide" />
              </div>
              <p className="small muted" style={{ marginTop: 8 }}>
                枠内にバーコードを合わせてください（{engine || '起動中…'}）。同じコードは 1.5 秒以内に 1 回だけ読み取ります。
              </p>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-block" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

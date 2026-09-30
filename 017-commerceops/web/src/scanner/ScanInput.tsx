import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { CameraScanner } from './CameraScanner';
import { unlockAudio } from './feedback';
import { IconCamera } from '../components/icons';

export type InputMethod = 'camera' | 'scanner' | 'manual';

export interface ScanInputHandle {
  focus: () => void;
}

/**
 * バーコード入力欄。
 * - キーボード型ハンディスキャナ: 高速入力 + Enter を「scanner」として受け付ける
 * - 手入力: 人がタイプして Enter / 確定ボタン（fallback 必須）
 * - カメラ: ボタンでカメラを起動
 */
export const ScanInput = forwardRef<ScanInputHandle, {
  label: string;
  placeholder?: string;
  onScan: (code: string, method: InputMethod) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
}>(function ScanInput({ label, placeholder, onScan, disabled, autoFocus = true, id = 'scan-input' }, ref) {
  const [value, setValue] = useState('');
  const [camera, setCamera] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const firstKeyAt = useRef<number>(0);
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }));

  const submit = () => {
    const code = value.trim();
    if (!code) return;
    // 1 文字目から Enter までが短時間なら（人の手入力ではない）ハンディスキャナと判定
    const elapsed = Date.now() - firstKeyAt.current;
    const method: InputMethod = code.length >= 4 && elapsed < 60 * code.length && elapsed < 800 ? 'scanner' : 'manual';
    setValue('');
    firstKeyAt.current = 0;
    onScan(code, method);
  };

  const onDetected = useCallback(
    (code: string) => {
      setCamera(false);
      onScan(code, 'camera');
      setTimeout(() => inputRef.current?.focus(), 50);
    },
    [onScan],
  );

  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <form
        className="scan-box"
        onSubmit={(e) => {
          e.preventDefault();
          unlockAudio();
          submit();
        }}
      >
        <input
          id={id}
          ref={inputRef}
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="done"
          placeholder={placeholder ?? 'スキャン または 手入力して Enter'}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => {
            if (!value && e.target.value) firstKeyAt.current = Date.now();
            setValue(e.target.value);
          }}
        />
        <button type="submit" className="btn btn-primary" disabled={disabled || !value.trim()}>
          確定
        </button>
        <button
          type="button"
          className="btn"
          disabled={disabled}
          onClick={() => {
            unlockAudio();
            setCamera(true);
          }}
          aria-label="カメラで読み取る"
        >
          <IconCamera />
        </button>
      </form>
      {camera && <CameraScanner onDetected={onDetected} onClose={() => setCamera(false)} />}
    </div>
  );
});

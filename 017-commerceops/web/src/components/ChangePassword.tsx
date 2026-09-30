import { useState } from 'react';
import { post } from '../api/client';
import { ErrorBox, Field, Modal, useToast } from './ui';

/** 自分のパスワード変更（他の端末のログインは終了し、この端末はそのまま使える） */
export function ChangePasswordButton({ className = 'btn btn-sm' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={className} onClick={() => setOpen(true)}>
        パスワード変更
      </button>
      {open && <ChangePasswordModal onClose={() => setOpen(false)} />}
    </>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && next !== confirm;
  return (
    <Modal
      title="パスワード変更"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !current || next.length < 10 || next !== confirm}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await post('/auth/change-password', { currentPassword: current, newPassword: next });
                toast.success('パスワードを変更しました（他の端末のログインは終了しました）');
                onClose();
              } catch (e) {
                setErr(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            変更する
          </button>
        </>
      }
    >
      <ErrorBox error={err} />
      <Field label="現在のパスワード" htmlFor="pw-current">
        <input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="新しいパスワード" htmlFor="pw-new" hint="10 文字以上。推測されやすいものは使えません">
        <input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="新しいパスワード（確認）" htmlFor="pw-confirm" error={mismatch ? '新しいパスワードと一致しません' : undefined}>
        <input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
    </Modal>
  );
}

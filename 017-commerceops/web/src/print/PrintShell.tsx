import type { ReactNode } from 'react';

/** 印刷用ページの共通枠（ブラウザの印刷で紙/PDF保存） */
export function PrintShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ background: '#fff', minHeight: '100%' }}>
      <div className="print-toolbar no-print">
        <strong style={{ alignSelf: 'center' }}>{title}</strong>
        <button className="btn btn-primary" onClick={() => window.print()}>
          印刷 / PDF保存
        </button>
        <button className="btn" onClick={() => window.close()}>
          閉じる
        </button>
      </div>
      <div className="print-page">{children}</div>
    </div>
  );
}

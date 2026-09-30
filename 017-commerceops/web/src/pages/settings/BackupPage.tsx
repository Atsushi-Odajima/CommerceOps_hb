import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api, download, get } from '../../api/client';
import { useAuth, useMe } from '../../auth/AuthContext';
import { Badge, ConfirmDialog, EmptyState, ErrorBox, Field, Loading, useToast } from '../../components/ui';
import { fmtDateTime, fmtNum } from '../../lib/format';
import { BACKUP_TABLE_LABEL, ROLE_OPTIONS } from '../../lib/labels';

interface VerifyResult {
  ok: boolean;
  errors: string[];
  header: { organizationName: string; createdAt: string; schemaVersion: number; appVersion: string; isSample: boolean } | null;
  counts: Record<string, number>;
  users: number;
  files: number;
  sha256: string | null;
}

interface RestoreResult {
  organizationId: string;
  name: string;
  counts: Record<string, number>;
  users: { restored: number; created: number; matchedByEmail: number; unlinked: number };
  unlinkedUsers: { name: string; email: string; role: string | null }[];
}

const RUN_KIND: Record<string, string> = { export: 'ダウンロード', restore: '復元' };
const RUN_STATUS: Record<string, { label: string; tone: 'success' | 'danger' | 'info' }> = {
  running: { label: '実行中', tone: 'info' },
  succeeded: { label: '成功', tone: 'success' },
  failed: { label: '失敗', tone: 'danger' },
};
const roleLabel = (r: string | null) => ROLE_OPTIONS.find((o) => o.value === r)?.label ?? r ?? '—';

/** 設定 → バックアップ・復元（Owner のみ） */
export default function BackupPage() {
  const me = useMe();
  const { switchOrg } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ['backup-runs'], queryFn: () => get('/backup/runs') });
  const [downloading, setDownloading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<unknown>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);

  const doDownload = async () => {
    setDownloading(true);
    try {
      await download('/backup/export', 'commerceops-backup.ndjson.gz', { method: 'POST', body: {} });
      toast.success('バックアップをダウンロードしました。安全な場所に保管してください');
    } catch (e) {
      toast.error(e);
    } finally {
      setDownloading(false);
      void qc.invalidateQueries({ queryKey: ['backup-runs'] });
    }
  };

  const pick = (f: File | null) => {
    setFile(f);
    setVerify(null);
    setVerifyError(null);
    setResult(null);
    setRestoreError(null);
    setAgree(false);
    setName('');
  };

  const doVerify = async () => {
    if (!file) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const v = await api<VerifyResult>('/backup/verify', { method: 'POST', body: fd });
      setVerify(v);
      if (v.header) setName(`${v.header.organizationName}（復元 ${new Date().toLocaleDateString('sv-SE')}）`);
    } catch (e) {
      setVerifyError(e);
    } finally {
      setVerifying(false);
    }
  };

  const doRestore = async () => {
    if (!file) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const fd = new FormData();
      fd.append('confirm', 'true');
      if (name.trim()) fd.append('name', name.trim());
      fd.append('file', file);
      const r = await api<RestoreResult>('/backup/restore', { method: 'POST', body: fd });
      setResult(r);
      toast.success(`「${r.name}」として復元しました`);
      void qc.invalidateQueries({ queryKey: ['backup-runs'] });
    } catch (e) {
      setRestoreError(e);
    } finally {
      setRestoring(false);
    }
  };

  const totalRows = (c: Record<string, number>) => Object.values(c).reduce((s, n) => s + n, 0);
  const mainCounts = (c: Record<string, number>) => Object.entries(BACKUP_TABLE_LABEL).filter(([t]) => c[t] !== undefined);

  return (
    <>
      <div className="card">
        <div className="card-header">
          <h2>バックアップをダウンロード</h2>
        </div>
        <p>
          組織「{me.organization.name}」のデータを 1 つのファイル（.ndjson.gz）にまとめてダウンロードします。倉庫・ロケーション・商品・販売チャネル・Import Profile・注文と明細・引当・Fulfillment・Wave・Pick/梱包の記録・出荷・返品と検品写真・交換・例外・在庫の動き・監査ログ・ユーザーと権限を含みます。
        </p>
        <ul className="small muted">
          <li>ファイルには作成日時・システムの版・件数・チェックサム（改ざん・破損の検出用）が入ります。パスワードは含みません。</li>
          <li>
            <strong>顧客の氏名・住所・電話・メールを含みます。</strong>社外に送らず、アクセスできる人を限った場所（暗号化されたストレージ等）に保管し、不要になったら削除してください。
          </li>
          <li>ダウンロードしたことは監査ログに記録されます。定期的な取得（例: 毎日の業務終了後）をおすすめします。</li>
        </ul>
        <button className="btn btn-primary" disabled={downloading} onClick={() => void doDownload()}>
          {downloading ? '作成中…（件数が多いと数分かかります）' : 'バックアップをダウンロード'}
        </button>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>バックアップから復元</h2>
        </div>
        <p className="small">
          復元は<strong>新しい組織</strong>として行います。<strong>現在の組織のデータは変更されません。</strong>復元前にファイルを検証し、復元後は件数と整合性（注文 → 出荷 → 返品の参照、在庫と引当の数など）を確認します。問題があれば復元全体を取り消します。
        </p>
        <ol className="steps">
          <li>
            <Field label="バックアップファイル" htmlFor="bk-file" hint="CommerceOps でダウンロードした .ndjson.gz ファイル（ZIP は使えません）。1GB を超える場合はサーバー運用者がコマンドラインで復元します">
              <input
                id="bk-file"
                ref={fileRef}
                type="file"
                accept=".gz,application/gzip"
                onChange={(e) => pick(e.target.files?.[0] ?? null)}
              />
            </Field>
            <button className="btn" disabled={!file || verifying} onClick={() => void doVerify()}>
              {verifying ? '検証中…' : 'ファイルを検証'}
            </button>
            <ErrorBox error={verifyError} />
          </li>
          {verify && (
            <li>
              <div className={`card ${verify.ok ? 'result-ok' : 'result-ng'}`} role="status">
                {verify.ok ? (
                  <p>
                    <strong className="text-success">検証 OK</strong> — 形式・件数・チェックサムに問題はありません。
                  </p>
                ) : (
                  <>
                    <p>
                      <strong className="text-danger">このファイルは復元できません</strong>
                    </p>
                    <ul className="small">
                      {verify.errors.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  </>
                )}
                {verify.header && (
                  <dl className="kv small">
                    <dt>組織</dt>
                    <dd>
                      {verify.header.organizationName} {verify.header.isSample && <Badge tone="warning">サンプル</Badge>}
                    </dd>
                    <dt>作成日時</dt>
                    <dd>{fmtDateTime(verify.header.createdAt)}</dd>
                    <dt>版</dt>
                    <dd>
                      データ v{verify.header.schemaVersion} / アプリ {verify.header.appVersion}
                    </dd>
                    <dt>件数</dt>
                    <dd>
                      合計 {fmtNum(totalRows(verify.counts))} 行・ユーザー {verify.users} 人・写真 {verify.files} 件
                    </dd>
                    {verify.sha256 && (
                      <>
                        <dt>SHA-256</dt>
                        <dd className="mono tiny">{verify.sha256}</dd>
                      </>
                    )}
                  </dl>
                )}
                {verify.ok && (
                  <details>
                    <summary className="small">内訳を表示</summary>
                    <table className="table">
                      <tbody>
                        {mainCounts(verify.counts).map(([t, label]) => (
                          <tr key={t}>
                            <td>{label}</td>
                            <td className="num">{fmtNum(verify.counts[t])}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
              </div>
            </li>
          )}
          {verify?.ok && !result && (
            <li>
              <Field label="復元後の組織名" htmlFor="bk-name">
                <input id="bk-name" type="text" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
              </Field>
              <label className="choice">
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                新しい組織として復元し、自分がその組織の Owner になることを確認しました（現在の組織は変更されません）
              </label>
              <p className="small muted">
                ユーザーは、あなたが Owner を務める組織のメンバーだけが自動で新しい組織に追加されます。それ以外のユーザーは復元後に一覧で表示するので、必要に応じて招待してください。
              </p>
              <button className="btn btn-primary" disabled={!agree || restoring} onClick={() => setConfirming(true)}>
                {restoring ? '復元中…（件数が多いと数分かかります）' : '新しい組織として復元'}
              </button>
              <ErrorBox error={restoreError} />
            </li>
          )}
        </ol>
        {result && (
          <div className="card result-ok" role="status">
            <h3>復元しました: {result.name}</h3>
            <p className="small">
              合計 {fmtNum(totalRows(result.counts))} 行を復元し、件数と整合性を確認しました。ユーザー: 対応付け {result.users.restored + result.users.matchedByEmail} 人
              {result.users.unlinked > 0 && ` / 未追加 ${result.users.unlinked} 人`}
            </p>
            {result.unlinkedUsers.length > 0 && (
              <>
                <p className="small">次のユーザーは新しい組織に追加していません。必要な場合は、新しい組織の「設定 → ユーザー・権限」から招待してください。</p>
                <table className="table">
                  <thead>
                    <tr>
                      <th>氏名</th>
                      <th>メール</th>
                      <th>元の権限</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.unlinkedUsers.map((u) => (
                      <tr key={u.email}>
                        <td>{u.name}</td>
                        <td>{u.email}</td>
                        <td>{roleLabel(u.role)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <button
              className="btn btn-primary"
              onClick={() =>
                void switchOrg(result.organizationId)
                  .then(() => navigate('/'))
                  .catch((e) => toast.error(e))
              }
            >
              復元した組織に切り替える
            </button>{' '}
            <button
              className="btn"
              onClick={() => {
                pick(null);
                if (fileRef.current) fileRef.current.value = '';
              }}
            >
              閉じる
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h2>実行履歴</h2>
        </div>
        <ErrorBox error={runs.error} />
        {runs.isLoading ? (
          <Loading />
        ) : !runs.data?.items.length ? (
          <EmptyState title="まだバックアップを取得していません" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>日時</th>
                  <th>種類</th>
                  <th>状態</th>
                  <th>ファイル</th>
                  <th>件数</th>
                  <th>実行者</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.items.map((r: any) => (
                  <tr key={r.id}>
                    <td className="nowrap small">{fmtDateTime(r.createdAt)}</td>
                    <td className="nowrap">{RUN_KIND[r.kind] ?? r.kind}</td>
                    <td className="nowrap">
                      <Badge tone={RUN_STATUS[r.status]?.tone}>{RUN_STATUS[r.status]?.label ?? r.status}</Badge>
                      {r.error && <div className="tiny text-danger">{r.error}</div>}
                    </td>
                    <td className="small">
                      {r.filename ?? '—'}
                      {r.fileSha256 && <div className="mono tiny muted" title={r.fileSha256}>SHA-256 {r.fileSha256.slice(0, 16)}…</div>}
                    </td>
                    <td className="num small">{r.manifest?.counts ? fmtNum(totalRows(r.manifest.counts)) : '—'}</td>
                    <td className="small">{r.createdBy ?? 'コマンドライン'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          title="新しい組織として復元しますか？"
          confirmLabel="復元する"
          onClose={() => setConfirming(false)}
          onConfirm={doRestore}
          message={
            <p>
              「{name || verify?.header?.organizationName}」という新しい組織を作成し、バックアップの内容を復元します。現在の組織「{me.organization.name}」は変更されません。件数が多い場合は数分かかります。
            </p>
          }
        />
      )}
    </>
  );
}

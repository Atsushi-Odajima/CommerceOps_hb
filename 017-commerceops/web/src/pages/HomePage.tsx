import { useMe } from '../auth/AuthContext';
import { PageHeader } from '../components/ui';

export default function HomePage() {
  const me = useMe();
  return (
    <>
      <PageHeader title="ホーム" sub={`${me.organization.name} のオペレーション状況`} />
      <div className="card">ダッシュボードは Phase 8 で実装します。</div>
    </>
  );
}

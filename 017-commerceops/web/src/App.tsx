import { Suspense } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { Loading, ToastProvider } from './components/ui';
import { RequireAuth } from './routes/guards';
import { LoginPage } from './pages/auth/LoginPage';
import { PwaProvider } from './pwa/UpdatePrompt';
import { AcceptInvitePage, ResetPasswordPage } from './pages/auth/TokenPages';
import { appRoutes, fieldRoutes, printRoutes } from './routes/appRoutes';

function NoOrganization() {
  const { me, logout } = useAuth();
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 style={{ fontSize: '1.1rem' }}>所属組織がありません</h1>
        <p className="muted">{me?.user.email} はどの組織にも所属していないか、無効化されています。組織のオーナーに招待を依頼してください。</p>
        <button className="btn" onClick={() => void logout()}>
          ログアウト
        </button>
      </div>
    </div>
  );
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/invite', element: <AcceptInvitePage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/no-organization', element: <NoOrganization /> },
  {
    path: '/print',
    element: (
      <RequireAuth>
        <Suspense fallback={<Loading />}>
          <PrintOutlet />
        </Suspense>
      </RequireAuth>
    ),
    children: printRoutes,
  },
  {
    path: '/m',
    element: (
      <RequireAuth>
        <Suspense fallback={<Loading />}>
          <FieldOutlet />
        </Suspense>
      </RequireAuth>
    ),
    children: fieldRoutes,
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [...appRoutes, { path: '*', element: <NotFound /> }],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

import { Outlet } from 'react-router';
function PrintOutlet() {
  return <Outlet />;
}
function FieldOutlet() {
  return <Outlet />;
}

function NotFound() {
  return (
    <div className="card">
      <h2>ページが見つかりません</h2>
      <p className="muted">URL を確認してください。</p>
    </div>
  );
}

export function App() {
  return (
    <PwaProvider>
      <ToastProvider>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </ToastProvider>
    </PwaProvider>
  );
}

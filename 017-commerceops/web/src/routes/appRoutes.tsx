import { lazy, Suspense, type ReactNode } from 'react';
import type { RouteObject } from 'react-router';
import { Loading } from '../components/ui';
import { RequirePerm } from './guards';

const HomePage = lazy(() => import('../pages/HomePage'));

const S = (el: ReactNode) => <Suspense fallback={<Loading />}>{el}</Suspense>;
const P = (perm: string | string[], el: ReactNode) => S(<RequirePerm perm={perm}>{el}</RequirePerm>);
void P;

export const appRoutes: RouteObject[] = [{ index: true, element: S(<HomePage />) }];

export const fieldRoutes: RouteObject[] = [];

export const printRoutes: RouteObject[] = [];

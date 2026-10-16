import { inject } from '@angular/core';
import { Router } from '@angular/router';

import { PortalSession } from './session';

import type { CanActivateFn, Routes } from '@angular/router';

const verified: CanActivateFn = async (_route, state) => {
  const session = inject(PortalSession);
  const router = inject(Router);
  await session.authReady;
  return (
    session.verified() || router.createUrlTree(['/login'], { queryParams: { return: state.url } })
  );
};
const administrator: CanActivateFn = async (route) => {
  const session = inject(PortalSession);
  const router = inject(Router);
  try {
    const member = await session.membership(route.paramMap.get('orgId')!);
    return (
      (session.verified() && member?.['role'] === 'admin' && member?.['status'] === 'active') ||
      router.createUrlTree(['/organizations'])
    );
  } catch {
    return router.createUrlTree(['/organizations']);
  }
};
const viewer = () => import('./viewer.page').then((m) => m.ViewerPage);
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./catalog.pages').then((m) => m.PublicCatalogPage),
  },
  { path: 'login', loadComponent: () => import('./auth.pages').then((m) => m.LoginPage) },
  { path: 'invite', loadComponent: () => import('./auth.pages').then((m) => m.InvitationPage) },
  {
    path: 'organizations',
    canActivate: [verified],
    loadComponent: () => import('./catalog.pages').then((m) => m.OrganizationsPage),
  },
  {
    path: 'organizations/:orgId/scenes',
    canActivate: [verified],
    loadComponent: () => import('./catalog.pages').then((m) => m.SceneCatalogPage),
  },
  { path: 'organizations/:orgId/scenes/:sceneId', canActivate: [verified], loadComponent: viewer },
  {
    path: 'organizations/:orgId/admin',
    canActivate: [verified, administrator],
    loadComponent: () => import('./catalog.pages').then((m) => m.AdminPage),
  },
  {
    path: 'drill-rig',
    canActivate: [verified],
    loadComponent: () => import('./catalog.pages').then((m) => m.DrillEntryPage),
  },
  ...(['base', 'circuit-breaker', 'pressure-gauge'] as const).map((demo) => ({
    path: demo,
    data: { demo },
    loadComponent: viewer,
  })),
  { path: '**', loadComponent: () => import('./catalog.pages').then((m) => m.NotFoundPage) },
];

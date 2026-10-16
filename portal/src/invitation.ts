import { InjectionToken } from '@angular/core';

export type Invitation = { orgId: string; invitationId: string; token: string };
export const INVITATION = new InjectionToken<Invitation | null>('invitation');

// Capture before router startup. The secret remains in memory, never in storage,
// navigation return parameters, analytics, or an HTTP URL/referrer.
export function captureInvitation(): Invitation | null {
  if (location.pathname !== '/invite') return null;
  const values = new URLSearchParams(location.hash.slice(1));
  if (!values.has('token')) return null;
  history.replaceState(history.state, '', location.pathname + location.search);
  const orgId = values.get('orgId') ?? '';
  const invitationId = values.get('invitationId') ?? '';
  const token = values.get('token') ?? '';
  return /^[\w-]{1,128}$/.test(orgId) &&
    /^[\w-]{1,128}$/.test(invitationId) &&
    /^[\w-]{30,64}$/.test(token)
    ? { orgId, invitationId, token }
    : null;
}

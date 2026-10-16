import { InjectionToken } from '@angular/core';

import { parseProductionConfig } from '../../src/contracts/portalConfig';

import type { PortalConfig } from '../../src/contracts/portalConfig';

export const PORTAL_CONFIG = new InjectionToken<PortalConfig>('Portal configuration');
export async function loadPortalConfig(): Promise<PortalConfig> {
  if (['localhost', '127.0.0.1'].includes(location.hostname))
    return {
      mode: 'emulator',
      firebase: {
        apiKey: 'demo-omnipraxis',
        projectId: 'demo-omnipraxis',
        authDomain: 'demo-omnipraxis.firebaseapp.com',
        storageBucket: 'demo-omnipraxis.appspot.com',
        appId: 'demo-portal',
      },
      allowedOrigins: [location.origin],
    };
  const response = await fetch('/portal-config.json', {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error('Portal configuration unavailable.');
  const config = parseProductionConfig(await response.json());
  if (!config.allowedOrigins.includes(location.origin))
    throw new Error('This portal origin is not configured.');
  return config;
}

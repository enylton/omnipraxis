import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { AppComponent } from './app';
import { loadPortalConfig, PORTAL_CONFIG } from './firebase-config';
import { captureInvitation, INVITATION } from './invitation';
import { routes } from './routes';

const invitation = captureInvitation();
void loadPortalConfig()
  .then((config) =>
    bootstrapApplication(AppComponent, {
      providers: [
        provideZonelessChangeDetection(),
        provideRouter(routes, withComponentInputBinding()),
        { provide: INVITATION, useValue: invitation },
        { provide: PORTAL_CONFIG, useValue: config },
      ],
    }),
  )
  .catch(() => {
    const root = document.querySelector('portal-app');
    if (root)
      root.textContent =
        'The portal is temporarily unavailable. Configuration must be completed by the operator.';
  });

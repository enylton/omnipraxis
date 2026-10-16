import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { AppComponent } from './app';
import { captureInvitation, INVITATION } from './invitation';
import { routes } from './routes';

const invitation = captureInvitation();
void bootstrapApplication(AppComponent, {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding()),
    { provide: INVITATION, useValue: invitation },
  ],
});

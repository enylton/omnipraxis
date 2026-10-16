import { Component, inject } from '@angular/core';
import { NavigationStart, Router, RouterLink, RouterOutlet } from '@angular/router';

import { PortalSession, ViewerLease } from './session';

@Component({
  selector: 'portal-app',
  imports: [RouterLink, RouterOutlet],
  template: `
    <header class="topbar">
      <a routerLink="/" class="brand">OMNIPRAXIS<span>Interactive learning</span></a>
      <nav aria-label="Main navigation">
        <a routerLink="/">Demonstrations</a><a routerLink="/organizations">Organizations</a>
        @if (session.user(); as user) {
          <a routerLink="/login">Account</a
          ><button class="quiet" (click)="logout()">Sign out</button>
        } @else {
          <a routerLink="/login">Sign in</a>
        }
      </nav>
    </header>
    <router-outlet />
  `,
})
export class AppComponent {
  readonly session = inject(PortalSession);
  private readonly router = inject(Router);
  private readonly lease = inject(ViewerLease);
  constructor() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) this.lease.close();
    });
  }
  async logout() {
    this.lease.close();
    await this.session.identity.signOut();
    await this.router.navigateByUrl('/login');
  }
}

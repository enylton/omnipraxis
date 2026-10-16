import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { getIdToken, reload } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';

import { INVITATION } from './invitation';
import { friendlyError, PortalSession, safeReturn } from './session';

@Component({
  selector: 'portal-auth-form',
  imports: [FormsModule],
  template: `
    @if (!session.ready()) {
      <p role="status">Checking your account…</p>
    } @else if (!session.user()) {
      <form (ngSubmit)="passwordSignIn()">
        <label
          >Email<input name="email" type="email" autocomplete="email" required [(ngModel)]="email"
        /></label>
        <label
          >Password<input
            name="password"
            type="password"
            autocomplete="current-password"
            minlength="6"
            required
            [(ngModel)]="password"
        /></label>
        <button [disabled]="busy()" type="submit">Sign in</button>
        @if (allowSignup()) {
          <button [disabled]="busy()" type="button" (click)="createAccount()">
            Create invited account
          </button>
        }
      </form>
      <div class="actions">
        <button [disabled]="busy()" (click)="google()">Continue with Google</button
        ><button class="secondary" [disabled]="busy() || !email" (click)="reset()">
          Reset password
        </button>
      </div>
    } @else {
      <p>
        Signed in as <strong>{{ session.user()?.email }}</strong
        >.
      </p>
      @if (!session.verified()) {
        <p>Verify your email before opening an organization or accepting an invitation.</p>
        <div class="actions">
          <button [disabled]="busy()" (click)="verify()">Send verification email</button
          ><button [disabled]="busy()" (click)="refresh()">I have verified my email</button>
        </div>
      }
      <button class="secondary" [disabled]="busy()" (click)="switchAccount()">
        Use another account
      </button>
    }
    @if (message()) {
      <p role="status">{{ message() }}</p>
    }
  `,
})
export class AuthForm {
  readonly session = inject(PortalSession);
  readonly allowSignup = input(false);
  readonly signedIn = output<void>();
  readonly busy = signal(false);
  readonly message = signal('');
  email = '';
  password = '';
  private async run(action: () => Promise<unknown>, success = '') {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set('');
    try {
      await action();
      this.message.set(success);
      if (this.session.auth.currentUser?.emailVerified) this.signedIn.emit();
    } catch (error) {
      this.message.set(friendlyError(error));
    } finally {
      this.busy.set(false);
      this.password = '';
    }
  }
  passwordSignIn() {
    return this.run(() => this.session.identity.signInPassword(this.email.trim(), this.password));
  }
  google() {
    return this.run(() => this.session.identity.signInGoogle());
  }
  createAccount() {
    return this.run(async () => {
      await this.session.identity.createPasswordAccount(this.email.trim(), this.password);
      await this.session.identity.sendVerification();
    }, 'Verification email sent.');
  }
  reset() {
    return this.run(
      () => this.session.identity.sendPasswordReset(this.email.trim()),
      'If this account exists, a reset email has been sent.',
    );
  }
  verify() {
    return this.run(() => this.session.identity.sendVerification(), 'Verification email sent.');
  }
  refresh() {
    return this.run(async () => {
      const user = this.session.auth.currentUser;
      if (user) {
        await reload(user);
        await getIdToken(user, true);
      }
    }, 'Email status refreshed.');
  }
  switchAccount() {
    return this.run(() => this.session.identity.signOut());
  }
}

@Component({
  selector: 'portal-login',
  imports: [AuthForm, FormsModule],
  template: `<section class="panel narrow">
    <p class="eyebrow">Your account</p>
    <h1>Sign in</h1>
    <p>Organization access requires an invitation.</p>
    <portal-auth-form (signedIn)="continue()" />
    @if (session.verified()) {
      <div class="actions">
        <button (click)="continue()">Continue to organizations</button
        ><button class="secondary" [disabled]="busy()" (click)="linkGoogle()">
          Link Google to this account
        </button>
      </div>
      <form (ngSubmit)="setPassword()">
        <label
          >New password<input
            name="newPassword"
            type="password"
            autocomplete="new-password"
            required
            minlength="6"
            [(ngModel)]="password" /></label
        ><button class="secondary" [disabled]="busy()">Set password for this account</button>
      </form>
    }
    @if (message()) {
      <p role="status">{{ message() }}</p>
    }
  </section>`,
})
export class LoginPage {
  readonly session = inject(PortalSession);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly message = signal('');
  readonly busy = signal(false);
  password = '';
  continue() {
    void this.router.navigateByUrl(safeReturn(this.route.snapshot.queryParamMap.get('return')));
  }
  private async change(action: () => Promise<unknown>) {
    this.busy.set(true);
    this.message.set('');
    try {
      await action();
      this.message.set('Account updated. Your organization identity is unchanged.');
    } catch (error) {
      this.message.set(friendlyError(error));
    } finally {
      this.busy.set(false);
      this.password = '';
    }
  }
  linkGoogle() {
    return this.change(() => this.session.identity.linkGoogle());
  }
  setPassword() {
    return this.change(() => this.session.identity.setPassword(this.password));
  }
}

@Component({
  selector: 'portal-invitation',
  imports: [AuthForm],
  template: `<section class="panel narrow">
    <p class="eyebrow">Organization invitation</p>
    <h1>Join your organization</h1>
    @if (!invitation) {
      <p role="alert">
        Reopen the original invitation link. The invitation secret is only kept while this page is
        open.
      </p>
    } @else {
      <p>Sign in with the email address that received this invitation.</p>
      <portal-auth-form [allowSignup]="true" />
      @if (session.verified()) {
        <button [disabled]="busy()" (click)="accept()">Accept invitation</button>
      }
    }
    @if (message()) {
      <p role="alert">{{ message() }}</p>
    }
  </section>`,
})
export class InvitationPage {
  readonly invitation = inject(INVITATION);
  readonly session = inject(PortalSession);
  private readonly router = inject(Router);
  readonly message = signal('');
  readonly busy = signal(false);
  async accept() {
    if (!this.invitation || this.busy()) return;
    this.busy.set(true);
    this.message.set('');
    try {
      await httpsCallable(this.session.functions, 'acceptInvitation')(this.invitation);
      await this.router.navigate(['/organizations', this.invitation.orgId, 'scenes']);
    } catch (error) {
      this.message.set(friendlyError(error));
    } finally {
      this.busy.set(false);
    }
  }
}

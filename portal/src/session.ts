import { computed, Injectable, signal } from '@angular/core';
import { initializeApp } from 'firebase/app';
import {
  browserSessionPersistence,
  getAuth,
  onIdTokenChanged,
  setPersistence,
  connectAuthEmulator,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getDocFromServer,
  getFirestore,
  onSnapshot,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';

import { firebaseConfig } from './firebase-config';
import { createIdentity } from '../../src/adapters/firebase/identity';

type Identity = { uid: string; email: string | null; verified: boolean };
export type Organization = { id: string; name: string; role: 'admin' | 'viewer' };

@Injectable({ providedIn: 'root' })
export class ViewerLease {
  private active?: () => void;
  close() {
    const stop = this.active;
    this.active = undefined;
    stop?.();
  }
  claim(stop: () => void) {
    this.close();
    this.active = stop;
    return () => {
      if (this.active === stop) this.active = undefined;
    };
  }
}

@Injectable({ providedIn: 'root' })
export class PortalSession {
  private readonly app = initializeApp(firebaseConfig, 'portal');
  readonly auth = getAuth(this.app);
  readonly db = getFirestore(this.app);
  readonly functions = getFunctions(this.app, 'us-central1');
  readonly storage = getStorage(this.app);
  readonly identity = createIdentity(this.auth);
  readonly user = signal<Identity | null>(null);
  readonly uid = computed(() => this.user()?.uid ?? null);
  readonly verified = computed(() => this.user()?.verified ?? false);
  readonly ready = signal(false);
  readonly downloadsEnabled = signal(false);
  readonly serviceReady = signal(false);
  private authResolved!: () => void;
  readonly authReady = new Promise<void>((resolve) => {
    this.authResolved = resolve;
  });
  private serviceResolved!: () => void;
  readonly availabilityReady = new Promise<void>((resolve) => {
    this.serviceResolved = resolve;
  });

  constructor() {
    if (!['localhost', '127.0.0.1'].includes(location.hostname))
      throw new Error('This portal build requires local demo emulators.');
    connectAuthEmulator(this.auth, 'http://127.0.0.1:9199', { disableWarnings: true });
    connectFirestoreEmulator(this.db, '127.0.0.1', 8280);
    connectFunctionsEmulator(this.functions, '127.0.0.1', 5101);
    connectStorageEmulator(this.storage, '127.0.0.1', 9399);
    void setPersistence(this.auth, browserSessionPersistence).then(() => {
      onIdTokenChanged(this.auth, (user) => {
        this.user.set(
          user ? { uid: user.uid, email: user.email, verified: user.emailVerified } : null,
        );
        this.ready.set(true);
        this.authResolved();
      });
    });
    onSnapshot(
      doc(this.db, 'publicSettings/delivery'),
      { includeMetadataChanges: true },
      (snapshot) => {
        if (snapshot.metadata.fromCache) return;
        this.downloadsEnabled.set(snapshot.exists() && snapshot.get('downloadsEnabled') === true);
        this.serviceReady.set(true);
        this.serviceResolved();
      },
      () => {
        this.downloadsEnabled.set(false);
        this.serviceReady.set(true);
        this.serviceResolved();
      },
    );
  }

  async organizations(after?: string) {
    return (
      await httpsCallable<
        { after?: string },
        { organizations: Organization[]; next: string | null }
      >(
        this.functions,
        'listMyOrganizations',
      )(after ? { after } : {})
    ).data;
  }
  async membership(orgId: string) {
    await this.authReady;
    if (!this.uid()) return null;
    const docValue = await getDocFromServer(
      doc(this.db, 'organizations', orgId, 'members', this.uid()!),
    );
    return docValue.exists() ? docValue.data() : null;
  }
}

export function safeReturn(value: string | null) {
  return value?.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !value.startsWith('/login')
    ? value
    : '/organizations';
}
export function friendlyError(error: unknown) {
  const code = (error as { code?: string })?.code ?? '';
  if (
    code.includes('invalid-credential') ||
    code.includes('wrong-password') ||
    code.includes('user-not-found')
  )
    return 'Check your email and password and try again.';
  if (
    code.includes('email-already-in-use') ||
    code.includes('account-exists-with-different-credential')
  )
    return 'Use your existing sign-in method, then link your account from Account.';
  if (code.includes('popup-closed') || code.includes('cancelled-popup'))
    return 'Sign-in was cancelled. You can try again.';
  if (code.includes('popup-blocked')) return 'Allow the sign-in popup, then try again.';
  if (code.includes('requires-recent-login'))
    return 'Sign out and sign in again before changing credentials.';
  if (code.includes('permission-denied') || code.includes('unauthenticated'))
    return 'Access denied. Check your account or ask your administrator.';
  if (code.includes('failed-precondition'))
    return 'This invitation is expired, revoked, or already used. Ask your administrator for help.';
  return 'The request could not be completed. Please try again.';
}

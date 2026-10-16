import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  linkWithPopup,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updatePassword,
} from 'firebase/auth';

import type { Auth } from 'firebase/auth';

// Identity creation grants no membership. Invitation acceptance is server-authorized.
// The caller owns Auth initialization, emulator connection, and recovery UI.
export function createIdentity(auth: Auth) {
  function signedIn() {
    if (!auth.currentUser) throw new Error('Sign in first.');
    return auth.currentUser;
  }
  return {
    createPasswordAccount: (email: string, password: string) =>
      createUserWithEmailAndPassword(auth, email, password),
    signInPassword: (email: string, password: string) =>
      signInWithEmailAndPassword(auth, email, password),
    signInGoogle: () => signInWithPopup(auth, new GoogleAuthProvider()),
    linkGoogle: () => linkWithPopup(signedIn(), new GoogleAuthProvider()),
    setPassword: async (password: string) => {
      const user = signedIn();
      if (!user.email || !user.emailVerified)
        throw new Error('A verified email identity is required.');
      // Mutate only this signed-in UID; Firebase requires recent authentication.
      await updatePassword(user, password);
      await reload(user);
      return user;
    },
    sendVerification: () => sendEmailVerification(signedIn()),
    sendPasswordReset: (email: string) => sendPasswordResetEmail(auth, email),
    signOut: () => signOut(auth),
  };
}

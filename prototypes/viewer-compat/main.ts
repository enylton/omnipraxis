import { deleteApp, initializeApp } from 'firebase/app';
import { connectFirestoreEmulator, doc, getDoc, getFirestore, terminate } from 'firebase/firestore';
import { connectStorageEmulator, getBlob, getStorage, ref } from 'firebase/storage';

import { resolveStorageAssets } from '../../src/adapters/firebase/sceneAssets';
import './style.css';

type ViewerModule = typeof import('../../src/viewer/index');

const projectId = 'demo-omnipraxis-viewer';
const identity = document.querySelector<HTMLSelectElement>('#identity')!;
const scene = document.querySelector<HTMLSelectElement>('#scene')!;
const status = document.querySelector<HTMLOutputElement>('#status')!;
const host = document.querySelector<HTMLElement>('#viewer')!;
let active: { dispose: () => void } | undefined;
let abort = new AbortController();
const clients = new Map<string, ReturnType<typeof createClient>>();

function createClient(uid: string) {
  const app = initializeApp(
    { projectId, apiKey: 'emulator-only', storageBucket: `${projectId}.appspot.com` },
    `viewer-${uid}`,
  );
  const db = getFirestore(app);
  const storage = getStorage(app);
  const mockUserToken =
    uid === 'anonymous'
      ? undefined
      : {
          sub: uid === 'unverified' ? 'assigned' : uid,
          email_verified: uid !== 'unverified',
        };
  connectFirestoreEmulator(db, '127.0.0.1', 8180, { mockUserToken });
  connectStorageEmulator(storage, '127.0.0.1', 9299, { mockUserToken });
  return { app, db, storage };
}

const close = () => {
  abort.abort();
  active?.dispose();
  active = undefined;
  status.value = 'Closed';
};

const open = async () => {
  close();
  abort = new AbortController();
  const signal = abort.signal;
  status.value = 'Loading';
  // Firebase belongs to the host application, not each mounted scene session.
  if (!clients.has(identity.value)) clients.set(identity.value, createClient(identity.value));
  const { db, storage } = clients.get(identity.value)!;
  try {
    const path =
      scene.value === 'circuit-breaker'
        ? `publicScenes/${scene.value}`
        : `organizations/viewer/scenes/${scene.value}/revisions/r1`;
    const snapshot = await getDoc(doc(db, path));
    if (!snapshot.exists()) throw new Error('Missing scene fixture. Run pnpm viewer:seed first.');
    const descriptor =
      scene.value === 'circuit-breaker' ? snapshot.data().descriptor : snapshot.data();
    const assets = await resolveStorageAssets(
      {
        read: (path, maxBytes) => getBlob(ref(storage, path), maxBytes),
        page: (path) =>
          `http://127.0.0.1:9299/v0/b/${storage.app.options.storageBucket}/o/${encodeURIComponent(path)}?alt=media`,
        liveHeaders: async () => ({ value: {}, dispose: () => {} }),
      },
      descriptor,
      signal,
    );
    if (signal.aborted) {
      assets.dispose();
      return;
    }
    // This URL intentionally imports the built ESM artifact, not TSX source.
    const viewerUrl = '/build/viewer/viewer.js';
    const { mountViewer, VIEWER_API_VERSION } = (await import(
      /* @vite-ignore */ viewerUrl
    )) as ViewerModule;
    if (signal.aborted) {
      assets.dispose();
      return;
    }
    if (VIEWER_API_VERSION !== 1) {
      assets.dispose();
      throw new Error('This host requires viewer API v1.');
    }
    active = mountViewer(host, {
      apiVersion: 1,
      scene: assets.scene,
      releaseAssets: assets.dispose,
      onReady: () => {
        if (!signal.aborted) status.value = 'Ready';
      },
      onError: (error: Error) => {
        if (!signal.aborted) status.value = `Error: ${error.message}`;
      },
    });
  } catch (error) {
    if (!signal.aborted)
      status.value = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
};

document.querySelector('#open')!.addEventListener('click', () => void open());
document.querySelector('#close')!.addEventListener('click', close);
window.addEventListener('pagehide', () => {
  close();
  for (const { app, db } of clients.values()) void terminate(db).then(() => deleteApp(app));
});

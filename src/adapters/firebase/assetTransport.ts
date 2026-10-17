import { getToken } from 'firebase/app-check';
import { getIdToken } from 'firebase/auth';

import type { AppCheck } from 'firebase/app-check';
import type { Auth } from 'firebase/auth';

export type AssetTransport = {
  read: (path: string, maxBytes: number, signal: AbortSignal) => Promise<Blob>;
  page: (path: string) => string;
  headers: () => Promise<Record<string, string>>;
};

export function assetTransport(
  projectId: string,
  auth: Auth,
  appCheck: AppCheck | null,
  emulator: boolean,
): AssetTransport {
  const base = emulator
    ? `http://127.0.0.1:5101/${projectId}/us-central1/deliverAsset`
    : `https://us-central1-${projectId}.cloudfunctions.net/deliverAsset`;
  const page = (path: string) => `${base}?path=${encodeURIComponent(path)}`;
  const headers = async () => {
    const result: Record<string, string> = {};
    if (auth.currentUser) result['Authorization'] = `Bearer ${await getIdToken(auth.currentUser)}`;
    if (!emulator) {
      if (!appCheck) throw new Error('App Check is not configured for asset delivery.');
      result['X-Firebase-AppCheck'] = (await getToken(appCheck)).token;
    }
    return result;
  };
  return {
    page,
    headers,
    async read(path, maxBytes, signal) {
      const response = await fetch(page(path), {
        headers: await headers(),
        signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Scene asset is unavailable.');
      const length = Number(response.headers.get('Content-Length'));
      if (!Number.isSafeInteger(length) || length <= 0 || length > maxBytes)
        throw new Error('Scene asset exceeds its declared size.');
      const blob = await response.blob();
      if (blob.size !== length) throw new Error('Scene asset length changed during download.');
      return blob;
    },
  };
}

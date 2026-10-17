import { pipeline } from 'node:stream/promises';

import type { AppCheck } from 'firebase-admin/app-check';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { getStorage } from 'firebase-admin/storage';
import type { Request, Response } from 'firebase-functions/v2/https';

type Bucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;
type Asset = { path: string; bytes: number; generation: string };
const origins = new Set([
  'https://omnipraxis.efluxa.com',
  'https://omnipraxis-f8141.web.app',
  'https://omnipraxis-f8141.firebaseapp.com',
]);
const demoEmulator = () =>
  process.env['GCLOUD_PROJECT'] === 'demo-omnipraxis' &&
  process.env['FIRESTORE_EMULATOR_HOST'] === '127.0.0.1:8280';
const id = '[A-Za-z0-9_-]{1,100}';
const publicPath = new RegExp(`^public-scenes/(${id})/revisions/(${id})/([A-Za-z0-9_./-]+)$`);
const privatePath = new RegExp(
  `^organizations/(${id})/scenes/(${id})/revisions/(${id})/([A-Za-z0-9_./-]+)$`,
);

export function parseAssetPath(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return null;
  const publicMatch = publicPath.exec(value);
  if (publicMatch)
    return {
      kind: 'public' as const,
      scene: publicMatch[1],
      revision: publicMatch[2],
      path: value,
    };
  const privateMatch = privatePath.exec(value);
  if (privateMatch)
    return {
      kind: 'private' as const,
      org: privateMatch[1],
      scene: privateMatch[2],
      revision: privateMatch[3],
      path: value,
    };
  return null;
}

export function parseRange(header: string | undefined, bytes: number) {
  if (!header) return { start: 0, end: bytes - 1, partial: false };
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : bytes - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= bytes)
    return null;
  return { start, end, partial: true };
}

export function assetDelivery(db: Firestore, auth: Auth, appCheck: AppCheck, bucket: Bucket) {
  return async (request: Request, response: Response) => {
    response.set('Cache-Control', 'no-store');
    response.set('Vary', 'Origin');
    response.set('X-Content-Type-Options', 'nosniff');
    const origin = request.get('Origin');
    if (
      origin &&
      !origins.has(origin) &&
      !(demoEmulator() && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
    ) {
      response.status(403).end();
      return;
    }
    if (origin) response.set('Access-Control-Allow-Origin', origin);
    response.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.set('Access-Control-Allow-Headers', 'Authorization, X-Firebase-AppCheck, Range');
    response.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.status(405).end();
      return;
    }
    const path = parseAssetPath(request.query['path']);
    if (!path) {
      response.status(400).end();
      return;
    }
    try {
      if (!demoEmulator()) {
        const token = request.get('X-Firebase-AppCheck');
        if (!token) {
          response.status(401).end();
          return;
        }
        await appCheck.verifyToken(token);
      }
      const delivery = await db.doc('publicSettings/delivery').get();
      if (delivery.get('downloadsEnabled') !== true) {
        response.status(403).end();
        return;
      }
      const sceneRef =
        path.kind === 'public'
          ? db.doc(`publicScenes/${path.scene}`)
          : db.doc(`organizations/${path.org}/scenes/${path.scene}`);
      const scene = await sceneRef.get();
      if (!scene.exists) {
        response.status(404).end();
        return;
      }
      let adminPreview = false;
      if (path.kind === 'private') {
        const bearer = /^Bearer (\S+)$/.exec(request.get('Authorization') ?? '');
        if (!bearer) {
          response.status(401).end();
          return;
        }
        const decoded = await auth.verifyIdToken(bearer[1], true);
        const user = await auth.getUser(decoded.uid);
        if (
          !decoded.email_verified ||
          user.disabled ||
          !user.emailVerified ||
          user.email?.toLowerCase() !== String(decoded.email).toLowerCase()
        ) {
          response.status(403).end();
          return;
        }
        const member = await db.doc(`organizations/${path.org}/members/${decoded.uid}`).get();
        if (
          member.get('uid') !== decoded.uid ||
          member.get('status') !== 'active' ||
          !['admin', 'viewer'].includes(member.get('role'))
        ) {
          response.status(403).end();
          return;
        }
        adminPreview = member.get('role') === 'admin';
        if (
          !adminPreview &&
          scene.get('accessMode') !== 'organization' &&
          !(
            scene.get('accessMode') === 'assigned' &&
            (scene.get('assignedUserIds') as unknown[] | undefined)?.includes(decoded.uid)
          )
        ) {
          response.status(403).end();
          return;
        }
      }
      if (
        (!adminPreview && scene.get('status') !== 'published') ||
        (!adminPreview && scene.get('publishedRevisionId') !== path.revision)
      ) {
        response.status(403).end();
        return;
      }
      const revision = await db
        .doc(
          path.kind === 'public'
            ? `publicSceneImports/${path.scene}/revisions/${path.revision}`
            : `organizations/${path.org}/scenes/${path.scene}/revisions/${path.revision}`,
        )
        .get();
      if (revision.get('status') !== 'ready') {
        response.status(404).end();
        return;
      }
      const entries = Object.values(revision.get('manifest') ?? {}) as Asset[];
      const asset = entries.find((entry) => entry.path === path.path);
      if (
        !asset ||
        !Number.isSafeInteger(asset.bytes) ||
        asset.bytes <= 0 ||
        asset.bytes > 100 * 1024 ** 2 ||
        !/^[1-9][0-9]*$/.test(asset.generation)
      ) {
        response.status(404).end();
        return;
      }
      const range = parseRange(request.get('Range'), asset.bytes);
      if (!range) {
        response.set('Content-Range', `bytes */${asset.bytes}`);
        response.status(416).end();
        return;
      }
      response.set('Accept-Ranges', 'bytes');
      response.set('Content-Length', String(range.end - range.start + 1));
      if (range.partial)
        response.set('Content-Range', `bytes ${range.start}-${range.end}/${asset.bytes}`);
      response.status(range.partial ? 206 : 200);
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      await pipeline(
        bucket
          .file(asset.path, { generation: asset.generation })
          .createReadStream({ start: range.start, end: range.end }),
        response,
      );
    } catch {
      if (response.headersSent) response.destroy();
      else response.status(403).end();
    }
  };
}

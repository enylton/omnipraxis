import { Component, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { doc, getDocFromServer, onSnapshot } from 'firebase/firestore';

import { PortalSession, ViewerLease } from './session';
import { resolvePublicAssets } from '../../src/adapters/firebase/publicAssets';
import { resolveStorageAssets } from '../../src/adapters/firebase/sceneAssets';
import { parsePublicScene } from '../../src/contracts/publicScene';
import { parseSceneDescriptor } from '../../src/contracts/scene';

import type { ResolvedSceneAssets } from '../../src/adapters/firebase/sceneAssets';
import type { ElementRef } from '@angular/core';
import type { MountPublicDemo, PublicDemo } from '@omnipraxis/public-viewer';
import type { MountViewer, ViewerHandle } from '@omnipraxis/viewer';
import type { DocumentData } from 'firebase/firestore';

const styles = new Map<string, Promise<void>>();
function viewerStyles(href: string) {
  if (!styles.has(href))
    styles.set(
      href,
      new Promise<void>((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.onload = () => resolve();
        link.onerror = () => {
          styles.delete(href);
          link.remove();
          reject(new Error('Viewer styles unavailable.'));
        };
        document.head.append(link);
      }),
    );
  return styles.get(href)!;
}

@Component({
  selector: 'portal-viewer',
  imports: [RouterLink],
  template: `<section class="scene-page">
    <div class="scene-toolbar">
      <a
        [routerLink]="
          preview()
            ? ['/organizations', orgId(), 'admin']
            : demo()
              ? ['/']
              : ['/organizations', orgId(), 'scenes']
        "
        >← Catalog</a
      ><span>{{ demo() || sceneId() }}</span
      ><a routerLink="/organizations">Switch organization</a>
    </div>
    <div class="viewer-stage">
      <div #host class="viewer-host" aria-label="Interactive scene"></div>
      @if (state() !== 'viewing') {
        <div class="viewer-message" role="status">
          <h1>{{ state() === 'loading' ? 'Opening scene…' : 'Scene closed' }}</h1>
          <p>{{ message() }}</p>
          @if (state() === 'closed') {
            <button
              [disabled]="!session.downloadsEnabled() || (!demo() && !session.verified())"
              (click)="reopen()"
            >
              Reopen scene
            </button>
          }
        </div>
      }
    </div>
    <p class="controls">
      Click the scene to begin. Move with WASD or the left stick; look with the mouse or right
      stick. Touch controls are also available. Press Escape to release the pointer.
    </p>
  </section>`,
})
export class ViewerPage {
  readonly session = inject(PortalSession);
  private readonly lease = inject(ViewerLease);
  readonly demo = input<PublicDemo>();
  readonly orgId = input<string>();
  readonly sceneId = input<string>();
  readonly preview = input<string>();
  private readonly host = viewChild<ElementRef<HTMLElement>>('host');
  private readonly attempt = signal(0);
  readonly state = signal<'loading' | 'viewing' | 'closed'>('loading');
  readonly message = signal('Checking access and downloading scene assets.');
  private stop?: (reason?: string) => void;
  constructor() {
    effect((cleanup) => {
      const host = this.host()?.nativeElement;
      const demo = this.demo();
      const orgId = this.orgId();
      const sceneId = this.sceneId();
      const preview = this.preview();
      const uid = this.session.uid();
      const verified = this.session.verified();
      this.attempt();
      if (!host) return;
      const stop = untracked(() => this.open(host, demo, orgId, sceneId, uid, verified, preview));
      this.stop = stop;
      cleanup(() => stop());
    });
    effect(() => {
      if (this.session.serviceReady() && !this.session.downloadsEnabled())
        untracked(() =>
          this.stop?.('Scene downloads are temporarily unavailable. Reopen after service resumes.'),
        );
    });
  }
  reopen() {
    this.attempt.update((value) => value + 1);
  }
  private open(
    host: HTMLElement,
    demo: PublicDemo | undefined,
    orgId: string | undefined,
    sceneId: string | undefined,
    uid: string | null,
    verified: boolean,
    preview?: string,
  ) {
    const controller = new AbortController();
    let closed = false;
    let mounted: ViewerHandle | undefined;
    let assets: Pick<ResolvedSceneAssets, 'dispose'> | undefined;
    const subscriptions: (() => void)[] = [];
    this.state.set('loading');
    this.message.set('Checking access and downloading scene assets.');
    let unclaim = () => {};
    const stop = (reason = 'This viewing session has ended.') => {
      if (closed) return;
      closed = true;
      controller.abort();
      for (const unsubscribe of subscriptions) unsubscribe();
      mounted?.dispose();
      assets?.dispose();
      unclaim();
      this.message.set(reason);
      this.state.set('closed');
    };
    unclaim = this.lease.claim(stop);
    const failed = () =>
      stop('The scene could not be opened. Check your access and connection, then try again.');
    const run = async () => {
      await this.session.availabilityReady;
      if (closed) return;
      if (!this.session.downloadsEnabled()) {
        stop('Scene downloads are temporarily unavailable. Reopen after service resumes.');
        return;
      }
      if (demo) {
        let descriptor: ReturnType<typeof parsePublicScene> | undefined;
        let revision: string | undefined;
        await new Promise<void>((resolve) => {
          const denied = () => {
            failed();
            resolve();
          };
          subscriptions.push(
            onSnapshot(
              doc(this.session.db, 'publicScenes', demo),
              { includeMetadataChanges: true },
              (snapshot) => {
                if (closed || snapshot.metadata.fromCache) return;
                try {
                  if (!snapshot.exists() || snapshot.get('status') !== 'published')
                    throw new Error('Public scene unavailable.');
                  const current = parsePublicScene(snapshot.get('descriptor'));
                  if (
                    current.sceneId !== demo ||
                    current.revisionId !== snapshot.get('publishedRevisionId')
                  )
                    throw new Error('Public revision identity mismatch.');
                  if (revision && revision !== current.revisionId) {
                    stop('This scene has changed. Reopen it to load the latest version.');
                  } else {
                    revision = current.revisionId;
                    descriptor = current;
                  }
                  resolve();
                } catch {
                  denied();
                }
              },
              denied,
            ),
          );
          controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        if (closed || !descriptor) return;
        const acquired = await resolvePublicAssets(
          this.session.assets,
          descriptor,
          controller.signal,
        );
        assets = acquired;
        if (closed) {
          acquired.dispose();
          return;
        }
        const url = new URL('/public-viewer/public-demos.js', location.origin).href;
        const [module] = await Promise.all([
          import(/* @vite-ignore */ url) as Promise<{ mountPublicDemo: MountPublicDemo }>,
          viewerStyles('/public-viewer/viewer.css'),
        ]);
        if (closed) return;
        mounted = module.mountPublicDemo(host, {
          apiVersion: 2,
          scene: demo,
          assets: acquired.assets,
          releaseAssets: acquired.dispose,
          onReady: () => {
            if (!closed) this.state.set('viewing');
          },
          onError: () => queueMicrotask(failed),
          onSessionComplete: (snapshot) => this.exportSession(snapshot),
        });
        return;
      }
      if (!uid || !verified || !orgId || !sceneId) {
        stop('Access denied. Sign in with your invited, verified account.');
        return;
      }
      let member: DocumentData | undefined;
      let scene: DocumentData | undefined;
      let revision: string | undefined;
      let gateResolved = false;
      const sceneRef = doc(this.session.db, 'organizations', orgId, 'scenes', sceneId);
      await new Promise<void>((resolve) => {
        const evaluate = () => {
          if (closed || !member || !scene) return;
          if (
            member['uid'] !== uid ||
            member['status'] !== 'active' ||
            !['viewer', 'admin'].includes(member['role']) ||
            (preview ? member['role'] !== 'admin' : scene['status'] !== 'published') ||
            !(
              member['role'] === 'admin' ||
              scene['accessMode'] === 'organization' ||
              (scene['accessMode'] === 'assigned' && scene['assignedUserIds']?.includes(uid))
            )
          ) {
            stop('Access denied. This scene is no longer available to your account.');
            resolve();
            return;
          }
          if (!preview && typeof scene['publishedRevisionId'] !== 'string') {
            failed();
            resolve();
            return;
          }
          if (!preview && revision && revision !== scene['publishedRevisionId']) {
            stop('This scene has changed. Reopen it to load the latest version.');
            resolve();
            return;
          }
          revision = preview ?? scene['publishedRevisionId'];
          if (!gateResolved) {
            gateResolved = true;
            resolve();
          }
        };
        const denied = () => {
          stop('Access denied. This scene is no longer available to your account.');
          resolve();
        };
        subscriptions.push(
          onSnapshot(
            doc(this.session.db, 'organizations', orgId, 'members', uid),
            { includeMetadataChanges: true },
            (snapshot) => {
              if (snapshot.metadata.fromCache) return;
              if (!snapshot.exists()) {
                denied();
                return;
              }
              member = snapshot.data();
              evaluate();
            },
            denied,
          ),
        );
        subscriptions.push(
          onSnapshot(
            sceneRef,
            { includeMetadataChanges: true },
            (snapshot) => {
              if (snapshot.metadata.fromCache) return;
              if (!snapshot.exists()) {
                denied();
                return;
              }
              scene = snapshot.data();
              evaluate();
            },
            denied,
          ),
        );
        controller.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (closed || !revision) return;
      const snapshot = await getDocFromServer(doc(sceneRef, 'revisions', revision));
      if (closed) return;
      if (preview && snapshot.get('status') !== 'ready')
        throw new Error('Revision is not ready for preview.');
      const descriptor = parseSceneDescriptor(snapshot.get('descriptor'));
      if (
        descriptor.scope.kind !== 'organization' ||
        descriptor.scope.organizationId !== orgId ||
        descriptor.sceneId !== sceneId ||
        descriptor.revisionId !== revision
      )
        throw new Error('Revision identity mismatch.');
      const acquired = await resolveStorageAssets(
        this.session.assets,
        descriptor,
        controller.signal,
      );
      assets = acquired;
      if (closed) {
        assets.dispose();
        return;
      }
      const url = new URL('/viewer/viewer.js', location.origin).href;
      const [module] = await Promise.all([
        import(/* @vite-ignore */ url) as Promise<{ mountViewer: MountViewer }>,
        viewerStyles('/viewer/viewer.css'),
      ]);
      if (closed) return;
      mounted = module.mountViewer(host, {
        apiVersion: 1,
        scene: acquired.scene,
        releaseAssets: assets.dispose,
        onReady: () => {
          if (!closed) this.state.set('viewing');
        },
        onError: () => queueMicrotask(failed),
        onSessionComplete: (snapshot) => this.exportSession(snapshot),
      });
    };
    void run().catch(() => {
      if (!closed) failed();
    });
    return stop;
  }
  private exportSession(snapshot: unknown) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'scene-session.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

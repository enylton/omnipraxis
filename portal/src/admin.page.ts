import { Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  collection,
  doc,
  documentId,
  getDocFromServer,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  startAfter,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

import { PortalSession, ViewerLease, friendlyError } from './session';

import type { QueryDocumentSnapshot } from 'firebase/firestore';

type Member = {
  id: string;
  email: string;
  role: 'admin' | 'viewer';
  status: 'active' | 'suspended' | 'removed';
};
type Scene = {
  id: string;
  title: string;
  version: number;
  status: string;
  accessMode: 'organization' | 'assigned';
  assignedUserIds: string[];
  publishedRevisionId: string | null;
};
type Revision = { id: string; status: string; error?: string };
type Invitation = { id: string; email: string; role: string; status: string };
type Audit = { id: string; actor: string; action: string; target: string };
type Upload = {
  id: string;
  actor: string;
  sceneId: string;
  revisionId: string;
  status: string;
  error?: string;
  files: Record<string, { bytes: number; sha256: string }>;
  offsets: Record<string, number>;
  spawn: { position: number[]; yaw: number; pitch: number };
};
const slotNames = ['splats.spz', 'colliders.glb', 'thumbnail.png'] as const;
type Slot = (typeof slotNames)[number];

@Component({
  selector: 'portal-admin',
  imports: [FormsModule, RouterLink],
  template: `<section class="admin-page">
    <a routerLink="/organizations">← Organizations</a>
    <p class="eyebrow">Organization workspace</p>
    <h1>Administration</h1>
    @if (!authorized()) {
      <p role="alert">Administrator access is required.</p>
    } @else {
      <nav class="admin-nav" aria-label="Administration sections">
        <a [href]="sectionLink('scenes')">Scenes</a><a [href]="sectionLink('members')">Members</a
        ><a [href]="sectionLink('invitations')">Invitations</a
        ><a [href]="sectionLink('uploads')">Uploads</a
        ><a [href]="sectionLink('audit')">Audit history</a>
      </nav>
      @if (message()) {
        <p role="status">{{ message() }}</p>
      }
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      @if (!session.downloadsEnabled()) {
        <p role="alert">
          Uploads, previews and publishing are temporarily suspended. Member management and
          cancellation remain available.
        </p>
      }
      <div class="panel" id="scenes">
        <h2>Scenes</h2>
        <form (ngSubmit)="createScene()">
          <label
            >Scene ID<input
              name="sceneId"
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              maxlength="100"
              [(ngModel)]="newId" /></label
          ><label
            >Scene title<input
              name="title"
              required
              maxlength="120"
              [(ngModel)]="newTitle" /></label
          ><button [disabled]="busy()">Create scene</button>
        </form>
        <div class="admin-rows">
          @for (scene of scenes(); track scene.id) {
            <button class="secondary" [disabled]="busy()" (click)="selectScene(scene)">
              {{ scene.title }} · {{ scene.status }}
            </button>
          }
        </div>
        <button class="secondary" [disabled]="!next['scenes'] || busy()" (click)="loadScenes(true)">
          More scenes
        </button>
        @if (selected(); as scene) {
          <hr />
          <h3>{{ scene.title }}</h3>
          <p>Scene {{ scene.id }} · Version {{ scene.version }}</p>
          <form (ngSubmit)="saveTitle()">
            <label
              >Edit title<input
                name="editTitle"
                required
                maxlength="120"
                [(ngModel)]="editTitle" /></label
            ><button [disabled]="busy()">Save title</button>
          </form>
          <form (ngSubmit)="saveAccess()">
            <label
              >Access<select name="access" [(ngModel)]="accessMode">
                <option value="organization">All active organization members</option>
                <option value="assigned">Selected members only</option>
              </select></label
            >
            @if (accessMode === 'assigned') {
              <label
                >Assigned member UIDs, separated by commas<textarea
                  name="assignments"
                  [(ngModel)]="assignments"
                ></textarea>
              </label>
            }
            <button [disabled]="busy()">Save access</button>
          </form>
          <button class="secondary" [disabled]="busy()" (click)="archive()">Archive scene</button>
          <h3>Immutable revisions</h3>
          <p>
            Preview a validated revision before publishing. Publishing an older revision rolls back
            the scene.
          </p>
          @for (revision of revisions(); track revision.id) {
            <div class="admin-row">
              <span>{{ revision.id }} · {{ revision.status }} {{ revision.error }}</span>
              @if (revision.status === 'ready') {
                <a
                  class="button secondary"
                  [routerLink]="[
                    '/organizations',
                    orgId(),
                    'admin',
                    'scenes',
                    scene.id,
                    'revisions',
                    revision.id,
                  ]"
                  >Preview revision</a
                ><button
                  [disabled]="busy() || !session.downloadsEnabled()"
                  (click)="publish(revision.id)"
                >
                  {{
                    scene.publishedRevisionId === revision.id
                      ? 'Publish again'
                      : 'Publish / rollback'
                  }}
                </button>
              }
            </div>
          }
          <button
            class="secondary"
            [disabled]="!next['revisions'] || busy()"
            (click)="loadRevisions(true)"
          >
            More revisions
          </button>
          <h3>Upload environment</h3>
          <p>
            Prepared gzip SPZ v2/v3, static self-contained collider GLB, and noninterlaced RGB/RGBA
            PNG up to 2048×2048. SPZ/GLB: 100 MiB each; PNG: 5 MiB. SPZ: up to 3 million points and
            128 MiB decoded; collider: up to 1 million triangles.
          </p>
          <label
            >SPZ file<input
              type="file"
              accept=".spz"
              (change)="choose($event, 'splats.spz')" /></label
          ><label
            >Collider GLB<input
              type="file"
              accept=".glb"
              (change)="choose($event, 'colliders.glb')" /></label
          ><label
            >Thumbnail PNG<input
              type="file"
              accept="image/png"
              (change)="choose($event, 'thumbnail.png')"
          /></label>
          <div class="spawn-fields">
            <label>Spawn X (m)<input type="number" [(ngModel)]="x" /></label
            ><label>Spawn Y (m)<input type="number" [(ngModel)]="y" /></label
            ><label>Spawn Z (m)<input type="number" [(ngModel)]="z" /></label
            ><label>Yaw (radians)<input type="number" [(ngModel)]="yaw" /></label
            ><label>Pitch (radians)<input type="number" [(ngModel)]="pitch" /></label>
          </div>
          <p>Upload {{ progress() }}%</p>
          <progress [value]="progress()" max="100" aria-label="Upload progress"></progress>
          <div class="actions">
            <button [disabled]="busy() || !session.downloadsEnabled()" (click)="upload()">
              {{ uploadId() ? 'Resume upload' : 'Start upload' }}</button
            ><button class="secondary" [disabled]="!transferring()" (click)="pause()">
              Pause upload</button
            ><button
              [disabled]="
                busy() || !uploadId() || progress() !== 100 || !session.downloadsEnabled()
              "
              (click)="validate()"
            >
              Validate uploaded files</button
            ><button class="secondary" [disabled]="busy() || !uploadId()" (click)="cancel()">
              Cancel upload
            </button>
          </div>
        }
      </div>
      <div class="panel" id="members">
        <h2>Members</h2>
        <p>Assignments use the member UID shown below. Only active members can be assigned.</p>
        @for (member of members(); track member.id) {
          <div class="admin-row">
            <span
              >{{ member.email }}<small>{{ member.id }}</small></span
            ><label
              >Role for {{ member.email
              }}<select [(ngModel)]="member.role">
                <option value="viewer">Viewer</option>
                <option value="admin">Administrator</option>
              </select></label
            ><label
              >Status for {{ member.email
              }}<select [(ngModel)]="member.status">
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="removed">Removed</option>
              </select></label
            ><button [disabled]="busy()" (click)="saveMember(member)">Save member</button>
          </div>
        }
        <button
          class="secondary"
          [disabled]="!next['members'] || busy()"
          (click)="loadMembers(true)"
        >
          More members
        </button>
      </div>
      <div class="panel" id="invitations">
        <h2>Invitations</h2>
        <form (ngSubmit)="invite()">
          <label
            >Invitation email<input
              name="inviteEmail"
              type="email"
              required
              [(ngModel)]="inviteEmail" /></label
          ><label
            >Invitation role<select name="inviteRole" [(ngModel)]="inviteRole">
              <option value="viewer">Viewer</option>
              <option value="admin">Administrator</option>
            </select></label
          ><button [disabled]="busy()">Create invitation</button>
        </form>
        @if (invitationLink()) {
          <label
            >Invitation link — copy and share privately<input
              readonly
              [value]="invitationLink()"
              (focus)="$any($event.target).select()" /></label
          ><button class="secondary" (click)="invitationLink.set('')">Hide invitation link</button>
        }
        @for (invitation of invitations(); track invitation.id) {
          <div class="admin-row">
            <span>{{ invitation.email }} · {{ invitation.role }} · {{ invitation.status }}</span>
            @if (invitation.status === 'pending') {
              <button class="secondary" [disabled]="busy()" (click)="revoke(invitation.id)">
                Revoke invitation
              </button>
            }
          </div>
        }
        <button
          class="secondary"
          [disabled]="!next['invitations'] || busy()"
          (click)="loadInvitations(true)"
        >
          More invitations
        </button>
      </div>
      <div class="panel" id="uploads">
        <h2>Upload sessions</h2>
        <p>
          Paused transfers resume from acknowledged chunks in this page. After a browser restart,
          reselect the original files or cancel and create a new session.
        </p>
        @for (upload of uploads(); track upload.id) {
          <div class="admin-row">
            <span>{{ upload.sceneId }} · {{ upload.status }} {{ upload.error }}</span>
            @if (
              upload.actor === session.uid() &&
              ['uploading', 'failed', 'validating'].includes(upload.status)
            ) {
              <button class="secondary" [disabled]="busy()" (click)="restore(upload)">
                Select upload session
              </button>
            }
          </div>
        }
        <button
          class="secondary"
          [disabled]="!next['uploads'] || busy()"
          (click)="loadUploads(true)"
        >
          More uploads
        </button>
      </div>
      <div class="panel" id="audit">
        <h2>Audit history</h2>
        @for (entry of audit(); track entry.id) {
          <p>{{ entry.action }} · {{ entry.actor }} · {{ entry.target }}</p>
        }
        <button class="secondary" [disabled]="!next['audit'] || busy()" (click)="loadAudit(true)">
          More audit entries
        </button>
      </div>
    }
  </section>`,
})
export class AdminPage {
  readonly orgId = input.required<string>();
  readonly session = inject(PortalSession);
  private readonly lease = inject(ViewerLease);
  private readonly destroy = inject(DestroyRef);
  readonly authorized = signal(false);
  readonly busy = signal(false);
  readonly message = signal('');
  readonly error = signal('');
  readonly members = signal<Member[]>([]);
  readonly scenes = signal<Scene[]>([]);
  readonly invitations = signal<Invitation[]>([]);
  readonly audit = signal<Audit[]>([]);
  readonly uploads = signal<Upload[]>([]);
  readonly revisions = signal<Revision[]>([]);
  readonly selected = signal<Scene | null>(null);
  readonly invitationLink = signal('');
  readonly uploadId = signal('');
  readonly progress = signal(0);
  readonly transferring = signal(false);
  private paused = false;
  private generation = 0;
  readonly next: Record<string, QueryDocumentSnapshot | null> = {};
  private files: Partial<Record<Slot, File>> = {};
  private requestId = crypto.randomUUID();
  newId = '';
  newTitle = '';
  editTitle = '';
  accessMode: 'organization' | 'assigned' = 'organization';
  assignments = '';
  inviteEmail = '';
  inviteRole = 'viewer';
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  pitch = 0;
  constructor() {
    effect((cleanup) => {
      const org = this.orgId();
      const uid = this.session.uid();
      this.deny();
      if (!uid) return;
      const stop = onSnapshot(
        doc(this.session.db, 'organizations', org, 'members', uid),
        { includeMetadataChanges: true },
        (member) => {
          if (member.metadata.fromCache) return;
          if (member.get('status') !== 'active' || member.get('role') !== 'admin') {
            this.deny();
            return;
          }
          this.authorized.set(true);
          void this.refresh();
        },
        () => this.deny(),
      );
      cleanup(() => {
        this.generation++;
        this.paused = true;
        stop();
      });
    });
    this.destroy.onDestroy(() => {
      this.generation++;
      this.paused = true;
      this.invitationLink.set('');
    });
  }
  private deny() {
    this.generation++;
    this.paused = true;
    this.authorized.set(false);
    this.lease.close();
    this.members.set([]);
    this.scenes.set([]);
    this.invitations.set([]);
    this.audit.set([]);
    this.uploads.set([]);
    this.selected.set(null);
    this.invitationLink.set('');
  }
  sectionLink(section: string) {
    return `/organizations/${this.orgId()}/admin#${section}`;
  }
  private async page<T>(name: string, more = false, scene?: string): Promise<T[]> {
    const path = scene
      ? `organizations/${this.orgId()}/scenes/${scene}/revisions`
      : `organizations/${this.orgId()}/${name}`;
    const cursor = more ? this.next[name] : null;
    const result = await getDocs(
      query(
        collection(this.session.db, path),
        name === 'audit' ? orderBy('createdAt', 'desc') : orderBy(documentId()),
        limit(25),
        ...(cursor ? [startAfter(cursor)] : []),
      ),
    );
    this.next[name] = result.size === 25 ? result.docs.at(-1)! : null;
    return result.docs.map((d) => ({ ...d.data(), id: d.id }) as T);
  }
  async loadMembers(more = false) {
    const data = await this.page<Member>('members', more);
    if (this.authorized()) this.members.set(more ? [...this.members(), ...data] : data);
  }
  async loadScenes(more = false) {
    const data = await this.page<Scene>('scenes', more);
    if (this.authorized()) this.scenes.set(more ? [...this.scenes(), ...data] : data);
  }
  async loadInvitations(more = false) {
    const data = await this.page<Invitation>('invitations', more);
    if (this.authorized()) this.invitations.set(more ? [...this.invitations(), ...data] : data);
  }
  async loadAudit(more = false) {
    const data = await this.page<Audit>('audit', more);
    if (this.authorized()) this.audit.set(more ? [...this.audit(), ...data] : data);
  }
  async loadUploads(more = false) {
    const data = await this.page<Upload>('uploads', more);
    if (this.authorized()) this.uploads.set(more ? [...this.uploads(), ...data] : data);
  }
  async loadRevisions(more = false) {
    const scene = this.selected();
    if (!scene) return;
    const data = await this.page<Revision>('revisions', more, scene.id);
    if (this.authorized() && this.selected()?.id === scene.id)
      this.revisions.set(more ? [...this.revisions(), ...data] : data);
  }
  private async refresh() {
    const results = await Promise.allSettled([
      this.loadMembers(),
      this.loadScenes(),
      this.loadInvitations(),
      this.loadAudit(),
      this.loadUploads(),
    ]);
    if (results.some((r) => r.status === 'rejected'))
      this.error.set(
        'Administration data could not be loaded. Check access and refresh this page.',
      );
  }
  private call<T = Record<string, unknown>>(name: string, data: object) {
    return httpsCallable<object, T>(this.session.functions, name, { timeout: 310000 })({
      orgId: this.orgId(),
      ...data,
    }).then((r) => r.data);
  }
  private async run(action: () => Promise<unknown>, success: string) {
    if (this.busy() || !this.authorized()) return;
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    const generation = this.generation;
    try {
      await action();
      if (generation !== this.generation) return;
      this.message.set(success);
      await this.refresh();
      if (this.selected()) {
        const saved = await getDocFromServer(
          doc(this.session.db, 'organizations', this.orgId(), 'scenes', this.selected()!.id),
        );
        if (this.authorized()) {
          this.selected.set({ ...saved.data(), id: saved.id } as Scene);
          await this.loadRevisions();
        }
      }
    } catch (error) {
      if (generation === this.generation)
        this.error.set(
          (error as { code?: string; message?: string }).code?.startsWith('functions/')
            ? (error as Error).message
            : friendlyError(error),
        );
    } finally {
      this.busy.set(false);
    }
  }
  async selectScene(scene: Scene) {
    if (this.busy()) return;
    this.selected.set(scene);
    this.editTitle = scene.title;
    this.accessMode = scene.accessMode;
    this.assignments = scene.assignedUserIds.join(', ');
    this.uploadId.set('');
    this.progress.set(0);
    this.requestId = crypto.randomUUID();
    await this.loadRevisions();
  }
  createScene() {
    return this.run(async () => {
      await this.call('createScene', { sceneId: this.newId, title: this.newTitle });
      this.newId = '';
      this.newTitle = '';
    }, 'Scene created. Select it to upload an environment.');
  }
  saveTitle() {
    const scene = this.selected()!;
    return this.run(
      () =>
        this.call('updateScene', {
          sceneId: scene.id,
          title: this.editTitle,
          expectedVersion: scene.version,
        }),
      'Title saved.',
    );
  }
  saveAccess() {
    const scene = this.selected()!;
    const assigned =
      this.accessMode === 'assigned'
        ? this.assignments
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    return this.run(
      () =>
        this.call('setSceneAccess', {
          sceneId: scene.id,
          accessMode: this.accessMode,
          assignedUserIds: assigned,
          expectedVersion: scene.version,
        }),
      'Scene access saved.',
    );
  }
  archive() {
    const scene = this.selected()!;
    return this.run(
      () => this.call('archiveScene', { sceneId: scene.id, expectedVersion: scene.version }),
      'Scene archived.',
    );
  }
  publish(revisionId: string) {
    const scene = this.selected()!;
    return this.run(
      () =>
        this.call('publishRevision', {
          sceneId: scene.id,
          revisionId,
          expectedVersion: scene.version,
        }),
      'Revision published. Active viewers must reopen.',
    );
  }
  saveMember(member: Member) {
    return this.run(
      () => this.call('updateMember', { uid: member.id, role: member.role, status: member.status }),
      'Membership saved.',
    );
  }
  invite() {
    this.invitationLink.set('');
    return this.run(async () => {
      const result = await this.call<{ invitationId: string; token: string }>('createInvitation', {
        email: this.inviteEmail,
        role: this.inviteRole,
      });
      const fragment = new URLSearchParams({
        orgId: this.orgId(),
        invitationId: result.invitationId,
        token: result.token,
      });
      this.invitationLink.set(`${location.origin}/invite#${fragment}`);
      this.inviteEmail = '';
    }, 'Invitation created. Copy the link now; it cannot be retrieved later.');
  }
  revoke(invitationId: string) {
    return this.run(() => this.call('revokeInvitation', { invitationId }), 'Invitation revoked.');
  }
  choose(event: Event, slot: Slot) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.files[slot] = file;
  }
  pause() {
    this.paused = true;
    this.message.set('Pausing after the current chunk finishes.');
  }
  private base64(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('Could not read file.'));
      reader.readAsDataURL(blob);
    });
  }
  upload() {
    return this.run(async () => {
      const manifest: Record<string, { bytes: number; sha256: string }> = {};
      for (const slot of slotNames) {
        const file = this.files[slot];
        if (
          !file ||
          file.size === 0 ||
          file.size > (slot === 'thumbnail.png' ? 5 : 100) * 1024 ** 2
        )
          throw new Error('Select all three files within the size limits.');
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        manifest[slot] = {
          bytes: file.size,
          sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
            '',
          ),
        };
      }
      if (!this.uploadId()) {
        const result = await this.call<{ uploadId: string }>('createUpload', {
          sceneId: this.selected()!.id,
          requestId: this.requestId,
          files: manifest,
          spawn: { position: [this.x, this.y, this.z], yaw: this.yaw, pitch: this.pitch },
        });
        this.uploadId.set(result.uploadId);
      }
      const snapshot = await getDocFromServer(
        doc(this.session.db, 'organizations', this.orgId(), 'uploads', this.uploadId()),
      );
      const u = snapshot.data() as Upload;
      if (
        slotNames.some(
          (s) => u.files[s].bytes !== manifest[s].bytes || u.files[s].sha256 !== manifest[s].sha256,
        )
      )
        throw new Error('Reselect the original files for this upload.');
      this.paused = false;
      this.transferring.set(true);
      let done = Object.values(u.offsets).reduce((a, b) => a + b, 0);
      const total = Object.values(manifest).reduce((a, b) => a + b.bytes, 0);
      this.progress.set(Math.floor((done / total) * 100));
      try {
        for (const slot of slotNames) {
          for (let offset = u.offsets[slot]; offset < this.files[slot]!.size; offset += 1024 ** 2) {
            if (this.paused || !this.authorized()) return;
            const chunk = this.files[slot]!.slice(offset, offset + 1024 ** 2);
            await this.call('appendChunk', {
              uploadId: this.uploadId(),
              slot,
              offset,
              data: await this.base64(chunk),
            });
            done += chunk.size;
            this.progress.set(Math.floor((done / total) * 100));
          }
        }
      } finally {
        this.transferring.set(false);
      }
    }, 'Transfer stopped or completed. Resume paused transfers; validate when progress reaches 100%.');
  }
  validate() {
    return this.run(async () => {
      await this.call('finalizeUpload', { uploadId: this.uploadId() });
      this.uploadId.set('');
      this.requestId = crypto.randomUUID();
      this.progress.set(0);
    }, 'Validation finished. Preview the ready revision, then publish it.');
  }
  cancel() {
    return this.run(async () => {
      await this.call('cancelUpload', { uploadId: this.uploadId() });
      this.uploadId.set('');
      this.progress.set(0);
      this.requestId = crypto.randomUUID();
    }, 'Upload cancelled and its reserved bytes released.');
  }
  async restore(upload: Upload) {
    const scene = await getDocFromServer(
      doc(this.session.db, 'organizations', this.orgId(), 'scenes', upload.sceneId),
    );
    await this.selectScene({ ...scene.data(), id: scene.id } as Scene);
    this.uploadId.set(upload.id);
    [this.x, this.y, this.z] = upload.spawn.position;
    this.yaw = upload.spawn.yaw;
    this.pitch = upload.spawn.pitch;
    const total = Object.values(upload.files).reduce((a, b) => a + b.bytes, 0);
    this.progress.set(
      Math.floor((Object.values(upload.offsets).reduce((a, b) => a + b, 0) / total) * 100),
    );
    this.message.set(
      'Reselect the original three files to resume, or retry validation if transfer is complete.',
    );
  }
}

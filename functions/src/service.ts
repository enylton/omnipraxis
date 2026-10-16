import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import type { Auth } from 'firebase-admin/auth';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';

type Actor = { uid: string; email: string };
type Role = 'admin' | 'viewer';
type Status = 'active' | 'suspended' | 'removed';

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new HttpsError('invalid-argument', 'Unsupported command fields.');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new HttpsError('invalid-argument', 'Invalid text field.');
  }
  return value.trim();
}

function id(value: unknown): string {
  const result = text(value);
  if (!/^[A-Za-z0-9_-]+$/.test(result))
    throw new HttpsError('invalid-argument', 'Invalid identifier.');
  return result;
}

function role(value: unknown): Role {
  if (value !== 'admin' && value !== 'viewer')
    throw new HttpsError('invalid-argument', 'Invalid role.');
  return value;
}

const digest = (token: string) => createHash('sha256').update(token).digest();

export function organizationService(db: Firestore, auth: Auth) {
  const orgRef = (orgId: string) => db.doc(`organizations/${orgId}`);
  const memberRef = (orgId: string, uid: string) => orgRef(orgId).collection('members').doc(uid);
  const audit = (
    tx: Transaction,
    orgId: string,
    actor: string,
    action: string,
    target: string,
    changes: Record<string, unknown> = {},
  ) =>
    tx.create(orgRef(orgId).collection('audit').doc(), {
      actor,
      action,
      target,
      changes,
      createdAt: Timestamp.now(),
    });

  async function actor(request: Pick<CallableRequest, 'auth'>): Promise<Actor> {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    if (request.auth.token.email_verified !== true) {
      throw new HttpsError('permission-denied', 'Verify your email first.');
    }
    const user = await auth.getUser(request.auth.uid);
    if (
      user.disabled ||
      !user.emailVerified ||
      !user.email ||
      user.email.toLowerCase() !== String(request.auth.token.email).toLowerCase()
    ) {
      throw new HttpsError('permission-denied', 'Refresh your verified identity.');
    }
    return { uid: id(user.uid), email: user.email.toLowerCase() };
  }

  async function administrator(tx: Transaction, orgId: string, who: Actor) {
    const [org, member] = await tx.getAll(orgRef(orgId), memberRef(orgId, who.uid));
    if (!org.exists || member.get('status') !== 'active' || member.get('role') !== 'admin') {
      throw new HttpsError(
        'permission-denied',
        'An active organization administrator is required.',
      );
    }
    return org;
  }

  // Removal/reactivation clears stale assignments in the same transaction.
  // Bound writes below Firestore's transaction limit; fail without partial changes.
  async function assignments(tx: Transaction, orgId: string, uid: string) {
    const matches = await tx.get(
      orgRef(orgId).collection('scenes').where('assignedUserIds', 'array-contains', uid).limit(401),
    );
    if (matches.size > 400)
      throw new HttpsError(
        'resource-exhausted',
        'Reduce assignments before changing this membership.',
      );
    return matches.docs;
  }

  function clearAssignments(
    tx: Transaction,
    scenes: Awaited<ReturnType<typeof assignments>>,
    uid: string,
  ) {
    for (const scene of scenes) {
      tx.update(scene.ref, {
        assignedUserIds: (scene.get('assignedUserIds') as string[]).filter((item) => item !== uid),
        version: scene.get('version') + 1,
        updatedAt: Timestamp.now(),
      });
    }
  }

  return {
    // Trusted operator entry only: deliberately not exported as a callable.
    async bootstrap(input: unknown) {
      const data = object(input, ['orgId', 'name', 'adminUid']);
      const orgId = id(data.orgId);
      const name = text(data.name, 120);
      const adminUid = id(data.adminUid);
      const user = await auth.getUser(adminUid);
      if (user.disabled || !user.emailVerified || !user.email) {
        throw new HttpsError(
          'failed-precondition',
          'Bootstrap requires an existing verified user.',
        );
      }
      await db.runTransaction(async (tx) => {
        const [org, member] = await tx.getAll(orgRef(orgId), memberRef(orgId, adminUid));
        if (org.exists) {
          if (member.get('role') === 'admin' && member.get('status') === 'active') return;
          throw new HttpsError('already-exists', 'Organization already exists.');
        }
        const now = Timestamp.now();
        tx.create(orgRef(orgId), { name, activeAdminCount: 1, createdAt: now, updatedAt: now });
        tx.set(memberRef(orgId, adminUid), {
          uid: adminUid,
          email: user.email!.toLowerCase(),
          displayName: (user.displayName ?? '').slice(0, 120),
          role: 'admin',
          status: 'active',
          joinedAt: now,
        });
        audit(tx, orgId, adminUid, 'organization.bootstrapped', adminUid);
      });
      return { orgId };
    },

    async createInvitation(request: CallableRequest) {
      const who = await actor(request);
      const data = object(request.data, ['orgId', 'email', 'role']);
      const orgId = id(data.orgId);
      const email = text(data.email, 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new HttpsError('invalid-argument', 'Invalid email.');
      const invitedRole = role(data.role);
      const invitation = orgRef(orgId).collection('invitations').doc();
      const token = randomBytes(32).toString('base64url');
      const expiresAt = Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await db.runTransaction(async (tx) => {
        await administrator(tx, orgId, who);
        tx.create(invitation, {
          email,
          role: invitedRole,
          tokenHash: digest(token).toString('hex'),
          status: 'pending',
          expiresAt,
          createdAt: Timestamp.now(),
          createdBy: who.uid,
        });
        audit(tx, orgId, who.uid, 'invitation.created', invitation.id);
      });
      // Secret is returned once; never persisted in plaintext or written to audit/logs.
      return { invitationId: invitation.id, token, expiresAt: expiresAt.toMillis() };
    },

    async revokeInvitation(request: CallableRequest) {
      const who = await actor(request);
      const data = object(request.data, ['orgId', 'invitationId']);
      const orgId = id(data.orgId);
      const invitation = orgRef(orgId).collection('invitations').doc(id(data.invitationId));
      await db.runTransaction(async (tx) => {
        await administrator(tx, orgId, who);
        const existing = await tx.get(invitation);
        if (!existing.exists) throw new HttpsError('not-found', 'Invitation not found.');
        if (existing.get('status') === 'revoked') return;
        if (existing.get('status') !== 'pending')
          throw new HttpsError('failed-precondition', 'Invitation is already used.');
        tx.update(invitation, { status: 'revoked', revokedAt: Timestamp.now() });
        audit(tx, orgId, who.uid, 'invitation.revoked', invitation.id);
      });
      return { revoked: true };
    },

    async acceptInvitation(request: CallableRequest) {
      const who = await actor(request);
      const data = object(request.data, ['orgId', 'invitationId', 'token']);
      const orgId = id(data.orgId);
      const invitationRef = orgRef(orgId).collection('invitations').doc(id(data.invitationId));
      const token = text(data.token, 64);
      await db.runTransaction(async (tx) => {
        const [org, invitation, membership] = await tx.getAll(
          orgRef(orgId),
          invitationRef,
          memberRef(orgId, who.uid),
        );
        const invite = invitation.data();
        if (
          !org.exists ||
          !invite ||
          typeof invite.tokenHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(invite.tokenHash) ||
          !timingSafeEqual(digest(token), Buffer.from(invite.tokenHash, 'hex')) ||
          invite.email !== who.email
        ) {
          throw new HttpsError('permission-denied', 'Invalid invitation for this identity.');
        }
        if (invite.status === 'accepted' && invite.acceptedUid === who.uid) return;
        if (
          invite.status !== 'pending' ||
          !(invite.expiresAt instanceof Timestamp) ||
          invite.expiresAt.toMillis() <= Date.now()
        ) {
          throw new HttpsError(
            'failed-precondition',
            'Invitation expired, revoked or already used.',
          );
        }
        if (
          membership.get('status') === 'suspended' ||
          (membership.get('status') === 'removed' &&
            (!(invite.createdAt instanceof Timestamp) ||
              invite.createdAt.toMillis() <= membership.get('removedAt').toMillis()))
        ) {
          throw new HttpsError(
            'permission-denied',
            'Suspension requires administrator review; removal requires a fresh invitation.',
          );
        }
        const issuer = await tx.get(memberRef(orgId, id(invite.createdBy)));
        if (issuer.get('role') !== 'admin' || issuer.get('status') !== 'active') {
          throw new HttpsError(
            'permission-denied',
            'The invitation issuer is no longer an active administrator.',
          );
        }
        const scenes =
          membership.get('status') === 'removed' ? await assignments(tx, orgId, who.uid) : [];
        // A fresh invitation cannot silently alter an existing active/suspended role.
        const assignedRole =
          membership.exists && membership.get('status') !== 'removed'
            ? role(membership.get('role'))
            : role(invite.role);
        const increment =
          assignedRole === 'admin' &&
          !(membership.get('role') === 'admin' && membership.get('status') === 'active')
            ? 1
            : 0;
        clearAssignments(tx, scenes, who.uid);
        const now = Timestamp.now();
        tx.set(memberRef(orgId, who.uid), {
          uid: who.uid,
          email: who.email,
          displayName: '',
          role: assignedRole,
          status: 'active',
          joinedAt: membership.get('joinedAt') ?? now,
        });
        tx.update(org.ref, {
          activeAdminCount: org.get('activeAdminCount') + increment,
          updatedAt: now,
        });
        tx.update(invitationRef, { status: 'accepted', acceptedUid: who.uid, acceptedAt: now });
        audit(tx, orgId, who.uid, 'invitation.accepted', invitationRef.id);
      });
      return { orgId };
    },

    async updateMember(request: CallableRequest) {
      const who = await actor(request);
      const data = object(request.data, ['orgId', 'uid', 'role', 'status']);
      const orgId = id(data.orgId);
      const uid = id(data.uid);
      const nextRole = role(data.role);
      const nextStatus = data.status;
      if (
        typeof nextStatus !== 'string' ||
        !['active', 'suspended', 'removed'].includes(nextStatus)
      )
        throw new HttpsError('invalid-argument', 'Invalid status.');
      await db.runTransaction(async (tx) => {
        const org = await administrator(tx, orgId, who);
        const target = await tx.get(memberRef(orgId, uid));
        if (!target.exists) throw new HttpsError('not-found', 'Membership not found.');
        const wasAdmin = target.get('status') === 'active' && target.get('role') === 'admin';
        const willBeAdmin = nextStatus === 'active' && nextRole === 'admin';
        const count = org.get('activeAdminCount') + Number(willBeAdmin) - Number(wasAdmin);
        if (count < 1)
          throw new HttpsError('failed-precondition', 'Keep at least one active administrator.');
        const scenes =
          nextStatus === 'removed' || target.get('status') === 'removed'
            ? await assignments(tx, orgId, uid)
            : [];
        clearAssignments(tx, scenes, uid);
        const now = Timestamp.now();
        tx.update(target.ref, {
          role: nextRole,
          status: nextStatus as Status,
          updatedAt: now,
          ...(nextStatus === 'removed' ? { removedAt: now } : {}),
        });
        tx.update(org.ref, { activeAdminCount: count, updatedAt: now });
        audit(tx, orgId, who.uid, 'membership.updated', uid, {
          previousRole: target.get('role'),
          previousStatus: target.get('status'),
          role: nextRole,
          status: nextStatus,
        });
      });
      return { updated: true };
    },

    async setSceneAccess(request: CallableRequest) {
      const who = await actor(request);
      const data = object(request.data, [
        'orgId',
        'sceneId',
        'accessMode',
        'assignedUserIds',
        'expectedVersion',
      ]);
      const orgId = id(data.orgId);
      const sceneId = id(data.sceneId);
      const mode = data.accessMode;
      if (mode !== 'organization' && mode !== 'assigned')
        throw new HttpsError('invalid-argument', 'Invalid access mode.');
      if (
        !Array.isArray(data.assignedUserIds) ||
        data.assignedUserIds.length > 100 ||
        !Number.isSafeInteger(data.expectedVersion) ||
        Number(data.expectedVersion) < 1
      ) {
        throw new HttpsError('invalid-argument', 'Invalid assignment list or version.');
      }
      const uids = data.assignedUserIds.map(id);
      if (new Set(uids).size !== uids.length || (mode === 'organization' && uids.length)) {
        throw new HttpsError(
          'invalid-argument',
          'Use unique assignments only for assigned scenes.',
        );
      }
      await db.runTransaction(async (tx) => {
        await administrator(tx, orgId, who);
        const scene = await tx.get(orgRef(orgId).collection('scenes').doc(sceneId));
        if (!scene.exists) throw new HttpsError('not-found', 'Scene not found.');
        if (scene.get('version') !== data.expectedVersion)
          throw new HttpsError('aborted', 'Scene changed; reload before retrying.');
        const members = uids.length
          ? await tx.getAll(...uids.map((uid) => memberRef(orgId, uid)))
          : [];
        if (members.some((member) => !member.exists || member.get('status') !== 'active')) {
          throw new HttpsError(
            'failed-precondition',
            'Assign active members of this organization only.',
          );
        }
        tx.update(scene.ref, {
          accessMode: mode,
          assignedUserIds: uids,
          version: Number(data.expectedVersion) + 1,
          updatedAt: Timestamp.now(),
        });
        audit(tx, orgId, who.uid, 'scene.access-updated', sceneId, {
          accessMode: mode,
          assignedUserIds: uids,
          version: Number(data.expectedVersion) + 1,
        });
      });
      return { version: Number(data.expectedVersion) + 1 };
    },

    async listMyOrganizations(request: CallableRequest) {
      const who = await actor(request);
      const data = object(request.data ?? {}, ['after']);
      let query = db
        .collectionGroup('members')
        .where('uid', '==', who.uid)
        .where('status', '==', 'active')
        .orderBy(FieldPath.documentId())
        .limit(25);
      if (data.after !== undefined) {
        const after = text(data.after, 300);
        const parts = after.split('/');
        if (
          parts.length !== 4 ||
          parts[0] !== 'organizations' ||
          parts[2] !== 'members' ||
          parts[3] !== who.uid
        ) {
          throw new HttpsError('invalid-argument', 'Invalid organization cursor.');
        }
        id(parts[1]);
        query = query.startAfter(after);
      }
      const memberships = await query.get();
      const organizations = [];
      for (const membership of memberships.docs) {
        if (membership.ref.path.split('/').length !== 4) continue;
        const org = await membership.ref.parent.parent!.get();
        if (org.exists)
          organizations.push({ id: org.id, name: org.get('name'), role: membership.get('role') });
      }
      return {
        organizations,
        next: memberships.size === 25 ? memberships.docs.at(-1)!.ref.path : null,
      };
    },
  };
}

# Organization backend (emulator-only verification)

This implements the backend policy and organization lifecycle used by [the Angular portal](../portal/README.md). No live provider/rules/functions deployment, database/bucket provisioning, first live administrator selection, or production bootstrap is performed. Keep the Phase 1 viewer proof separate.

## Run

Use repository-pinned pnpm, Node 24+, Java 21+, and materialized Git LFS assets for viewer regression checks. Install both independent dependency sets:

```text
pnpm install --frozen-lockfile
pnpm --dir functions install --frozen-lockfile
pnpm backend:check
```

`backend:check` uses the single active root `firebase.json`, compiles the backend and integration tests, starts dedicated `demo-omnipraxis` Auth/Functions/Firestore/Storage emulators, runs the tests, and stops services. Use `backend:emulators` plus `backend:test` in separate terminals for investigation. Tests refuse other projects or non-loopback emulator endpoints. Ports are Auth 9199, Functions 5101, Firestore 8280 (websocket 9151), Storage 9399, hub 4401 and logs 4501. Do not run a competing emulator suite at the same time. The separate Phase 1 config remains only a legacy viewer-proof fixture, not a production mode.

`functions/` has its own package/lockfile and build-script policy. It is not a conversion of the frontend into a package monorepo. Generated backend code/declarations live in ignored `functions/lib/`. The backend deployment target is Node 22, matching the [documented Firebase runtime](https://firebase.google.com/docs/functions/manage-functions#set_nodejs_version); the installed local emulator uses host Node 24 with a warning. Validate the actual deployment runtime before live release.

## Callable contract

All six callables require a verified Firebase identity, check the current Auth user (including disabled/email changes), validate exact payload keys/types and re-read organization permissions from Firestore. Membership authority is not stored in long-lived custom claims. Region is `us-central1`; runtime bounds are zero minimum instances, one maximum instance per function, 30 seconds, 256 MiB and concurrency one. These are not a project-wide spending cap.

| Callable              | Input                                                          | Behavior                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createInvitation`    | `orgId, email, role`                                           | Active admin; normalized email and `admin`/`viewer` role; random 256-bit token returned once, only SHA-256 stored; expires in seven days.                                  |
| `revokeInvitation`    | `orgId, invitationId`                                          | Admin-only; repeat revocation is harmless; accepted tokens cannot be revoked into another state.                                                                           |
| `acceptInvitation`    | `orgId, invitationId, token`                                   | Verified current email must match; token/status/expiry checked transactionally; same accepted UID may retry without duplicate membership/audit writes.                     |
| `updateMember`        | `orgId, uid, role, status`                                     | Admin-only; status `active`/`suspended`/`removed`; removal retains a tombstone and clears assignments. Role/status changes are audited.                                    |
| `setSceneAccess`      | `orgId, sceneId, accessMode, assignedUserIds, expectedVersion` | Admin-only; unique active same-org UIDs, at most 100; published/draft scene version checked before transactional assignment update. Scene creation/publication is Phase 4. |
| `listMyOrganizations` | `{ after? }`                                                   | Up to 25 active own memberships, safe organization summaries and an independent next cursor. No broad client collection-group discovery.                                   |

Never log invitation tokens or put them in audit entries. The portal accepts a same-origin invitation fragment and captures/scrubs it before routing; administrator issuance/sharing UI remains the next phase. No email delivery service was added.

An invitation cannot reactivate a suspended member. Removed members require an invitation issued after removal; reactivation clears any stale assignments. The issuer must still be an active administrator when a pending invitation is accepted. A fresh invitation does not silently change an existing member's role. Existing accepted-token retries never reactivate a subsequently removed member. Active-admin count is maintained under the organization transaction lock, so concurrent demotions cannot remove the last active admin. All writers of memberships must preserve this invariant.

Removal/reactivation cleans up at most 400 assigned scenes atomically, leaving room below Firestore's transaction write bound. Larger cases fail without partial changes and require operator assignment reduction before retrying. This bounds the current small-organization implementation; do not silently truncate cleanup. Membership tombstones and audit records are backend-owned. Organization deletion is not implemented; do not manually delete a parent while retaining its memberships/assets.

## Trusted bootstrap

`bootstrap` is not a callable. An operator supplies an existing, verified, enabled Auth UID and explicit project/organization/name. In the demo environment, use a shell connected to both emulators:

```powershell
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8280'
$env:FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9199'
node functions/lib/bootstrap.js demo-omnipraxis example VERIFIED_UID 'Example organization' --confirm-bootstrap
```

Unset those variables when leaving that shell. The tool refuses partially emulated Auth/Firestore connections and missing demo emulators. It is idempotent for an existing active initial admin, cannot overwrite an existing organization to assign a different admin, and records an audit entry only on creation. Live use requires separately authorized trusted credentials and the actual first administrator UID; it has not been run live.

## Rules, queries, and upload boundary

Root `firestore.rules` replaces the previous expiring allow-all template. All client metadata mutations are denied, including admin writes; validated backend commands are the only application writers. Admins may read their organization's member contact information, invitations, audits, drafts and historical revisions. Viewers may read their own membership and only permitted current published scenes/revisions. Parent existence is checked. Organization listings, broad viewer scene queries, cross-org requests, and unknown paths are denied. Lists require limits no larger than 50. Public-safe published `publicScenes` documents are explicitly anonymous.

`src/adapters/firebase/catalog.ts` runs exactly two constrained viewer queries: published organization-wide scenes and published assigned scenes containing the UID. Each has a 25-document page and separate cursor; results are deduplicated and sorted deterministically. Exhausted cursors are null. `firestore.indexes.json` contains these query indexes and the backend membership-discovery index. Emulators do not certify deployed composite-index readiness; verify these on the selected live database before cutover.

Storage revision reads require active membership plus the scene (at most two cross-service lookups). Viewers need the current published revision and organization-wide/explicit assignment; admins may read own-org drafts/history. Public tokenless media supports current public revisions, including byte ranges. The literal `deliveryEnabled` operator switch overrides binary reads while metadata/recovery remain available. No live switch was changed.

**Staging writes are deliberately denied for all clients in Phase 2.** The first integration test demonstrated that CLI 15.33.0's Storage emulator removes `firebaseStorageDownloadTokens` from the custom metadata exposed to rules and can generate tokens on Firebase uploads. A `metadata.keys().hasOnly([])` check did not reject an injected token. The installed `storage/metadata.js` and `storage/apis/firebase.js` confirm this behavior. Slot/type/size restrictions alone therefore do not prove the no-token/suspension boundary. Staging reads remain own-org admin-only; revision writes and metadata updates/deletes are denied.

Before enabling Phase 4 uploads, prove a controlled resumable upload path and immutable publication copy with no inherited/generated/injected download tokens or public IAM grants, then test direct token requests and suspension. Preserve quota, actor, expiry, fixed-slot/type/size and immutability checks in that implementation. Do not enable the old prototype upload rule as a shortcut. Phase 1's isolated prototype remains unchanged for historical loading proof only.

## Identity and verification limits

`src/adapters/firebase/identity.ts` uses the modular SDK for password signup/sign-in, Google popup/linking, verification/resend, reset, sign-out, and password setup on the current verified UID. Firebase requires recent sign-in for password changes. Identity signup alone grants no organization access. Existing credentials are never merged by matching a client-supplied email.

Tests exercise real emulator password verification/reset action codes, mocked Google credentials, same-UID password setup/sign-in, the callable HTTP boundary, two organizations, token expiry/revocation/replay, last-admin races, assignment changes, exact catalog pagination, still-valid-token revocation, Firestore/Storage access matrices, client-write attacks and suspension. Invalid credentials must be denied without writes; the Auth emulator is not evidence of real token-signature/OAuth validation. See [Auth emulator limitations](https://firebase.google.com/docs/emulator-suite/connect_auth).

The initial `linkWithCredential` password-addition test hit `auth/email-already-in-use`; inspection of the installed emulator's signup path showed its duplicate-email check precedes the link-token path. Password setup now uses the authenticated SDK `updatePassword` on the signed-in, verified user, preserving UID and testing both providers. This is not an email-based account merge. The portal now provides verification/reset/linking and account-switch/collision recovery UI, tested with the Auth emulator's provider popup. Real OAuth, provider configuration, authorized domains, email delivery, IAM/CORS and live cross-service rules remain pending live authorization.

I've set up prototype Security Rules to keep the data in Firestore safe. They are designed to be secure for verified organization membership, backend-only writes, scoped scene access and bounded queries. However, you should review and verify them before broadly sharing your app. If you'd like, I can help you harden these rules.

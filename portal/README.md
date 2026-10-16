# Angular portal

The portal implements sign-in, invitation acceptance, organization catalogs, administration and the viewer host. It uses the shared root `firebase.json`, with no phase selector. `pnpm dev`, `pnpm build` and `pnpm preview` now target Angular. Loopback development uses the demo backend; remote origins require explicitly supplied, reviewed production configuration. No live cutover has been performed.

## Run locally

Use Node 24.15+ (24.19 verified), pinned pnpm, Java 21+ and materialized Git LFS assets. In the first terminal:

```text
pnpm install --frozen-lockfile
pnpm --dir functions install --frozen-lockfile
pnpm backend:build
pnpm backend:emulators
```

In a second terminal:

```text
pnpm portal:seed
pnpm portal:dev
```

Open <http://127.0.0.1:4200>. Seeding resets local demo metadata and uploads the checked-in Drill Rig to the emulator; never use it for retained test data. The helper uses fixed local endpoints, with no live project selection. Emulator data is discarded on restart unless exported.

`pnpm portal:dev` builds the viewer artifacts and starts Angular. Seed a fresh emulator session once, then omit `portal:seed` when restarting only the frontend. The separate `viewer:dev`, `viewer:emulators`, `viewer:seed`, `viewer:test` and `viewer:test:browser` commands support the isolated viewer proof and its regression checks; they do not run the current portal. The application has no phase selector.

All demo accounts use test-only password `Portal-demo-only-123!`:

| Email                     | Access                                           |
| ------------------------- | ------------------------------------------------ |
| `viewer@example.test`     | Alpha's assigned Drill Rig; Beta's empty catalog |
| `admin@example.test`      | Administrator of Alpha and Beta                  |
| `outsider@example.test`   | No organization until invited                    |
| `unverified@example.test` | Verification required; no organization           |

Google opens the Auth emulator's simulated provider widget. Verification/reset links appear in the emulator terminal. Sign in as the demo administrator and open `/organizations/alpha/admin` to manage invitations/members, create scenes, upload prepared environments, preview and publish immutable revisions, replace/rollback or archive. No live upload/deployment is enabled.

## Routes and verification

`/` shows three anonymous demonstrations at `/base`, `/circuit-breaker` and `/pressure-gauge`. `/drill-rig` requires verified sign-in and organization selection; it grants no membership. Organization catalogs/viewers use `/organizations/:orgId/scenes[/sceneId]`. `/login` also supports Google linking and password setup for the current verified UID. `/invite#orgId=…&invitationId=…&token=…` captures and removes the fragment before routing. Secrets remain in memory; refreshing requires the original invitation link.

```text
pnpm portal:build
pnpm portal:preview
pnpm portal:check
```

The build outputs `build/portal/browser`; the local preview supports SPA refreshes. No scene binaries or props are copied into this output; `web:check` enforces this. The seed imports the three public demonstrations and their props into versioned demo Storage paths. Angular imports only emitted viewer API declarations. React/Spark/physics load on scene routes, never catalog/account routes. After renderer source edits, rebuild/restart `portal:dev` to regenerate its artifacts.

`portal:check` builds backend/viewers/portal, typechecks browser fixtures, starts demo emulators, tests the built portal in installed Edge and stops services. It needs free ports 4200/9199/5101/8280/9151/9399/4401/4501. Stop a manually running emulator suite first. `backend:check` verifies policy separately; `viewer:check` retains the historical compatibility fixture. Evidence stays under ignored `build/`.

## Access and delivery boundaries

Private viewers wait for server-confirmed membership and scene metadata, verify revision identity and asset checksums, then mount one session. Navigation, logout, access removal and revision changes dispose it. Revisions require explicit **Reopen scene**. An in-flight Firebase `getBlob` may finish transferring after cancellation but cannot mount a stale session. Downloaded bytes cannot be recalled.

The operator/backend-owned `publicSettings/delivery` document contains **only** `{ downloadsEnabled: boolean }`. Missing/unreadable/malformed status fails closed; resumption never automatically reopens a scene. It is a public-safe availability projection, not binary authorization. Upload callables also require this flag. Operators must coordinate it with Storage's `deliveryEnabled` enforcement. No live rule/document was changed.

## Prepared environment administration

Create/select a scene, set organization-wide or explicit member access, then choose gzip SPZ v2/v3, a static self-contained collider GLB and a noninterlaced 8-bit RGB/RGBA PNG. Caps are 100 MiB/100 MiB/5 MiB; PNG dimensions up to 2048×2048, SPZ up to 3 million points/128 MiB decoded, and collider up to one million instanced triangles. External resources/extensions/animations/skins/textures are rejected for colliders. Spawn coordinates use meters and angles use radians.

Start transfer, pause after an acknowledged chunk, then resume with the original files. Network failures leave acknowledged offsets intact. Navigation pauses transfer; select the session and reselect identical files to resume, or cancel it. Automatic browser-restart recovery is not promised. A lost server operation may retain its lease for up to 20 minutes before retry/cleanup; the UI reports the running-operation error.

After transfer, explicitly validate. Validation errors leave the current published scene unchanged. Cancel malformed sessions to release reserved quota; transient/expired validation may be retried. Ready revisions offer **Preview revision** and **Publish / rollback**. Preview loads the actual immutable files, not staging. Publishing/rolling back closes active viewer sessions with an explicit reopen action. Archiving blocks viewers and preserves revisions. Concurrent edits/publication require refreshing before retry.

Only the server writes Storage, through authenticated 1 MiB chunk commands. No Firebase upload/download tokens or signed/bearer upload URLs are handed to the browser. This costs more backend requests than direct uploads; measure actual cloud usage before release. The managed-asset ledger reserves staging plus revision bytes, permits one active upload per admin/two per organization, and retains reservation until cleanup succeeds. See [backend operations](../functions/README.md) for cleanup, quotas and live-release gates.

The public adapter bundles the three compiled templates separately from the environment-only viewer API. Public Demo API v2 accepts resolved, checksum-verified asset URLs plus a revision-scoped page resolver, readiness/completion callbacks and disposal; it receives no Firebase identity. Public RAD pages remain lazy, anonymous and tokenless. Replacement closes public and private viewers and requires reopening. The scene adapters preserve local defaults for legacy/desktop compatibility; the Angular host supplies every asset. See [cloud cutover](../docs/cloud-cutover.md) for trusted imports, runtime configuration and the live/privacy gates. Existing repository history/deployments have not been retired by a local build; production confidentiality and complete cost suspension are not certified.

Physical devices, all scripted training interactions and actual completion exports still need manual acceptance. Browser input smoke checks do not certify real OAuth, live IAM/CORS/indexes or production deployment.

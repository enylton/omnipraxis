# Angular portal

The portal implements sign-in, invitation acceptance, organization catalogs and the viewer host. It uses the shared root `firebase.json` and demo backend, with no phase selector. The original `pnpm dev` and deployment target remain the legacy application until production cutover.

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

All demo accounts use test-only password `Portal-demo-only-123!`:

| Email                     | Access                                           |
| ------------------------- | ------------------------------------------------ |
| `viewer@example.test`     | Alpha's assigned Drill Rig; Beta's empty catalog |
| `admin@example.test`      | Administrator of Alpha and Beta                  |
| `outsider@example.test`   | No organization until invited                    |
| `unverified@example.test` | Verification required; no organization           |

Google opens the Auth emulator's simulated provider widget. Verification/reset links appear in the emulator terminal. Administrator invitation issuance, member management and publishing UI belong to the next phase. Tests create invitations through the backend service and exercise actual callable acceptance.

## Routes and verification

`/` shows three anonymous demonstrations at `/base`, `/circuit-breaker` and `/pressure-gauge`. `/drill-rig` requires verified sign-in and organization selection; it grants no membership. Organization catalogs/viewers use `/organizations/:orgId/scenes[/sceneId]`. `/login` also supports Google linking and password setup for the current verified UID. `/invite#orgId=…&invitationId=…&token=…` captures and removes the fragment before routing. Secrets remain in memory; refreshing requires the original invitation link.

```text
pnpm portal:build
pnpm portal:preview
pnpm portal:check
```

The build outputs `build/portal/browser`; the local preview supports SPA refreshes and byte ranges. Angular imports only emitted viewer API declarations. React/Spark/physics load on scene routes, never catalog/account routes. After renderer source edits, rebuild/restart `portal:dev` to regenerate its artifacts.

`portal:check` builds backend/viewers/portal, typechecks browser fixtures, starts demo emulators, tests the built portal in installed Edge and stops services. It needs free ports 4200/9199/5101/8280/9151/9399/4401/4501. Stop a manually running emulator suite first. `backend:check` verifies policy separately; `viewer:check` retains the historical compatibility fixture. Evidence stays under ignored `build/`.

## Access and delivery boundaries

Private viewers wait for server-confirmed membership and scene metadata, verify revision identity and asset checksums, then mount one session. Navigation, logout, access removal and revision changes dispose it. Revisions require explicit **Reopen scene**. An in-flight Firebase `getBlob` may finish transferring after cancellation but cannot mount a stale session. Downloaded bytes cannot be recalled.

The operator/backend-owned `publicSettings/delivery` document contains **only** `{ downloadsEnabled: boolean }`. Missing/unreadable/malformed status fails closed; resumption never automatically reopens a scene. It is a public-safe availability projection, not binary authorization. Operators must coordinate it with Storage's `deliveryEnabled` enforcement and future upload checks. No live rule/document was changed.

The public adapter temporarily bundles the three original scripted scenes separately from the environment-only viewer API. The portal copies only their public assets/shared props; Drill Rig is excluded from its build and loaded from authorized emulator Storage. Phase 5 will inject controlled cloud URLs into the public templates. Until cutover, the repository/history, legacy application and existing deployments retain previous delivery behavior. Production confidentiality and complete cost suspension are not certified.

Physical devices, all scripted training interactions and actual completion exports still need manual acceptance. Browser input smoke checks do not certify real OAuth, live IAM/CORS/indexes or production deployment.

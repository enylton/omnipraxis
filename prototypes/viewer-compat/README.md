# Viewer compatibility harness

This isolated host checks the emitted Viewer API v1 artifact against real SPZ, RAD, RADC and GLB fixtures. It is not a second web application or a production Firebase configuration. Its Firestore and Storage rules serve only the dedicated `demo-omnipraxis-viewer` emulators; current application access policy is tested by the backend and Angular portal suites.

Run `pnpm viewer:check` for the complete automated proof. It builds the viewer and desktop renderer, starts and stops the fixture emulators and test servers, runs contract and browser checks, and writes `build/viewer-compat/viewer-check.json`. Use Node 24, the pinned pnpm, Java 21 or newer, materialized Git LFS assets and Microsoft Edge. See [the upstream update procedure](../../docs/upstream-viewer-updates.md) for manual acceptance and rollback.

For interactive work, start `pnpm viewer:emulators`, run `pnpm viewer:build`, then `pnpm viewer:seed` and `pnpm viewer:dev` in separate terminals. `pnpm viewer:test` runs the Node contract tests; `pnpm viewer:test:browser` seeds the fixtures and starts its own Vite servers on ports 4174 and 4175. Keep those ports free.

The checks cover the versioned artifact and declarations, a plain TypeScript consumer, descriptor validation, local SPZ/RAD rendering, lazy public paging, Drill Rig loading, checksum rejection, cancellation, and repeated open/close cleanup. The second Vite server serves only static fixture assets. Current portal routes and application security are covered by `pnpm portal:check` and `pnpm backend:check`.

Fixture seeding refuses any project other than `demo-omnipraxis-viewer`. This suite does not certify cloud IAM, App Check, token expiry, live suspension, costs, or device acceptance; those gates remain in [the migration plan](../../docs/angular-firebase-migration-plan.md).

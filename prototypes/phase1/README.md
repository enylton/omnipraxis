# Phase 1: scene contracts and Storage loading proof

This is an isolated emulator prototype. It does not replace the web router, introduce Angular, deploy rules, or migrate production assets. Its Firebase configuration deliberately uses `demo-omnipraxis-phase1`, loopback emulator ports, and mock verified identities. Fixture seeding refuses a different project and resets only the dedicated prototype emulators.

The user selected `us-central1` for future cloud resources, then confirmed emulator-only verification because the live project has billing disabled. Do not deploy this prototype configuration or upgrade billing as part of Phase 1.

## Run

Use Node 24, the repository-pinned pnpm, Java 21 or newer, fetched Git LFS assets, and installed Microsoft Edge for browser tests.

For the complete automated compatibility check, run `pnpm viewer:check` with test ports free. It builds the required entries, manages dedicated demo emulator startup/shutdown, runs the tests, and records `build/phase1/viewer-check.json`. See `docs/upstream-viewer-updates.md` for the review and manual acceptance requirements. The following commands are for interactive prototype development instead.

1. Install dependencies with `pnpm install --frozen-lockfile`.
2. Start the dedicated emulators: `pnpm viewer:emulators`.
3. In another terminal, build the portable viewer: `pnpm viewer:build`.
4. Run `pnpm viewer:test`. This verifies the built public API artifact, compiles the prototype rules, seeds real local SPZ/GLB/RAD/RADC assets, and runs the contract/access tests.
5. Run `pnpm viewer:dev` and open the displayed loopback URL. Alternatively, keep ports 4174/4175 free and run `pnpm viewer:test:browser`; it starts/stops its own Vite servers and refuses already-running ones.

`pnpm viewer:seed` resets and seeds the fixtures without running tests. The browser configuration uses the installed Edge channel; it does not download a browser. Rebuild the viewer after changes. Both `viewer:test` and browser tests now require its JavaScript, CSS, manifest, and public declarations. See `docs/viewer-api.md` for the artifact contract. Command names describe the viewer harness; historical fixture paths and the isolated demo project ID are unchanged.

## What this proves

- A versioned, framework-independent environment descriptor scopes asset paths to its organization/public scene and immutable revision. It validates formats, byte bounds, checksums, spawn values, and rejects private paging for this release.
- `build/viewer/viewer.js` is a self-contained ESM mount/dispose boundary with generated declarations under `build/viewer/types/`. The vanilla TypeScript host loads this artifact rather than compiling React TSX. `src/adapters/firebase/sceneAssets.ts` validates the cloud descriptor and resolves downloads into a neutral `ViewerScene`. The viewer accepts resolved URLs/formats, an opaque session label, spawn configuration, and generic callbacks; it does not receive organization records, Storage paths, or Firebase clients. The host passes the adapter's disposal function as `releaseAssets` so closing still releases session object URLs.
- Verified assigned members can load Drill Rig and a private Base Scene test copy. Unassigned, cross-organization, suspended, missing, anonymous, and unverified identities are denied through rules rather than UI filtering.
- Direct downloads are checked against descriptor lengths and SHA-256 before object URLs are created. The viewer spawns only after its SPZ and physics GLB are ready.
- Anonymous Circuit Breaker paging uses tokenless Storage media endpoints, including byte ranges. A per-instance Spark metadata adapter resolves every page filename within the same revision; it does not modify global fetch or predownload the environment.
- An emulator-tested rules switch denies public/private binary reads and staging writes while retaining authorized metadata reads. It is an operator policy proof, not an automated billing integration.
- Browser tests cover a neutral scene using local asset URLs without Firebase metadata, actual Drill Rig rendering, ten Base Scene open/close cycles, public paging, canceled loading, modified binary rejection, and rendering all four existing web scenes under Strict Mode. Screenshots and the measured lifecycle receipt are written only under ignored `build/phase1/`.

## Limits and handoff

Live bucket IAM, CORS, cross-service rule permissions, regional latency, production billing, and actual invitation/login providers remain unverified. Mock identities are only test fixtures; invitation and organization administration belong to Phase 2. The default production Firestore rules and web deployment remain unchanged.

Firebase `getBlob` does not expose an AbortSignal: canceling prevents stale mounts and URL allocation, but an SDK request already in progress may finish. This prototype does not promise that canceling stops billed network transfer. Production transfer controls require the live checks in the plan.

The host owns Firebase clients for its lifetime. Each viewer owns its canvas, model cache entries, object URLs, input listeners, and rendering resources. GPU teardown is exercised through Spark and Three disposal/context loss; the browser counters are not a measurement of dedicated VRAM. R3F retains one last-rendered loop state; the lifecycle test allows that single detached tree and rejects per-session growth. The host loads the built `viewer.css`; it no longer imports `src/index.css`. Browser checks also mount SPZ/RAD viewers in a plain HTML host that loads only the built viewer files and scene assets.

The verification receipt is recorded in `docs/migration-checkpoint.md`. Phase 2 has not started.

I've set up prototype Security Rules to keep the data in Firestore safe. They are designed to be secure for the fixture model by denying client writes, limiting private metadata to verified permitted members, and exposing only published public demonstration metadata. However, you should review and verify them before broadly sharing your app. If you'd like, I can help you harden these rules.

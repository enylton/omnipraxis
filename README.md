# omnipraxis

A platform for building immersive, intelligent, and interactive professional training experiences and spatial simulations.

## Tech Stack

**Core Framework**

- Angular — Web portal and routing.
- Vite — Viewer and desktop renderer builds.
- TypeScript — Static typing and tooling.
- React — Viewer and desktop runtime.
- Zustand — Global state management.

**3D & XR**

- Three.js (three) — Real-time 3D rendering engine.
- React Three Fiber (@react-three/fiber) — React renderer for Three.js scene management.
- React Three Drei (@react-three/drei) — Utility components for R3F.
- React Three XR (@react-three/xr) — WebXR integration for VR/AR experiences.
- Spark (@sparkjsdev/spark) — Gaussian splat rendering for real-time scene representation.

**Physics**

- Rapier (@react-three/rapier) — Physics engine for collision and simulation.

**AI**

- Convai (@convai/web-sdk) — Conversational AI integration.

**Development Tools**

- Leva — Real-time debug UI and parameter controls.
- ESLint — Code linting and quality enforcement.
- Prettier — Code formatting.
- pnpm — Package manager.

## Setup

### Requirements

- Node.js 24 LTS+
- pnpm 12.11.2

## Installation

Install dependencies:

```bash
pnpm install
```

> Note: If pnpm reports blocked build scripts (e.g. `unrs-resolver`), run:
>
> ```bash
> pnpm approve-builds
> ```

## Development

Start the demo backend in one terminal:

```bash
pnpm backend:build
pnpm backend:emulators
```

In another terminal, seed a fresh emulator session with `pnpm portal:seed`, then run `pnpm dev` (equivalent to `pnpm portal:dev`). Open <http://127.0.0.1:4200>. Seeding resets local demo metadata; omit it when restarting only the frontend. Install the backend dependencies with `pnpm --dir functions install --frozen-lockfile` on a new checkout. See [the portal guide](portal/README.md) for prerequisites, demo accounts and verification.

The web build and Firebase Hosting configuration use Angular and exclude scene binaries. The isolated viewer compatibility harness lives under `prototypes/viewer-compat/`; run `pnpm viewer:check` for its emulator and browser proof. Live deployment remains pending; see [cloud cutover](docs/cloud-cutover.md).

## Scenes

The root application route displays the public demo catalog. The current routes include:

- `/base`, `/circuit-breaker` and `/pressure-gauge` for anonymous demonstrations loaded from controlled Storage paths.
- `/drill-rig` for verified sign-in and organization selection; restricted viewing uses organization scene routes.

Angular supports client-side history navigation; the prepared Firebase Hosting configuration rewrites deep links to the portal. Pages deployment has been retired in source, but existing public deployments/history still require operator cleanup before claiming Drill Rig confidentiality.

Scene rendering is provided by the emitted viewer module. See [the portal guide](portal/README.md) and [architecture](docs/architecture.md) for the current catalog and viewer flow.

## Windows Desktop

The Tauri desktop entry mounts `BaseScene` directly without scene routing or Convai. Its release layout is:

```text
Omnipraxis/
├── Omnipraxis.exe
├── splats.spz
└── colliders.glb
```

Close the application before replacing both scene files, preserve their filenames, and restart it to load the replacement pair. Replacement assets must share the same origin, scale, orientation, visual/collider alignment, and `[0, 0, 0]` spawn convention. The collider must be a self-contained GLB 2 file and the splat must be a gzip-compressed SPZ file.

Run the desktop app in development:

```bash
pnpm desktop:dev
```

Build only the desktop renderer on any supported development platform:

```bash
pnpm desktop:renderer:build
```

Create the native executable on Windows:

```bash
pnpm desktop:build
```

The manual `Build Windows desktop app` GitHub Actions workflow produces an unsigned `omnipraxis-windows-x64` artifact containing the `Omnipraxis` folder shown above. The portable executable requires Microsoft Edge WebView2 on the target machine; the current spike does not bundle or install WebView2 and is not code-signed.

## Build

Create a production build:

```bash
pnpm build
```

Output is `build/portal/browser`; `pnpm web:check` rejects scene binaries in it. Production configuration and live rollout are separate steps in [cloud cutover](docs/cloud-cutover.md).

## Preview

Preview the production build locally:

```bash
pnpm preview
```

## Lint

Run ESLint:

```bash
pnpm lint
```

## Format

Format the codebase with Prettier:

```bash
pnpm format
```

# Omnipraxis Platform Architecture

This document describes Omnipraxis as a reusable scene-authoring platform. It does not document any specific training scenario, authored content, or scene-local state machine.

The core architectural boundary is between the platform runtime and a scene specification.

- The platform runtime owns input, player movement, centered interaction targeting, UI overlays, generic overlay controls, session-scoped event recording, Spark renderer setup, physics setup, and reusable asset/effect abstractions.
- A scene specification owns asset URLs, component composition, transforms, local state, effect parameters, and scene-specific labeled interactions.

## Runtime Stack

The web entry uses `SceneRouter.tsx` to select the root scene index, an unknown-route page, or a registered scene from the current pathname. `App.tsx` adds web-only services such as Convai to `RuntimeApp.tsx`, which composes the reusable runtime shell for a selected scene. The desktop entry bypasses routing and mounts `BaseScene` directly in `RuntimeApp` without Convai.

```mermaid
flowchart TD
  Main[Web main.tsx] --> Router[SceneRouter]
  Router --> Index[DOM Scene Index]
  Router --> NotFound[DOM Not-Found Page]
  Router --> App[App.tsx]
  App --> ConvaiRuntime[ConvaiRuntime]
  App --> RuntimeApp[RuntimeApp.tsx]

  DesktopMain[Desktop main.tsx] --> DesktopRoot[DesktopRoot]
  DesktopRoot --> RuntimeApp
   RuntimeApp --> EventLogRuntime[EventLogRuntime]
   EventLogRuntime --> Canvas[R3F Canvas]

  Canvas --> SparkRuntime[SparkRuntime]
  Canvas --> InputRuntime[InputRuntime]
  Canvas --> UIRuntime[UIRuntime]

  UIRuntime --> Suspense[Suspense]
  Suspense --> Physics[Rapier Physics World]
  Physics --> PlayerRuntime[PlayerRuntime]
  PlayerRuntime --> Scene[Scene Specification]
```

## Windows Desktop Boundary

The Tauri desktop host is a platform adapter around the shared browser renderer. It embeds the routing-free desktop Vite output in the native executable, validates the external BaseScene files, and exposes only those exact paths to WebView2 through Tauri's asset protocol.

```mermaid
flowchart LR
  Exe[Omnipraxis.exe] --> Tauri[Tauri Host]
  Splats[splats.spz] --> Validation[Native Validation]
  Colliders[colliders.glb] --> Validation
  Tauri --> Validation
  Validation --> Scope[Dynamic Asset Protocol Scope]
  Scope --> DesktopRoot[DesktopRoot]
  DesktopRoot --> RuntimeApp[RuntimeApp without Convai]
  RuntimeApp --> BaseScene[BaseScene]
```

Release builds resolve `splats.spz` and `colliders.glb` from the executable directory. Debug builds use `public/scenes/base/`, while `OMNIPRAXIS_SCENE_DIR` provides an explicit development override. The host checks file readability, the SPZ gzip signature, and GLB 2 header/length before returning protocol URLs. Loader or render failures are surfaced by the desktop error UI instead of intentionally falling back to embedded scene assets.

The desktop renderer uses a dedicated Vite configuration with `base: './'`, `publicDir: false`, and `build/desktop` output. This prevents the web scene index, Convai integration, and complete public asset tree from becoming part of the desktop renderer. Its CSP permits `data:` fetches and workers because Spark initializes trusted embedded WASM and provides a data-worker fallback. The current portable artifact depends on an installed Evergreen WebView2 runtime and is intentionally unsigned while feasibility is evaluated.

## Scene URL Routing

Scene routing is a platform concern outside the R3F runtime. `sceneManifest.ts` defines stable public slugs and display metadata without importing React, while `sceneRegistry.ts` maps every slug to a prop-free scene component. `sceneRoute.ts` strips `import.meta.env.BASE_URL`, resolves the initial pathname, and rejects unknown or nested paths.

```mermaid
flowchart LR
  Pathname[window.location.pathname] --> Resolver[Scene Route Resolver]
  Manifest[Scene Manifest] --> Resolver
  Registry[Scene Component Registry] --> Resolver
  Resolver --> Index[Scene Index]
  Resolver --> NotFound[Not Found]
  Resolver --> ActiveScene[Active Scene]
  ActiveScene --> App[Runtime App]
```

The root `/omnipraxis/` route renders a DOM scene index outside the Canvas. Scene links preserve the current query string and hash, call `history.pushState`, and update the selected route without requesting another document. `SceneRouter` listens for `popstate` so browser Back and Forward restore the corresponding route. The runtime `App` is keyed by scene slug, ensuring that player, physics, UI, input-device, Convai, and scene-local state do not leak between active scene sessions.

GitHub Pages currently serves only the root `index.html` and does not rewrite arbitrary paths to that shell. Consequently, a nested scene URL works after navigation from the loaded scene index, but directly loading or refreshing that URL returns a Pages 404. A future build step can use the React-free manifest to emit identical processed HTML shells at each registered scene path; the initial-path resolver already supports those direct entries without further runtime changes.

Firebase Hosting uses separate production and pull-request preview workflows. Both check out Git LFS assets, select Node 24 and the pnpm version from `package.json`, install frozen dependencies, lint, and run `pnpm build --base=/`. Hosting publishes the resulting `dist` directory and rewrites unmatched paths to `index.html`, allowing direct scene entry and refresh at the domain root. GitHub Pages continues to build independently with the default `/omnipraxis/` base; both deployments reuse the existing route resolver and scene runtime.

## Scene Authoring API Surface

A scene specification should compose platform-provided primitives rather than directly binding to lower-level libraries when a platform abstraction exists.

```mermaid
flowchart LR
  Scene[Scene Specification]

  Scene --> GltfModel[GltfModel]
  Scene --> SplatModel[SplatModel]
  Scene --> SplatEdit[SplatEdit]
  Scene --> ParticleEmitter[ParticleEmitter]
  Scene --> PlayerAPI[usePlayer]
  Scene --> AutomaticInputAPI[useAutomaticInput]
  Scene --> UIAPI[useUI]

  PlayerAPI --> Spawn[spawn]
  PlayerAPI --> HeldItem[setHeldItem]
  PlayerAPI --> IdleTime[read idle time]
  PlayerAPI --> Orientation[read orientation snapshot]

  AutomaticInputAPI --> AutomaticInput[scene-owned semantic input]

  UIAPI --> Feedback[showScreenFeedback]

  GltfModel --> GLBLoading[GLB loading and cloning]
  GltfModel --> OptionalPhysics[optional Rapier physics]
  GltfModel --> Interaction[labeled interactions]
  GltfModel --> MaterialFeedback[opacity and target feedback]

  SplatModel --> SparkSplat[Spark SplatMesh]
  SplatEdit --> SparkEdit[Spark SplatEdit and SDF]
  ParticleEmitter --> ProceduralSplats[procedural Spark splats]
```

## Ownership Boundaries

Platform runtime systems should own persistent cross-scene behavior. Scene specifications should own authored content and local behavior.

```mermaid
flowchart TD
  subgraph PlatformRuntime[Platform Runtime]
    InputRuntime
    PlayerRuntime
    UIRuntime
    SparkRuntime
    ConvaiRuntime
    GltfModelRuntime[GltfModel abstraction]
    PhysicsRuntime[Rapier world]
  end

  subgraph SceneSpecification[Scene Specification]
    SceneAssets[asset URLs]
    SceneLayout[spatial placement]
    SceneState[scene-local state]
    SceneInteractions[labeled interactions]
    SceneEffects[effect parameters]
  end

  SceneSpecification --> PlatformAPI[Platform APIs and Components]
  PlatformAPI --> PlatformRuntime
```

## Platform Responsibilities

The shared runtime provides these reusable capabilities to mounted scene specifications. Platform adapters can add environment-specific services around that shell.

- `Canvas` and render-loop hosting through React Three Fiber.
- `SparkRuntime` for `SparkRenderer` setup.
- `InputRuntime` for keyboard, mouse, touch, a frame-polled standard gamepad, pointer lock, and resolving composable semantic input sources.
- `PlayerRuntime` for spawn lifecycle, centered interaction targeting, held items, fixed-step latched interaction consumption, and registering the current interaction overlay button.
- `PlayerController` for fixed-step walk/run movement and camera yaw/pitch, Rapier character-controller movement, and held-item mounting.
- `UIRuntime` for screen tint, top-center screen messages, reticle DOM overlay rendering, and generic keyed overlay buttons.
- The web `App` adds `ConvaiRuntime` for the stock Convai widget overlay; the desktop adapter intentionally omits it.
- `GltfModel` for GLB loading, cloning, opacity, material feedback, interaction targeting, optional physics, and blocking behavior.
- `GltfModel` also owns per-instance animation mixers and imperative per-clip playback/pose control. Scenes own operation locks and the meaning of animation completion.
- `SplatModel` for Spark splat loading and scene-scoped child Spark edit nodes.
- `SplatEdit` for Spark SDF edit operations without scene code importing Spark internals.
- `ParticleEmitter` for procedural Spark-based particle effects.
- `EventLogRuntime` for a session-scoped event service accessible both inside the Canvas and to platform adapters. `RuntimeApp` accepts a scene identifier and an optional completion callback; the web adapter supplies JSON download, while the desktop adapter currently supplies no export callback.

## Scene Specification Responsibilities

A scene specification provides authored content and scene-specific logic.

- A scene entry at `src/scenes/<slug>/scene.tsx`, renderable without props and registered through the scene manifest and component registry. Keep descriptive named exports such as `BaseScene`, `CircuitBreakerScene`, and `PressureGaugeScene`.
- Scene-local supporting modules beside the entry component, such as `src/scenes/pressure-gauge/pressure.ts`. Folder names match route slugs; `sceneManifest.ts`, `sceneRegistry.ts`, and `sceneRoute.ts` stay directly under `src/scenes/`.
- Asset URLs using `import.meta.env.BASE_URL` where assets are loaded from public paths.
- Component composition using platform primitives.
- Spatial placement through positions, rotations, scales, and visibility/opacity controls.
- Scene-local state and transitions.
- Labeled `PlayerInteraction` objects passed into platform components.
- Effect parameters for particles, splat edits, lights, and other scene-owned effects.
- Calls into `usePlayer` for player spawning and held-item state.
- Reads player idle time and orientation snapshots when scene-local behavior needs them.
- Registers scene-local automatic input sources through `useAutomaticInput`.
- Calls into `useUI` for screen feedback when scene-local logic needs it.
- Records domain facts through `useEventLog` at accepted actions and logical transitions, supplies its initial domain state when the session starts, and explicitly completes the session when training finishes.

## Scene Specification Should Not Own

These responsibilities should remain in the platform runtime unless the platform API changes intentionally.

- Low-level keyboard, mouse, touch, or gamepad handling.
- Pointer lock setup.
- Player movement or camera yaw/pitch implementation.
- Centered raycaster computation.
- DOM overlay roots inside the R3F tree.
- Interaction overlay button rendering or layout.
- Spark renderer setup.
- Raw Spark imports when a platform wrapper exists.
- Raw `useGLTF` calls when `GltfModel` can represent the asset.
- Global physics-world setup.

## Interaction Targeting Flow

Interaction targeting is owned by the player runtime. Scenes provide labeled interactions, but do not own input collection, raycaster centering, or overlay button rendering.

```mermaid
sequenceDiagram
  participant Keyboard as KeyboardInputDevice
  participant Mouse as MouseInputDevice
  participant Touch as TouchInputDevice
  participant Gamepad as GamepadInputDevice
  participant UserInput as userInput composite
  participant CombinedInput as combinedInput composite
  participant Player as PlayerRuntime
  participant UI as UIRuntime
  participant Model as GltfModel
  participant Scene as Scene Specification

  Keyboard->>UserInput: position velocity and interact latch
  Mouse->>UserInput: orientation deltas
  Touch->>UserInput: position velocity and orientation deltas
  Gamepad->>UserInput: velocities, run state, and interact edge
  UserInput->>CombinedInput: resolve cached user input
  Player->>Player: center R3F raycaster
  Player->>Model: R3F pointer events
  Model->>Player: set or clear current labeled interaction
  Player->>UI: register or clear player-interaction overlay button
  CombinedInput->>Player: fixed-step latched interact requested
  UI->>Player: overlay button pressed
  Player->>UserInput: trigger latched interact
  Player->>Scene: invoke current scene action
```

## UI Feedback And Overlay Flow

UI feedback and overlay controls are platform services. Scene specifications request feedback through `useUI`, while platform runtimes such as `PlayerRuntime` can register generic overlay buttons by stable ID. `UIRuntime` owns rendering, timing, placement, and styling.

```mermaid
sequenceDiagram
  participant Scene as Scene Specification
  participant UIContext as UIContext
  participant Player as PlayerRuntime
  participant UIRuntime as UIRuntime
  participant DOM as Separate DOM Overlay

  Scene->>UIContext: showScreenFeedback(tint, message, messageColor, duration)
  UIContext->>UIRuntime: update feedback state
  Player->>UIContext: setOverlayButton(id, button or null)
  UIContext->>UIRuntime: update keyed overlay buttons
  UIRuntime->>DOM: render screen tint, message, reticle, and overlay buttons
  UIRuntime->>UIRuntime: count down duration
  UIRuntime->>DOM: clear expired tint/message and removed buttons
```

## Rendering And Asset Abstractions

Rendering details are hidden behind platform components. Scene specifications should express intent through these components instead of reaching into renderer internals.

```mermaid
flowchart LR
  Scene[Scene Specification]

  Scene --> GltfModel
  GltfModel --> Drei[Drei useGLTF and Clone]
  GltfModel --> Three[Three material management]
  GltfModel --> Rapier[optional Rapier RigidBody]

  Scene --> SplatModel
  SplatModel --> SparkMesh[Spark SplatMesh]

  Scene --> SplatEdit
  SplatEdit --> SparkEdit[Spark SplatEdit and SplatEditSdf]

  Scene --> ParticleEmitter
  ParticleEmitter --> SparkProcedural[Spark procedural SplatMesh]

  SparkRuntime --> SparkRenderer[SparkRenderer]
```

## Input And Player Boundary

Input devices write to independent semantic states. Composite sources resolve the user-device states into `userInput`, scene-owned automatic states into `automaticInput`, and those two aggregates into the final player input. Player systems consume the final aggregate, while idle-time tracking reads the cached user aggregate. Scenes interact with the player and automatic-input registration through narrow APIs.

```mermaid
flowchart TD
  KeyboardDevice[KeyboardInputDevice] --> UserInput
  MouseDevice[MouseInputDevice] --> UserInput
  TouchDevice[TouchInputDevice] --> UserInput
  GamepadDevice[GamepadInputDevice] --> UserInput
  SceneAutomatic[Scene Automatic Inputs] --> AutomaticInput

  UserInput --> CombinedInput
  AutomaticInput --> CombinedInput
  CombinedInput --> PlayerController
  UserInput --> PlayerRuntime

  PlayerController --> Movement[fixed-step movement]
  PlayerController --> Camera[yaw and pitch camera]
  PlayerRuntime --> Targeting[centered interaction targeting]
  PlayerRuntime --> InteractionButton[player-interaction overlay button]
  PlayerRuntime --> HeldItem[held item mount]

  Scene[Scene Specification] -->|usePlayer| PlayerRuntime
  Scene -->|useAutomaticInput| SceneAutomatic
  Scene -->|usePlayer.setHeldItem| PlayerRuntime
```

Input states remain device-agnostic. Position and orientation each expose delta and velocity modalities. Deltas are resolved spatial displacements consumed once, while velocities are persistent controls integrated by the owning runtime. The current non-XR player consumes position and pitch/yaw orientation input during fixed physics steps; vertical position velocity and roll orientation input remain unused by the current yaw/pitch player hierarchy.

Composite inputs add deltas and velocities and combine run and interaction state. `InputRuntime` resolves the complete composite once after polling devices, so the cached user aggregate supports idle-time tracking without another device traversal. The player normalizes combined horizontal velocity when its magnitude exceeds one. Position velocity is scaled by walk or run speed and the fixed physics timestep. Orientation velocity is scaled by turn speed and the same fixed timestep, while orientation deltas have already been resolved by their source and are not speed-scaled. Pending deltas are applied and cleared by the first eligible physics step; velocities and held run state persist until their sources change or reset.

Keyboard WASD provides position velocity, either Shift key contributes held run state, and non-repeated `KeyE` requests interaction. Mouse movement and unclaimed touch drags provide orientation deltas, while touch movement uses a transient lower-left floating joystick. Touch interaction is performed through the player-owned overlay button rendered by `UIRuntime`, not by `TouchInputDevice`.

`GamepadInputDevice` polls `navigator.getGamepads()` before physics consumers. It selects one standard-mapped controller, applies radial deadzones to both sticks, maps the left stick to position velocity, maps the right stick to orientation velocity, maps L1 to held run state, and maps the rising edge of A/Cross to interaction. Its sampled velocities do not depend on render delta; `PlayerController` integrates them during fixed physics steps. Disconnect, focus loss, hidden visibility, and disposal remove persistent controller contributions, and newly selected or resumed controllers baseline the interaction button to avoid an accidental action from a held button.

## Platform API Summary

### Event Log And Session Lifecycle

`runtime/events/EventLog.ts` is a framework-independent append-only event store. It owns JSON payload capture, immutable events/snapshots, sequential numbering, and subscriptions. It knows no scene rules, SDKs, transport, or file format beyond its JSON-compatible data contract.

`EventLogSession` owns session identity, the scene identifier, schema version, readiness/completion, and clocks. `EventLogRuntime` exposes the session through `useEventLog()` and sits above Canvas so the scene, player, and optional runtime services share the same instance. The provider is keyed by scene identifier; the router also remounts the active application on scene changes.

```ts
record(type, data, { source }?);
subscribe(listener); // Live events only; returns an unsubscribe function.
getSnapshot();
startSession();
completeSession();
```

Each event contains `sequence`, an ISO UTC `timestamp`, monotonic `elapsedMs`, `type`, optional `source`, and captured `data`. A session ID plus sequence identifies an event. Event types and payloads are producer-owned; the recorder contains no domain-specific interpretation. Payloads must be JSON-compatible; invalid values/cycles are rejected before appending. Stored data, returned events, and snapshots are frozen, and input payloads are copied, so producers and subscribers cannot rewrite history.

An event is appended before notification. Listeners are captured at append time, notified in sequence order, and can unsubscribe. Nested recording queues further notifications until all eligible listeners have received the current event. New subscribers receive no historical replay; callers can read a snapshot separately. Synchronous listener errors and returned promise rejections are reported without interrupting other listeners; asynchronous work is never awaited and is owned by the subscriber. The logger provides no network delivery, retries, or connection management.

Sessions have `pending`, `active`, and `completed` statuses. `PlayerRuntime` starts the session on the first applied spawn, excluding asset-loading time. Start and completion are idempotent. The session emits generic `session.started` and `session.completed` events from `runtime.session`; scenes can subscribe to readiness and record their initial domain state once. Only active sessions accept producer records: `record` returns `null` before readiness and after completion. Subsequent player spawns do not reset elapsed time or history.

Scenes append all final action/state events before calling `completeSession`. Completion stores the end timestamp and monotonic duration, appends the terminal lifecycle event, and invokes the configured completion callback once with an immutable snapshot. It does not wait for cosmetic animations or asynchronous consumers. Callback failure leaves the completed log available through `getSnapshot` and does not automatically retry. Snapshot fields are `schemaVersion`, `sessionId`, `scene`, `status`, `startedAt`, `completedAt`, `durationMs`, and `events`.

The web `App` supplies `downloadSessionLog` as the completion callback. This browser-only helper creates a JSON Blob, requests an anchor download with scene/start-time/session-ID in the filename, removes the anchor, and releases the object URL after a delay. It works on localhost without a backend. The browser controls whether and where the download is saved; requesting a download does not confirm disk persistence. A completed file covers events through completion, not later asynchronous responses. Active logs are memory-only and are lost when the scene session is discarded or the page is refreshed.

Pressure Gauge is the first domain producer. Its event mapping lives beside the scene in `trainingEvents.ts`; other scenes currently use only the common readiness lifecycle. Subscribers should clean up using their unsubscribe functions. The event service does not use React state for each record and does not trigger scene rerenders on appends.

### `usePlayer`

`usePlayer` exposes player-owned services to scene specifications.

```ts
spawn(position, yaw?, pitch?)
setHeldItem(heldItem)
idleTime
getOrientation()
```

`idleTime` reports seconds since the last resolved user input after spawning and resets to zero while user input is active. Scenes own any duration threshold for idle behavior. Automatic input does not reset it. `getOrientation()` returns the current yaw and pitch without publishing per-frame React state.

### `useAutomaticInput`

`useAutomaticInput` registers an independent scene-owned input state in the automatic-input aggregate. It exposes the same delta, velocity, run, and interaction mutations used by device input. Multiple automatic sources combine, and unmounting a source removes its contribution.

The player runtime also exposes lower-level interaction target methods through context for platform components such as `GltfModel`. Scene specifications generally provide labeled interactions to `GltfModel` instead of calling those methods directly.

### `useUI`

`useUI` exposes UI-owned services to scene specifications and platform runtimes.

```ts
showScreenFeedback(tintColor, message, messageColor, duration);
setOverlayButton(id, button | null);
```

`setOverlayButton` is a generic UI service. Callers provide a stable ID, label, press callback, semantic placement, and optional priority. `UIRuntime` owns the DOM, stacking, placement, and visual styling; callers own the button meaning.

### `GltfModel`

`GltfModel` is the platform GLB boundary.

```ts
url;
position;
rotation;
scale;
opacity;
visible;
physicality;
colliders;
interaction;
interactionDistance;
blocksInteractions;
```

`interaction` is either `null` or a `PlayerInteraction` object:

```ts
{
  label: string;
  action: () => void;
}
```

The label is mandatory because it is shown by the player-owned overlay button. If a scene state changes the available label or behavior, select a different `PlayerInteraction` object for that state rather than branching inside one action.

An optional React ref exposes `GltfModelHandle` from `runtime/assets/GltfAnimationController.ts`:

```ts
setClipBehavior(clipName, {
  start, // Optional normalized progress; applied immediately when provided.
  end, // Default 1.
  speed, // Default 1 (authored speed); 0 holds the current pose.
  onComplete, // Optional, called once on an animation update at the endpoint.
});
```

Progress is between 0 and 1, mapped to the clip's first and last keyed times. Speed is a finite nonnegative multiplier; direction is determined by the endpoint relative to current progress. A first call without `start` begins at 0. Later calls without `start` preserve current progress. Every call replaces that clip's configuration and callback, including clearing an omitted callback. Calls for different clips operate independently using normal full-weight Three.js blending; completed clips remain active to hold their final poses. Clips are activated only when explicitly controlled.

`start` with `speed: 0` supplies direct pose sampling, allowing a scene to drive a needle from its own continuously changing visual pressure without another smoothing layer. Endpoint completion is reported on the next animation update, never synchronously inside the setter, including when the requested pose already equals the endpoint. A paused clip away from its endpoint does not complete. Missing clip names or invalid progress/speed values throw errors. Each mounted model owns its controller bound to its clone; unmounting stops and uncaches its actions without invoking completion callbacks.

Scenes acquire interaction locks synchronously when starting an operation and pass `interaction={null}` to affected models until completion. Logical state may change at animation start; completion governs interaction availability rather than simulation state. Cosmetic pose updates do not require a lock. Models intended to stay static receive no animation commands.

### `SplatModel`

`SplatModel` is the platform splat asset boundary.

```ts
url;
paged;
onInitialized;
children;
```

### `SplatEdit`

`SplatEdit` encapsulates Spark edit and SDF nodes.

```ts
type;
rgbaBlendMode;
sdfSmooth;
softEdge;
invert;
sdfInvert;
opacity;
color;
displace;
radius;
position;
rotation;
scale;
```

### `ParticleEmitter`

`ParticleEmitter` provides procedural Spark particles.

```ts
particleCount;
spawnRadius;
velocity;
velocityDrag;
turbulence;
lifetime;
baseScale;
scaleGrowth;
opacity;
colors;
emitting;
position;
rotation;
```

`ParticleEmitter` owns a fixed-size particle pool that starts empty. While emitting, it spawns at `particleCount / lifetime` particles per second, reuses expired slots, and samples each particle's initial position and velocity at birth. Stopping emission lets existing particles finish their lifetimes; restarting adds new particles without resetting survivors. Unmounting removes the effect immediately. Changing particle count or lifetime rebuilds the pool.

`velocity` accepts a constant tuple or a function returning a tuple, evaluated only for new particles. `emitting` accepts a boolean or a function sampled each update. Scenes can use these functions to read current refs without causing React rerenders or rebuilding the pool. Updating a velocity input does not alter existing particles' captured velocities.

`velocityDrag` is an optional nonnegative per-axis tuple, defaulting to `[0, 0, 0]`. Each velocity component decays exponentially with particle age; displacement is evaluated analytically, with ordinary linear movement for zero drag. For example, `Math.log(2) / 0.5` produces a half-second velocity half-life. Positions, velocities, drag axes, and particle sizes are emitter-local and inherit parent transforms. Scene code owns emission conditions and effect parameters; the runtime owns particle lifecycle, motion, and Spark updates. Existing constant-velocity smoke/flame effects use the same lifecycle and zero drag by default.

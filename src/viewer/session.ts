import type { ViewerSessionSnapshot } from './api';
import type { SessionSnapshot } from '../runtime/events/EventLogSession';

export const toViewerSessionSnapshot = (snapshot: SessionSnapshot): ViewerSessionSnapshot =>
  Object.freeze({
    schemaVersion: snapshot.schemaVersion,
    sessionId: snapshot.sessionId,
    scene: snapshot.scene,
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    durationMs: snapshot.durationMs,
    events: Object.freeze(
      snapshot.events.map((event) =>
        Object.freeze({
          sequence: event.sequence,
          timestamp: event.timestamp,
          elapsedMs: event.elapsedMs,
          type: event.type,
          ...(event.source === undefined ? {} : { source: event.source }),
          // Runtime event payloads are captured JSON and deeply frozen before publication.
          data: event.data,
        }),
      ),
    ),
  });

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toViewerSessionSnapshot } from '../../src/viewer/session.ts';

test('completion DTO preserves log data while excluding runtime implementation fields', () => {
  const data = Object.freeze({ action: 'complete', values: Object.freeze([true, null, 2]) });
  const event = Object.freeze({
    sequence: 1,
    timestamp: '2026-10-16T00:00:00.000Z',
    elapsedMs: 10,
    type: 'session.completed',
    source: 'runtime.session',
    data,
    internalEventField: 'not public',
  });
  const runtime = {
    schemaVersion: 1 as const,
    sessionId: 'session-1',
    scene: 'local session',
    status: 'completed' as const,
    startedAt: '2026-10-15T23:59:59.990Z',
    completedAt: event.timestamp,
    durationMs: 10,
    events: [event],
    internalSessionField: 'not public',
  };
  const dto = toViewerSessionSnapshot(runtime);
  assert.deepEqual(JSON.parse(JSON.stringify(dto)), {
    schemaVersion: 1,
    sessionId: 'session-1',
    scene: 'local session',
    status: 'completed',
    startedAt: runtime.startedAt,
    completedAt: runtime.completedAt,
    durationMs: 10,
    events: [
      {
        sequence: 1,
        timestamp: event.timestamp,
        elapsedMs: 10,
        type: 'session.completed',
        source: 'runtime.session',
        data,
      },
    ],
  });
  assert.equal(Object.isFrozen(dto), true);
  assert.equal(Object.isFrozen(dto.events), true);
  assert.equal(Object.isFrozen(dto.events[0]), true);
  assert.equal(Object.isFrozen(dto.events[0].data), true);
  runtime.events.length = 0;
  assert.equal(dto.events.length, 1);
});

test('completion DTO preserves an event without an optional source', () => {
  const dto = toViewerSessionSnapshot({
    schemaVersion: 1,
    sessionId: 'session-2',
    scene: 'local session',
    status: 'completed',
    startedAt: '2026-10-16T00:00:00.000Z',
    completedAt: '2026-10-16T00:00:00.010Z',
    durationMs: 10,
    events: [
      {
        sequence: 1,
        timestamp: '2026-10-16T00:00:00.005Z',
        elapsedMs: 5,
        type: 'domain.action',
        data: null,
      },
    ],
  });
  assert.equal('source' in dto.events[0], false);
});

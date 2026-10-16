import assert from 'node:assert/strict';

import { test } from '@playwright/test';

import { EventLogSession } from '../../src/runtime/events/EventLogSession';
import {
  INITIAL_SIMULATION_STATE,
  transitionSimulation,
} from '../../src/scenes/pressure-gauge/simulation';
import {
  recordTrainingStart,
  recordTrainingTransition,
} from '../../src/scenes/pressure-gauge/trainingEvents';
import { toViewerSessionSnapshot } from '../../src/viewer/session';

import type { SimulationAction } from '../../src/scenes/pressure-gauge/simulation';

test('the preserved Pressure Gauge sequence completes once and exports its ordered event DTO', () => {
  const exported: unknown[] = [];
  const session = new EventLogSession({
    scene: 'pressure-gauge',
    onComplete: (snapshot) => exported.push(toViewerSessionSnapshot(snapshot)),
  });
  session.startSession();
  let state = INITIAL_SIMULATION_STATE;
  recordTrainingStart(session, state);
  const actions: SimulationAction[] = [
    { type: 'set-valve', valve: 'montante', open: false },
    { type: 'finish-valve', valve: 'montante' },
    { type: 'set-valve', valve: 'jusante', open: false },
    { type: 'finish-valve', valve: 'jusante' },
    { type: 'set-valve', valve: 'venteio', open: true },
    { type: 'finish-valve', valve: 'venteio' },
    { type: 'set-valve', valve: 'venteio', open: false },
    { type: 'finish-valve', valve: 'venteio' },
    { type: 'remove-gauge' },
    { type: 'collect-gauge' },
    { type: 'install-gauge' },
    { type: 'set-valve', valve: 'montante', open: true },
    { type: 'finish-valve', valve: 'montante' },
    { type: 'set-valve', valve: 'jusante', open: true },
    { type: 'finish-valve', valve: 'jusante' },
  ];
  for (const action of actions) {
    const next = transitionSimulation(state, action);
    recordTrainingTransition(session, state, next, action);
    state = next;
  }
  assert.equal(state.stage, 'complete');
  assert.equal(exported.length, 1);
  const snapshot = session.getSnapshot();
  assert.equal(snapshot.status, 'completed');
  for (const type of ['gauge.removed', 'gauge.collected', 'gauge.installed', 'training.completed'])
    assert.equal(snapshot.events.filter((event) => event.type === type).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(exported[0])), snapshot);
});

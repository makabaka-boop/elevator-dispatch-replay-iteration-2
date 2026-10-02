import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { simulate } from '../simulation';
import type { Scenario } from '../types';
import { TimelinePlayer } from '../../player/TimelinePlayer';

const scenario: Scenario = {
  floors: 8,
  elevators: 3,
  travelTicks: 2,
  doorOpenTicks: 1,
  doorCloseTicks: 1,
  requests: [
    { id: 'A', arrivalTick: 0, origin: 2, destination: 7, people: 6 },
    { id: 'B', arrivalTick: 3, origin: 1, destination: 8, people: 7, cancelTick: 20 },
    { id: 'C', arrivalTick: 8, origin: 6, destination: 1, people: 2 }
  ]
};

function playThrough(speed: number, steps: number) {
  const result = simulate(scenario);
  const player = new TimelinePlayer(result.ticks);
  player.setSpeed(speed);
  player.play();
  vi.advanceTimersByTime((1000 / speed) * steps);
  const tick = get(player.currentTick);
  const snapshot = get(player.current);
  player.destroy();
  return { tick, snapshot, result };
}

describe('TimelinePlayer speed and jumping consistency', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lands on the same immutable snapshot regardless of playback speed', () => {
    const slow = playThrough(1, 10);
    const fast = playThrough(8, 10);
    expect(slow.tick).toBe(10);
    expect(fast.tick).toBe(10);
    expect(fast.snapshot).toEqual(slow.snapshot);
    expect(fast.snapshot).toBe(fast.result.ticks[10]);
  });

  it('jumping forwards and backwards reads stored snapshots without recomputing', () => {
    const result = simulate(scenario);
    const player = new TimelinePlayer(result.ticks);
    player.jumpTo(17);
    const at17 = get(player.current);
    expect(at17).toBe(result.ticks[17]);
    player.jumpTo(4);
    expect(get(player.current)).toBe(result.ticks[4]);
    player.jumpTo(99999);
    expect(get(player.currentTick)).toBe(result.finalTick);
    player.destroy();
  });

  it('speed changes during playback only alter interval timing, not referenced states', () => {
    const result = simulate(scenario);
    const player = new TimelinePlayer(result.ticks);
    player.play();
    vi.advanceTimersByTime(2000);
    expect(get(player.currentTick)).toBe(2);
    player.setSpeed(4);
    vi.advanceTimersByTime(1000);
    expect(get(player.currentTick)).toBe(6);
    expect(get(player.current)).toBe(result.ticks[6]);
    player.destroy();
  });

  it('jumps across outage and recovery frames and always reads the same frozen snapshot', () => {
    const outageScenario: Scenario = {
      floors: 8,
      elevators: 3,
      travelTicks: 3,
      doorOpenTicks: 2,
      doorCloseTicks: 2,
      requests: [
        { id: 'A', arrivalTick: 0, origin: 1, destination: 7, people: 5 },
        { id: 'B', arrivalTick: 1, origin: 3, destination: 1, people: 3 }
      ],
      carEvents: [
        { carId: 0, tick: 4, type: 'outage' },
        { carId: 0, tick: 9, type: 'recover' },
        { carId: 1, tick: 6, type: 'outage' },
        { carId: 1, tick: 10, type: 'recover' }
      ]
    };

    const result = simulate(outageScenario);
    const player = new TimelinePlayer(result.ticks);

    // Jump forward into the frozen window: the snapshot is the exact precomputed frame.
    player.jumpTo(6);
    expect(get(player.current)).toBe(result.ticks[6]);
    const frozen0 = result.ticks[6].cars[0];
    expect(frozen0.outOfService).toBe(true);
    const frozen1 = result.ticks[6].cars[1];
    expect(frozen1.outOfService).toBe(true);

    // Every frozen tick for car 0 (outage tick through the tick before recovery) holds the
    // identical floor/phase/elapsed/onboard values.
    for (let tick = 4; tick <= 8; tick++) {
      const car = result.ticks[tick].cars[0];
      expect(car.floor).toBe(frozen0.floor);
      expect(car.phase).toBe(frozen0.phase);
      expect(car.phaseElapsed).toBe(frozen0.phaseElapsed);
      expect(car.peopleOnboard).toBe(frozen0.peopleOnboard);
    }

    // Jump backward before the outage, forward past recovery, and back to the frozen frame:
    // references remain identical, playback never recomputes state.
    player.jumpTo(2);
    expect(get(player.current)).toBe(result.ticks[2]);
    expect(result.ticks[2].cars[0].outOfService).toBe(false);
    player.jumpTo(11);
    expect(get(player.current)).toBe(result.ticks[11]);
    expect(result.ticks[11].cars[0].outOfService).toBe(false);
    player.jumpTo(6);
    expect(get(player.current)).toBe(result.ticks[6]);
    expect(get(player.events)).toBe(result.ticks[6].events);
    expect(result.ticks[6].events.some((event) => event.type === 'car_outage' && event.carId === 1)).toBe(true);

    // Frame-by-frame stepping forward from the frozen window visits stored snapshots in order.
    player.jumpTo(8);
    player.stepForward();
    expect(get(player.currentTick)).toBe(9);
    expect(get(player.current)).toBe(result.ticks[9]);
    expect(result.ticks[9].events.some((event) => event.type === 'car_recover' && event.carId === 0)).toBe(true);
    player.destroy();
  });
});

import { describe, expect, it } from 'vitest';
import { simulate } from '../simulation';
import { CAR_CAPACITY, type Scenario, type TickSnapshot } from '../types';

function eventTexts(result: ReturnType<typeof simulate>, tick: number): string[] {
  return result.ticks[tick].events.map((event) => event.message);
}

function findEvent(result: ReturnType<typeof simulate>, tick: number, requestId: string, type: string) {
  return result.ticks[tick].events.find(
    (event) => event.requestId === requestId && event.type === type
  );
}

function conservationChecks(ticks: TickSnapshot[]): void {
  const final = ticks[ticks.length - 1];
  for (const request of final.requests) {
    expect(request.people).toBe(request.completed + request.cancelled);
    expect(request.remaining).toBe(0);
    expect(request.boarded).toBe(request.completed);
  }
  for (const snapshot of ticks) {
    const requestWaiting = snapshot.requests
      .filter((request) => request.status === 'waiting' || request.status === 'riding')
      .reduce((sum, request) => sum + request.remaining, 0);
    const requestRiding = snapshot.requests
      .filter((request) => request.status === 'riding')
      .reduce((sum, request) => sum + Math.max(0, request.boarded - request.completed), 0);
    const carWaiting = snapshot.cars.reduce(
      (sum, car) => sum + car.waiting.reduce((inner, entry) => inner + entry.remaining, 0),
      0
    );
    const carRiding = snapshot.cars.reduce((sum, car) => sum + car.peopleOnboard, 0);
    expect(carWaiting).toBe(requestWaiting);
    expect(carRiding).toBe(requestRiding);
    for (const car of snapshot.cars) {
      expect(car.peopleOnboard).toBeLessThanOrEqual(CAR_CAPACITY);
    }
  }
}

describe('discrete elevator reference replay', () => {
  it('breaks parallel dispatch ties by earliest ETA and then smallest car ID', () => {
    const scenario: Scenario = {
      floors: 6,
      elevators: 2,
      travelTicks: 2,
      doorOpenTicks: 1,
      doorCloseTicks: 1,
      requests: [
        { id: 'same', arrivalTick: 4, origin: 1, destination: 6, people: 1 }
      ]
    };

    const result = simulate(scenario);
    const event = findEvent(result, 4, 'same', 'dispatch');
    expect(event).toBeDefined();
    expect(event?.carId).toBe(0);
    expect(event?.eta).toBe(5);
    const candidateSummary = event?.candidates?.map((candidate) => [candidate.carId, candidate.eta]);
    expect(candidateSummary).toEqual([[0, 5], [1, 5]]);
  });

  it('assigns two equal ETA requests on the same tick to cars in deterministic ID order', () => {
    const scenario: Scenario = {
      floors: 8,
      elevators: 2,
      travelTicks: 1,
      doorOpenTicks: 1,
      doorCloseTicks: 1,
      requests: [
        { id: 'B', arrivalTick: 0, origin: 3, destination: 8, people: 1 },
        { id: 'A', arrivalTick: 0, origin: 2, destination: 8, people: 1 }
      ]
    };

    const result = simulate(scenario);
    const tick = result.ticks[0];
    const dispatchA = tick.events.find((event) => event.requestId === 'A' && event.type === 'dispatch');
    const dispatchB = tick.events.find((event) => event.requestId === 'B' && event.type === 'dispatch');
    expect(dispatchA?.carId).toBe(0);
    expect(dispatchB?.carId).toBe(1);
    expect(dispatchA?.eta).toBeLessThanOrEqual(dispatchB!.eta!);
  });

  it('boards only the available capacity and keeps the surplus assigned until it is served', () => {
    const scenario: Scenario = {
      floors: 10,
      elevators: 2,
      travelTicks: 3,
      doorOpenTicks: 1,
      doorCloseTicks: 1,
      requests: [
        { id: 'BIG', arrivalTick: 1, origin: 1, destination: 3, people: 10 }
      ]
    };

    const result = simulate(scenario);
    const firstBoard = findEvent(result, 2, 'BIG', 'board');
    expect(firstBoard?.people).toBe(6);
    expect(firstBoard?.remaining).toBe(4);
    expect(firstBoard?.reason).toContain('容量不足');

    const requestAtFirst = result.ticks[2].requests.find((request) => request.id === 'BIG')!;
    expect(requestAtFirst.status).toBe('riding');
    expect(requestAtFirst.remaining).toBe(4);
    expect(requestAtFirst.boarded).toBe(6);
    expect(requestAtFirst.carId).toBe(0);

    const alight = result.ticks.find((snapshot) =>
      snapshot.events.some((event) => event.requestId === 'BIG' && event.type === 'alight')
    );
    expect(alight).toBeDefined();
    const alightEvent = alight!.events.find(
      (event) => event.requestId === 'BIG' && event.type === 'alight'
    )!;
    expect(alightEvent.people).toBe(6);

    const secondBoard = result.ticks.find((snapshot) =>
      snapshot.events.some(
        (event) => event.requestId === 'BIG' && event.type === 'board' && event.people === 4
      )
    );
    expect(secondBoard).toBeDefined();

    const requestAfterSecond = secondBoard!.requests.find((request) => request.id === 'BIG')!;
    expect(requestAfterSecond.remaining).toBe(0);
    expect(requestAfterSecond.boarded).toBe(10);
    conservationChecks(result.ticks);
  });

  it('cancels only unboarded people and refuses cancellation after boarding', () => {
    const scenario: Scenario = {
      floors: 6,
      elevators: 2,
      travelTicks: 5,
      doorOpenTicks: 1,
      doorCloseTicks: 1,
      requests: [
        { id: 'WAIT', arrivalTick: 1, origin: 1, destination: 6, people: 3, cancelTick: 2 },
        { id: 'RIDE', arrivalTick: 1, origin: 1, destination: 6, people: 2, cancelTick: 4 }
      ]
    };

    const result = simulate(scenario);
    const waitCancel = findEvent(result, 2, 'WAIT', 'cancel');
    expect(waitCancel?.people).toBe(3);
    const waitRequest = result.ticks[2].requests.find((request) => request.id === 'WAIT')!;
    expect(waitRequest.status).toBe('cancelled');
    expect(waitRequest.cancelled).toBe(3);

    const rideReject = findEvent(result, 4, 'RIDE', 'cancel_rejected');
    expect(rideReject).toBeDefined();
    expect(rideReject?.reason).toContain('已经上车');
    const finalRide = result.ticks[result.finalTick].requests.find(
      (request) => request.id === 'RIDE'
    )!;
    expect(finalRide.completed).toBe(2);
    expect(finalRide.cancelled).toBe(0);
    conservationChecks(result.ticks);
  });

  it('never moves during opening/open/closing and emits the full deterministic basis', () => {
    const scenario: Scenario = {
      floors: 5,
      elevators: 2,
      travelTicks: 2,
      doorOpenTicks: 2,
      doorCloseTicks: 3,
      requests: [{ id: 'X', arrivalTick: 1, origin: 1, destination: 5, people: 1 }]
    };

    const result = simulate(scenario);
    const dispatchTick = result.ticks[1];
    const dispatch = dispatchTick.events.find((event) => event.type === 'dispatch')!;
    expect(dispatch.carId).toBe(0);
    expect(eventTexts(result, 1).join('\n')).toContain('派给 #0');
    expect(result.ticks[1].cars[0].phase).toBe('opening');
    expect(result.ticks[1].cars[0].floor).toBe(1);

    expect(result.ticks[2].cars[0].phase).toBe('opening');
    expect(result.ticks[2].cars[0].floor).toBe(1);

    expect(result.ticks[3].cars[0].phase).toBe('closing');
    expect(result.ticks[3].cars[0].floor).toBe(1);
    expect(result.ticks[4].cars[0].phase).toBe('closing');
    expect(result.ticks[4].cars[0].floor).toBe(1);
    expect(result.ticks[5].cars[0].phase).toBe('closing');
    expect(result.ticks[5].cars[0].floor).toBe(1);
    expect(result.ticks[6].cars[0].phase).toBe('moving');
    expect(result.ticks[6].cars[0].floor).toBe(1);
    expect(result.ticks[7].cars[0].phase).toBe('moving');
    expect(result.ticks[7].cars[0].floor).toBe(1);
    expect(result.ticks[8].cars[0].floor).toBe(2);

    const moveEvent = result.ticks[6].events.find((event) => event.type === 'move_start')!;
    expect(moveEvent.reason).toContain('SCAN');
    expect(moveEvent.message).toContain('载客 1 人');
  });

  it('logs an empty run with committed pickup rationale', () => {
    const scenario: Scenario = {
      floors: 6,
      elevators: 2,
      travelTicks: 1,
      doorOpenTicks: 1,
      doorCloseTicks: 1,
      requests: [{ id: 'FAR', arrivalTick: 0, origin: 4, destination: 6, people: 2 }]
    };

    const result = simulate(scenario);
    const move = result.ticks[0].events.find((event) => event.type === 'move_start');
    expect(move).toBeDefined();
    expect(move?.message).toContain('空驶');
    expect(move?.committedPickups).toEqual([4]);
    expect(move?.reason).toContain('已承诺接客楼层 [4]');
  });

  it('produces identical tick snapshots when re-run from the same scenario', () => {
    const scenario: Scenario = {
      floors: 12,
      elevators: 4,
      travelTicks: 2,
      doorOpenTicks: 1,
      doorCloseTicks: 2,
      requests: Array.from({ length: 30 }, (_, index) => {
        const origin = (index * 5) % 12 + 1;
        const destination = ((index * 7) % 12) + 1;
        return {
          id: `R${index}`,
          arrivalTick: index,
          origin,
          destination: destination === origin ? (destination % 12) + 1 : destination,
          people: ((index * 3) % 7) + 1,
          ...(index % 4 === 2 ? { cancelTick: index + 2 } : {})
        };
      })
    };

    const first = simulate(scenario);
    const second = simulate(scenario);
    expect(first.finalTick).toBe(second.finalTick);
    expect(second.ticks).toEqual(first.ticks);
    conservationChecks(first.ticks);
  });
});

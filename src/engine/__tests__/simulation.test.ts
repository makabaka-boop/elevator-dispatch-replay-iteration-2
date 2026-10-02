import { describe, expect, it } from 'vitest';
import { simulate } from '../simulation';
import { validateScenario } from '../validation';
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
    const unassigned = snapshot.requests
      .filter(
        (request) =>
          (request.status === 'waiting' || request.status === 'riding') &&
          request.remaining > 0 &&
          !snapshot.cars.some((car) =>
            car.waiting.some((entry) => entry.requestId === request.id)
          )
      )
      .reduce((sum, request) => sum + request.remaining, 0);
    expect(carWaiting + unassigned).toBe(requestWaiting);
    expect(snapshot.totalUnassigned).toBe(unassigned);
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

describe('per-tick car outage and recovery', () => {
  function carView(result: ReturnType<typeof simulate>, tick: number, carId: number) {
    return result.ticks[tick].cars.find((car) => car.id === carId)!;
  }

  function requestView(result: ReturnType<typeof simulate>, tick: number, requestId: string) {
    return result.ticks[tick].requests.find((request) => request.id === requestId)!;
  }

  it('freezes a moving car, keeps boarded passengers, and withdraws unboarded commitments', () => {
    const scenario: Scenario = {
      floors: 8,
      elevators: 2,
      travelTicks: 4,
      doorOpenTicks: 1,
      doorCloseTicks: 1,
      requests: [
        { id: 'A', arrivalTick: 0, origin: 1, destination: 5, people: 1 },
        { id: 'B', arrivalTick: 0, origin: 1, destination: 3, people: 10 }
      ],
      carEvents: [
        { carId: 0, tick: 4, type: 'outage' },
        { carId: 0, tick: 7, type: 'recover' }
      ]
    };

    const result = simulate(scenario);

    // Reference state immediately before the outage.
    expect(carView(result, 2, 0)).toMatchObject({
      floor: 1,
      phase: 'moving',
      phaseElapsed: 0,
      peopleOnboard: 6,
      outOfService: false
    });
    expect(requestView(result, 2, 'B')).toMatchObject({
      status: 'riding',
      remaining: 5,
      boarded: 5,
      carId: 0
    });
    // One advancing tick was consumed before the outage.
    expect(carView(result, 3, 0)).toMatchObject({ phase: 'moving', phaseElapsed: 1, floor: 1 });

    // The outage takes effect before this tick's dispatch and car advances: the state freezes
    // at the end-of-t3 values and never advances on tick 4.
    const t4 = result.ticks[4];
    expect(carView(result, 4, 0)).toMatchObject({
      floor: 1,
      phase: 'moving',
      phaseElapsed: 1,
      peopleOnboard: 6,
      outOfService: true,
      outageTick: 4,
      waiting: [],
      committedDropFloors: [3, 5]
    });
    const outageEvent = t4.events.find((event) => event.type === 'car_outage')!;
    expect(outageEvent.carId).toBe(0);
    expect(outageEvent.withdrawn).toEqual([{ requestId: 'B', people: 5 }]);

    // Boarded passenger A is still inside the frozen car; its destination commitment survives.
    const aAt4 = requestView(result, 4, 'A');
    expect(aAt4.status).toBe('riding');
    expect(aAt4.carId).toBe(0);
    expect(aAt4.boarded - aAt4.completed).toBe(1);

    // Frozen ticks: floor, phase, elapsed time and onboard count never change.
    for (const tick of [4, 5, 6]) {
      expect(carView(result, tick, 0)).toMatchObject({
        floor: 1,
        phase: 'moving',
        phaseElapsed: 1,
        peopleOnboard: 6,
        outOfService: true
      });
      expect(result.ticks[tick].events.some((e) => e.type === 'move_arrive' && e.carId === 0)).toBe(false);
    }

    // Withdrawn residual people are re-dispatched to another available car with a fresh ETA.
    const reDispatch = t4.events.find((event) => event.type === 'dispatch' && event.requestId === 'B')!;
    expect(reDispatch.carId).toBe(1);
    expect(reDispatch.message).toContain('停运');
    expect(reDispatch.candidates?.find((candidate) => candidate.carId === 0)?.eta).toBeNull();
    const bAt4 = requestView(result, 4, 'B');
    expect(bAt4.carId).toBe(1);
    expect(bAt4.remaining).toBe(5);

    // Recovery resumes from the frozen phase using only the remaining travel time: car 0
    // consumed 1 of 4 travel ticks before the freeze, so the three remaining advancing ticks
    // (t7, t8, arrival on t9) finish the hop — never the full four ticks again.
    expect(carView(result, 7, 0)).toMatchObject({
      floor: 1,
      phase: 'moving',
      phaseElapsed: 2,
      outOfService: false,
      outageTick: null,
      peopleOnboard: 6
    });
    expect(result.ticks[7].events.some((event) => event.type === 'car_recover' && event.carId === 0)).toBe(true);
    expect(carView(result, 8, 0).floor).toBe(1);
    const arrive = result.ticks[9];
    expect(carView(result, 9, 0).floor).toBe(2);
    expect(arrive.events.some((event) => event.type === 'move_arrive' && event.carId === 0)).toBe(true);

    // The car keeps its onboard passengers and continues serving them after recovery.
    const alightA = result.ticks.find((snapshot) =>
      snapshot.events.some((event) => event.type === 'alight' && event.requestId === 'A')
    );
    expect(alightA).toBeDefined();
    conservationChecks(result.ticks);
  });

  it('freezes mid door phase and resumes with only the remaining door time', () => {
    const scenario: Scenario = {
      floors: 6,
      elevators: 2,
      travelTicks: 2,
      doorOpenTicks: 2,
      doorCloseTicks: 1,
      requests: [{ id: 'X', arrivalTick: 2, origin: 1, destination: 4, people: 1 }],
      carEvents: [
        // Keep car 1 out of service the whole time so X stays committed to frozen car 0.
        { carId: 1, tick: 0, type: 'outage' },
        { carId: 0, tick: 3, type: 'outage' },
        { carId: 0, tick: 6, type: 'recover' },
        { carId: 1, tick: 12, type: 'recover' }
      ]
    };

    const result = simulate(scenario);
    // t2: door starts opening; t3: outage before the advance, elapsed stays at 0.
    expect(carView(result, 3, 0)).toMatchObject({
      floor: 1,
      phase: 'opening',
      phaseElapsed: 0,
      outOfService: true
    });
    // During the freeze no door completion and no transfer happen at all.
    for (const tick of [3, 4, 5, 6]) {
      expect(result.ticks[tick].events.some((e) => e.type === 'door_open' && e.carId === 0)).toBe(false);
      expect(requestView(result, tick, 'X').status).toBe('waiting');
      expect(requestView(result, tick, 'X').remaining).toBe(1);
    }

    // t6 recovery: dispatch keeps the car committed to X; one advancing tick completes the
    // remaining (1 of 2) opening duration on t7, then boarding happens exactly once.
    expect(result.ticks[6].events.some((e) => e.type === 'car_recover' && e.carId === 0)).toBe(true);
    expect(result.ticks[6].events.some((e) => e.type === 'door_open' && e.carId === 0)).toBe(false);
    const t7 = result.ticks[7];
    expect(carView(result, 7, 0).phase).toBe('closing');
    const board = t7.events.find((event) => event.type === 'board' && event.requestId === 'X')!;
    expect(board.people).toBe(1);
    expect(t7.events.filter((event) => event.type === 'board' && event.requestId === 'X')).toHaveLength(1);
    conservationChecks(result.ticks);
  });

  it('keeps passengers waiting without cancelling when every car is frozen, then serves on recovery', () => {
    const scenario: Scenario = {
      floors: 8,
      elevators: 2,
      travelTicks: 2,
      doorOpenTicks: 1,
      doorCloseTicks: 1,
      requests: [{ id: 'P', arrivalTick: 2, origin: 4, destination: 7, people: 3 }],
      carEvents: [
        { carId: 0, tick: 0, type: 'outage' },
        { carId: 1, tick: 1, type: 'outage' },
        { carId: 0, tick: 4, type: 'recover' }
      ]
    };

    const result = simulate(scenario);
    for (const tick of [2, 3]) {
      const snapshot = result.ticks[tick];
      const request = snapshot.requests[0];
      expect(request.status).toBe('waiting');
      expect(request.carId).toBeNull();
      expect(request.remaining).toBe(3);
      expect(request.cancelled).toBe(0);
      expect(snapshot.totalUnassigned).toBe(3);
      const deferred = snapshot.events.find((event) => event.type === 'dispatch_deferred')!;
      expect(deferred.requestId).toBe('P');
      expect(deferred.candidates?.every((candidate) => candidate.eta === null)).toBe(true);
    }

    // On recovery the request is dispatched in the same tick before the car advances.
    const t4 = result.ticks[4];
    expect(t4.events.some((event) => event.type === 'car_recover' && event.carId === 0)).toBe(true);
    const dispatch = t4.events.find((event) => event.type === 'dispatch' && event.requestId === 'P')!;
    expect(dispatch.carId).toBe(0);
    expect(t4.events.some((event) => event.type === 'move_start' && event.carId === 0)).toBe(true);

    const request = result.ticks[result.finalTick].requests[0];
    expect(request.completed).toBe(3);
    expect(request.cancelled).toBe(0);
    conservationChecks(result.ticks);
  });

  it('applies arrivals, cancels, outages, recoveries and dispatch in one deterministic order', () => {
    const scenario: Scenario = {
      floors: 8,
      elevators: 2,
      travelTicks: 2,
      doorOpenTicks: 1,
      doorCloseTicks: 1,
      requests: [
        { id: 'W', arrivalTick: 3, origin: 1, destination: 5, people: 2, cancelTick: 4 },
        { id: 'N', arrivalTick: 4, origin: 2, destination: 6, people: 1 }
      ],
      carEvents: [
        { carId: 1, tick: 2, type: 'outage' },
        { carId: 0, tick: 4, type: 'outage' },
        { carId: 1, tick: 4, type: 'recover' }
      ]
    };

    const result = simulate(scenario);
    const types = result.ticks[4].events.map((event) => event.type);
    expect(types).toEqual([
      'arrival',
      'cancel',
      'car_outage',
      'car_recover',
      'dispatch',
      'move_start'
    ]);
    // New request N can only go to the car recovered earlier within the same ordered tick.
    const dispatch = result.ticks[4].events.find((event) => event.type === 'dispatch' && event.requestId === 'N')!;
    expect(dispatch.carId).toBe(1);
    conservationChecks(result.ticks);
  });

  it('supports outage during partial boarding and preserves capacity constraints', () => {
    const scenario: Scenario = {
      floors: 10,
      elevators: 2,
      travelTicks: 1,
      doorOpenTicks: 1,
      doorCloseTicks: 1,
      requests: [{ id: 'BIG', arrivalTick: 1, origin: 1, destination: 2, people: 10 }],
      carEvents: [
        // t6: the six boarded people have already alighted at floor 2; car 0 is closing.
        { carId: 0, tick: 6, type: 'outage' },
        { carId: 0, tick: 9, type: 'recover' }
      ]
    };

    const result = simulate(scenario);

    // First boarding: 6 onboard, 4 residual committed to car 0.
    const firstBoard = result.ticks[2].events.find(
      (event) => event.type === 'board' && event.requestId === 'BIG'
    )!;
    expect(firstBoard.people).toBe(6);
    const bigAt3 = requestView(result, 3, 'BIG');
    expect(bigAt3.boarded - bigAt3.completed).toBe(6);
    expect(bigAt3.remaining).toBe(4);

    // The six are delivered at floor 2 on t5; the outage on t6 therefore freezes an empty car,
    // and the four unboarded people are withdrawn and reassigned to the other car.
    const alight = result.ticks[5].events.find(
      (event) => event.type === 'alight' && event.requestId === 'BIG'
    )!;
    expect(alight.people).toBe(6);
    const outageTick = result.ticks[6];
    expect(carView(result, 6, 0).peopleOnboard).toBe(0);
    expect(outageTick.events.find((event) => event.type === 'car_outage')?.withdrawn).toEqual([
      { requestId: 'BIG', people: 4 }
    ]);
    const reDispatch = outageTick.events.find(
      (event) => event.type === 'dispatch' && event.requestId === 'BIG'
    )!;
    expect(reDispatch.carId).toBe(1);

    for (const snapshot of result.ticks) {
      for (const car of snapshot.cars) {
        expect(car.peopleOnboard).toBeLessThanOrEqual(CAR_CAPACITY);
      }
    }
    const final = result.ticks[result.finalTick].requests.find((r) => r.id === 'BIG')!;
    expect(final.completed).toBe(10);
    conservationChecks(result.ticks);
  });

  it('validates car events and rejects inconsistent outage/recover sequences', () => {
    const base = {
      floors: 6,
      elevators: 2,
      travelTicks: 1,
      doorOpenTicks: 1,
      doorCloseTicks: 1,
      requests: []
    };
    const expectReject = (carEvents: unknown, fragment: string) => {
      expect(() => validateScenario({ ...base, carEvents } as Partial<Scenario>)).toThrow(fragment);
    };
    expectReject([{ carId: 0, tick: 0, type: 'recover' }], '未停运');
    expectReject(
      [
        { carId: 0, tick: 0, type: 'outage' },
        { carId: 0, tick: 2, type: 'outage' }
      ],
      '已处于停运'
    );
    expectReject([{ carId: 2, tick: 0, type: 'outage' }], 'carId');
    expectReject(
      [
        { carId: 0, tick: 0, type: 'outage' },
        { carId: 0, tick: 0, type: 'recover' }
      ],
      '重复事件'
    );
    expectReject([{ carId: 0, tick: 0, type: 'halt' }], 'outage');

    const validated = validateScenario({
      ...base,
      carEvents: [
        { carId: 1, tick: 5, type: 'recover' },
        { carId: 0, tick: 5, type: 'recover' },
        { carId: 1, tick: 1, type: 'outage' },
        { carId: 0, tick: 1, type: 'outage' }
      ]
    } as Partial<Scenario>);
    // Deterministic ordering: tick, then carId, then type; independent of input order.
    expect(validated.value.carEvents).toEqual([
      { carId: 0, tick: 1, type: 'outage' },
      { carId: 1, tick: 1, type: 'outage' },
      { carId: 0, tick: 5, type: 'recover' },
      { carId: 1, tick: 5, type: 'recover' }
    ]);
  });

  it('keeps frame-by-frame behaviour identical for scenarios without car events', () => {
    const legacyScenario: Scenario = {
      floors: 10,
      elevators: 3,
      travelTicks: 2,
      doorOpenTicks: 1,
      doorCloseTicks: 1,
      requests: [
        { id: 'R001', arrivalTick: 1, origin: 1, destination: 8, people: 6 },
        { id: 'R002', arrivalTick: 1, origin: 1, destination: 5, people: 4 },
        { id: 'R003', arrivalTick: 2, origin: 3, destination: 1, people: 2 },
        { id: 'R004', arrivalTick: 3, origin: 6, destination: 2, people: 8, cancelTick: 30 },
        { id: 'R005', arrivalTick: 4, origin: 1, destination: 10, people: 1 },
        { id: 'R006', arrivalTick: 12, origin: 9, destination: 1, people: 3 }
      ]
    };
    const explicitEmpty: Scenario = { ...legacyScenario, carEvents: [] };

    const withoutField = simulate(legacyScenario);
    const withEmpty = simulate(explicitEmpty);
    expect(withEmpty.ticks).toEqual(withoutField.ticks);
    expect(withEmpty.finalTick).toBe(withoutField.finalTick);
    // No outage-specific event or state is ever produced.
    for (const snapshot of withoutField.ticks) {
      expect(snapshot.cars.every((car) => !car.outOfService && car.outageTick === null)).toBe(true);
      expect(snapshot.totalUnassigned).toBe(0);
      expect(
        snapshot.events.every(
          (event) => event.type !== 'car_outage' && event.type !== 'dispatch_deferred'
        )
      ).toBe(true);
    }
  });
});

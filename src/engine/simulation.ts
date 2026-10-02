import { validateScenario } from './validation';
import {
  CAR_CAPACITY,
  type Direction,
  type DoorPhase,
  type ElevatorRuntime,
  type RequestRuntime,
  type Scenario,
  type SimEvent,
  type SimulationResult,
  type TickSnapshot,
  type ValidatedScenario
} from './types';

interface RuntimeState {
  cars: ElevatorRuntime[];
  requests: RequestRuntime[];
  events: SimEvent[];
}

interface StepContext {
  events: SimEvent[];
  requestMap: Map<string, RequestRuntime>;
  tick: number;
  dryCandidateId?: string;
}

const MAX_SIMULATION_TICKS = 200_000;

function directionText(direction: Direction): string {
  if (direction > 0) return '上行至';
  if (direction < 0) return '下行至';
  return '停在';
}

function initialCar(id: number): ElevatorRuntime {
  return {
    id,
    floor: 1,
    targetFloor: null,
    direction: 0,
    phase: 'closed',
    phaseElapsed: 0,
    onboard: [],
    waiting: [],
    attempted: [],
    committedPickups: [],
    movementTickStarted: null,
    idleLogged: false,
    outOfService: false,
    outageTick: null
  };
}

function initialRequest(scenario: ValidatedScenario): RequestRuntime[] {
  return scenario.requests.map((request) => ({
    id: request.id,
    arrivalTick: request.arrivalTick,
    origin: request.origin,
    destination: request.destination,
    people: request.people,
    remaining: request.people,
    boarded: 0,
    completed: 0,
    cancelled: 0,
    cancelTick: request.cancelTick,
    status: 'pending',
    carId: null,
    assignedTick: null
  }));
}

function carLoad(car: ElevatorRuntime): number {
  return car.onboard.reduce((sum, entry) => sum + entry.remaining, 0);
}

function syncCommittedPickups(car: ElevatorRuntime): void {
  car.committedPickups = car.waiting.map((entry) => entry.requestId);
}

function activeWaiting(car: ElevatorRuntime, requestMap: Map<string, RequestRuntime>) {
  return car.waiting
    .map((entry) => ({ entry, request: requestMap.get(entry.requestId)! }))
    .filter(({ request }) => request.status === 'waiting' || request.status === 'riding');
}

function waitingAtFloor(
  car: ElevatorRuntime,
  requestMap: Map<string, RequestRuntime>,
  floor: number
) {
  return activeWaiting(car, requestMap)
    .filter(({ entry, request }) => request.origin === floor && entry.remaining > 0)
    .sort((a, b) => a.request.id.localeCompare(b.request.id, 'zh-CN'));
}

function alightingAtFloor(
  car: ElevatorRuntime,
  requestMap: Map<string, RequestRuntime>,
  floor: number
) {
  return car.onboard
    .map((entry) => ({ entry, request: requestMap.get(entry.requestId)! }))
    .filter(({ request }) => request.destination === floor)
    .sort((a, b) => a.request.id.localeCompare(b.request.id, 'zh-CN'));
}

function uniqueFloors(floors: number[]): number[] {
  return [...new Set(floors)].sort((a, b) => a - b);
}

function pickupFloors(car: ElevatorRuntime, requestMap: Map<string, RequestRuntime>): number[] {
  return uniqueFloors(
    activeWaiting(car, requestMap).map(({ request }) => request.origin)
  );
}

function dropFloors(car: ElevatorRuntime, requestMap: Map<string, RequestRuntime>): number[] {
  return uniqueFloors(
    car.onboard.map((entry) => requestMap.get(entry.requestId)!.destination)
  );
}

function emit(events: SimEvent[], event: SimEvent): void {
  events.push(event);
}

function doorReason(
  car: ElevatorRuntime,
  requestMap: Map<string, RequestRuntime>
): {
  reason: string;
  dropIds: string[];
  pickupIds: string[];
  dropFloors: number[];
  pickupFloors: number[];
} {
  const drops = alightingAtFloor(car, requestMap, car.floor);
  const pickups = waitingAtFloor(car, requestMap, car.floor)
    .filter(({ request }) => !car.attempted.includes(request.id));
  const dropIds = drops.map(({ request }) => request.id);
  const pickupIds = pickups.map(({ request }) => request.id);
  const parts: string[] = [];
  if (dropIds.length) parts.push(`下客 ${dropIds.join('、')}`);
  if (pickupIds.length) parts.push(`接客 ${pickupIds.join('、')}`);
  return {
    reason: `${parts.join('；') || '已承诺停靠'}，载重 ${carLoad(car)}/${CAR_CAPACITY}`,
    dropIds,
    pickupIds,
    dropFloors: uniqueFloors(drops.map(({ request }) => request.destination)),
    pickupFloors: uniqueFloors(pickups.map(({ request }) => request.origin))
  };
}

function startOpening(
  car: ElevatorRuntime,
  context: StepContext
): void {
  const reason = doorReason(car, context.requestMap);
  car.phase = 'opening';
  car.phaseElapsed = 0;
  car.targetFloor = null;
  car.direction = 0;
  emit(context.events, {
    tick: context.tick,
    carId: car.id,
    type: 'door_opening',
    floor: car.floor,
    message: `#${car.id} 在 ${car.floor} 层开始开门：${reason.reason}`,
    reason: reason.reason,
    committedPickups: reason.pickupFloors,
    dropOffs: reason.dropFloors,
    peopleOnboard: carLoad(car)
  });
}

/**
 * Boarding and alighting happen while the door is physically open.
 * Returns the dry-run candidate ID only on a tick where it has its first pickup chance.
 */
function transferPassengers(
  car: ElevatorRuntime,
  context: StepContext
): string | null {
  let candidatePickupTick: string | null = null;

  for (const { entry, request } of alightingAtFloor(car, context.requestMap, car.floor)) {
    const people = entry.remaining;
    car.onboard = car.onboard.filter((item) => item.requestId !== request.id);
    request.completed += people;
    if (request.boarded - request.completed > 0) {
      // Some boarded passengers are still inside a car (possibly a different car after an
      // outage re-dispatch); keep riding until the last onboard group arrives.
      request.status = 'riding';
    } else if (request.remaining > 0) {
      // The boarded part was delivered but an unboarded residual remains. It keeps its commitment
      // to this same car (which returns for it); carId and the waiting entry are intentionally kept.
      request.status = 'waiting';
    } else {
      request.status = 'completed';
      request.carId = null;
    }
    emit(context.events, {
      tick: context.tick,
      carId: car.id,
      requestId: request.id,
      type: 'alight',
      floor: car.floor,
      people,
      peopleOnboard: carLoad(car),
      message: `#${car.id}：${request.id} 在 ${car.floor} 层下客 ${people} 人；该请求累计完成 ${request.completed}/${request.people}。`
    });
  }

  const candidates = waitingAtFloor(car, context.requestMap, car.floor);
  for (const item of candidates) {
    const { entry, request } = item;
    if (car.attempted.includes(request.id)) continue;

    const space = CAR_CAPACITY - carLoad(car);
    const boarding = Math.max(0, Math.min(space, entry.remaining));
    if (context.dryCandidateId === request.id && boarding > 0) {
      candidatePickupTick = request.id;
    }

    if (boarding > 0) {
      entry.remaining -= boarding;
      request.remaining -= boarding;
      request.boarded += boarding;
      request.status = 'riding';
      car.onboard.push({ requestId: request.id, remaining: boarding });
      if (entry.remaining === 0) {
        car.waiting = car.waiting.filter((waiting) => waiting.requestId !== request.id);
        car.attempted = car.attempted.filter((id) => id !== request.id);
      } else {
        car.attempted.push(request.id);
      }
      syncCommittedPickups(car);
      emit(context.events, {
        tick: context.tick,
        carId: car.id,
        requestId: request.id,
        type: 'board',
        floor: car.floor,
        people: boarding,
        remaining: request.remaining,
        peopleOnboard: carLoad(car),
        reason: entry.remaining > 0 ? '轿厢容量不足，余客继续等待同一台电梯' : '该批乘客全部上车',
        message:
          entry.remaining > 0
            ? `#${car.id}：${request.id} 在 ${car.floor} 层仅上车 ${boarding} 人，剩余 ${request.remaining} 人继续等待。`
            : `#${car.id}：${request.id} 在 ${car.floor} 层上车 ${boarding} 人，全部已接走。`
      });
    } else {
      if (!car.attempted.includes(request.id)) car.attempted.push(request.id);
      emit(context.events, {
        tick: context.tick,
        carId: car.id,
        requestId: request.id,
        type: 'board',
        floor: car.floor,
        people: 0,
        remaining: request.remaining,
        peopleOnboard: carLoad(car),
        reason: `轿厢满载（${carLoad(car)}/${CAR_CAPACITY}），所有 ${request.remaining} 人继续等待`,
        message: `#${car.id}：${request.id} 在 ${car.floor} 层无人上车，轿厢满载，剩余 ${request.remaining} 人等待返回后再接。`
      });
    }
  }

  return candidatePickupTick;
}

function chooseTargetFloor(car: ElevatorRuntime, requestMap: Map<string, RequestRuntime>): number | null {
  // Onboard passengers always have routing priority. Waiting pickups are considered only after
  // the car is empty; otherwise a full car returning for a residual pickup could fight against
  // onboard destination direction.
  const onboardDestinations = uniqueFloors(
    car.onboard.map((entry) => requestMap.get(entry.requestId)!.destination)
  ).filter((floor) => floor !== car.floor);
  const targetFloors = onboardDestinations.length > 0
    ? onboardDestinations
    : uniqueFloors([
        ...pickupFloors(car, requestMap),
        ...dropFloors(car, requestMap)
      ]).filter((floor) => floor !== car.floor);

  if (targetFloors.length === 0) return null;

  if (car.direction === 0) {
    const distances = targetFloors.map((floor) => ({
      floor,
      distance: Math.abs(floor - car.floor)
    }));
    const minimum = Math.min(...distances.map((item) => item.distance));
    // Deterministic tie: prefer the upper floor when two commitments are equally near.
    return distances
      .filter((item) => item.distance === minimum)
      .map((item) => item.floor)
      .sort((a, b) => b - a)[0];
  }

  if (car.direction > 0) {
    const ahead = targetFloors.filter((floor) => floor > car.floor);
    if (ahead.length) return Math.min(...ahead);
    return Math.max(...targetFloors);
  }

  const behind = targetFloors.filter((floor) => floor < car.floor);
  if (behind.length) return Math.max(...behind);
  return Math.min(...targetFloors);
}

function startMoving(
  car: ElevatorRuntime,
  context: StepContext,
  travelTicks: number
): void {
  const target = chooseTargetFloor(car, context.requestMap);
  if (target === null) {
    car.phase = 'closed';
    car.phaseElapsed = 0;
    car.targetFloor = null;
    car.direction = 0;
    if (!car.idleLogged) {
      car.idleLogged = true;
      emit(context.events, {
        tick: context.tick,
        carId: car.id,
        type: 'idle',
        floor: car.floor,
        peopleOnboard: 0,
        message: `#${car.id} 在 ${car.floor} 层关门待机；当前没有已承诺停靠点。`
      });
    }
    return;
  }

  const nextFloor = target > car.floor ? car.floor + 1 : car.floor - 1;
  const direction: Direction = target > car.floor ? 1 : -1;
  car.direction = direction;
  car.targetFloor = nextFloor;
  car.phase = 'moving';
  car.phaseElapsed = 0;
  car.movementTickStarted = context.tick;
  car.idleLogged = false;
  car.attempted = [];

  const load = carLoad(car);
  const pickups = pickupFloors(car, context.requestMap);
  const drops = dropFloors(car, context.requestMap);
  const reason =
    `已承诺接客楼层 [${pickups.join(', ') || '无'}]，下客楼层 [${drops.join(', ') || '无'}]，` +
    `SCAN 方向${direction > 0 ? '向上' : '向下'}先到 ${target} 层；本层移动至 ${nextFloor} 层。`;
  emit(context.events, {
    tick: context.tick,
    carId: car.id,
    type: 'move_start',
    fromFloor: car.floor,
    toFloor: nextFloor,
    floor: car.floor,
    reason,
    committedPickups: pickups,
    dropOffs: drops,
    peopleOnboard: load,
    message: `#${car.id} ${load === 0 ? '空驶' : `载客 ${load} 人`}，从 ${car.floor} 层${directionText(direction)} ${nextFloor} 层。${reason}`
  });

  // travelTicks is consumed by the moving phase; the actual floor number changes on arrival.
  void travelTicks;
}

function actFromFloor(
  car: ElevatorRuntime,
  context: StepContext,
  scenario: ValidatedScenario
): void {
  const drops = alightingAtFloor(car, context.requestMap, car.floor);
  const pickups = waitingAtFloor(car, context.requestMap, car.floor)
    .filter(({ request }) => !car.attempted.includes(request.id));

  if (drops.length > 0 || pickups.length > 0) {
    startOpening(car, context);
  } else {
    startMoving(car, context, scenario.travelTicks);
  }
}

function stepCar(
  car: ElevatorRuntime,
  context: StepContext,
  scenario: ValidatedScenario
): string | null {
  let dryResult: string | null = null;

  if (car.phase === 'opening') {
    // A car may resume mid-phase after an outage; the completion test consumes the frozen
    // remaining duration rather than replaying the already elapsed ticks.
    if (car.phaseElapsed + 1 >= scenario.doorOpenTicks) {
      car.phaseElapsed = 0;
      const loadBefore = carLoad(car);
      dryResult = transferPassengers(car, context);
      emit(context.events, {
        tick: context.tick,
        carId: car.id,
        type: 'door_open',
        floor: car.floor,
        reason: `开门耗时 ${scenario.doorOpenTicks} tick 已完成，门开瞬间上下客，随后进入关门；门未关不能行驶`,
        peopleOnboard: carLoad(car),
        message: `#${car.id} 在 ${car.floor} 层门全开，执行上下客（载重 ${loadBefore} → ${carLoad(car)}）。`
      });
      car.phase = 'closing';
      emit(context.events, {
        tick: context.tick,
        carId: car.id,
        type: 'door_closing',
        floor: car.floor,
        reason: `上下客完成后立即关门，关门耗时 ${scenario.doorCloseTicks} tick`,
        peopleOnboard: carLoad(car),
        message: `#${car.id} 在 ${car.floor} 层开始关门，关门耗时 ${scenario.doorCloseTicks} tick。`
      });
    } else {
      car.phaseElapsed += 1;
    }
    return dryResult;
  }

  if (car.phase === 'closing') {
    if (car.phaseElapsed + 1 >= scenario.doorCloseTicks) {
      car.phase = 'closed';
      car.phaseElapsed = 0;
      emit(context.events, {
        tick: context.tick,
        carId: car.id,
        type: 'door_closed',
        floor: car.floor,
        peopleOnboard: carLoad(car),
        message: `#${car.id} 在 ${car.floor} 层门已关闭；只有关门后才能行驶。`
      });
      actFromFloor(car, context, scenario);
    } else {
      car.phaseElapsed += 1;
    }
    return dryResult;
  }

  if (car.phase === 'moving') {
    // Resuming a frozen move consumes only the remaining travelTicks; no distance is invented.
    if (car.phaseElapsed + 1 >= scenario.travelTicks) {
      const from = car.floor;
      car.floor = car.targetFloor ?? car.floor;
      car.phase = 'closed';
      car.phaseElapsed = 0;
      car.targetFloor = null;
      car.movementTickStarted = null;
      const willStop =
        alightingAtFloor(car, context.requestMap, car.floor).length > 0 ||
        waitingAtFloor(car, context.requestMap, car.floor).some(
          ({ request }) => !car.attempted.includes(request.id)
        );
      emit(context.events, {
        tick: context.tick,
        carId: car.id,
        type: 'move_arrive',
        fromFloor: from,
        toFloor: car.floor,
        floor: car.floor,
        reason: willStop ? '本层存在下客或未尝试过的承诺接客点' : '本层无承诺服务，将继续 SCAN 行驶',
        peopleOnboard: carLoad(car),
        message: `#${car.id} 用时 ${scenario.travelTicks} tick 从 ${from} 层到达 ${car.floor} 层；${willStop ? '停靠开门' : '继续下一停靠点'}。`
      });
      actFromFloor(car, context, scenario);
    } else {
      car.phaseElapsed += 1;
    }
    return null;
  }

  actFromFloor(car, context, scenario);
  return null;
}

function earliestPickupEta(
  car: ElevatorRuntime,
  request: RequestRuntime,
  requestMap: Map<string, RequestRuntime>,
  scenario: ValidatedScenario,
  now: number
): number {
  const dryCar = structuredClone(car);
  const dryRequests = structuredClone([...requestMap.values()]);
  const dryMap = new Map(dryRequests.map((item) => [item.id, item]));
  const candidate = structuredClone(request);
  candidate.status = 'waiting';
  candidate.carId = dryCar.id;
  candidate.assignedTick = now;
  dryMap.set(candidate.id, candidate);
  dryCar.waiting.push({ requestId: candidate.id, remaining: candidate.remaining });
  syncCommittedPickups(dryCar);

  // Dispatch is performed before the current-tick transition, so the dry run starts at `now`
  // rather than one tick later. A car whose opening animation ends on this tick can board at once.
  if (
    dryCar.floor === request.origin &&
    dryCar.phase === 'opening' &&
    dryCar.phaseElapsed + 1 >= scenario.doorOpenTicks
  ) {
    return now;
  }

  for (let futureTick = now; futureTick <= now + MAX_SIMULATION_TICKS; futureTick++) {
    const events: SimEvent[] = [];
    const context: StepContext = {
      events,
      requestMap: dryMap,
      tick: futureTick,
      dryCandidateId: candidate.id
    };
    const hadCandidate = dryCar.waiting.some((entry) => entry.requestId === candidate.id);
    const result = stepCar(dryCar, context, scenario);
    if (result === candidate.id) return futureTick;
    // It may have fully or partially boarded; either way the first contact is the pickup ETA.
    if (hadCandidate && !dryCar.waiting.some((entry) => entry.requestId === candidate.id)) {
      return futureTick;
    }
    if (
      dryCar.onboard.some((entry) => entry.requestId === candidate.id) &&
      dryCar.floor === request.origin
    ) {
      return futureTick;
    }
  }

  throw new Error(`无法计算请求 ${request.id} 对电梯 #${car.id} 的最早接客时刻。`);
}

function assignRequest(
  state: RuntimeState,
  request: RequestRuntime,
  scenario: ValidatedScenario,
  tick: number,
  reassignReason?: { withdrawnFromCar: number }
): void {
  const requestMap = new Map(state.requests.map((item) => [item.id, item]));
  // Out-of-service cars are frozen and must not receive new commitments.
  const availableCars = state.cars.filter((car) => !car.outOfService);
  const candidates = state.cars.map((car) => ({
    carId: car.id,
    eta: car.outOfService
      ? null
      : earliestPickupEta(car, request, requestMap, scenario, tick),
    floor: car.floor,
    phase: car.phase,
    load: carLoad(car)
  }));

  if (availableCars.length === 0) {
    // Requests are never cancelled by a fleet outage; they keep waiting until a car recovers.
    request.carId = null;
    request.assignedTick = null;
    emit(state.events, {
      tick,
      requestId: request.id,
      type: 'dispatch_deferred',
      floor: request.origin,
      remaining: request.remaining,
      candidates,
      reason:
        '没有可用电梯（全部停运），未上车乘客继续等待，不作取消；待任一电梯恢复后于后续 tick 重新派车。',
      message:
        `请求 ${request.id}（${request.origin}→${request.destination}，剩余 ${request.remaining} 人）本 tick 无可用电梯，继续等待。`
    });
    return;
  }

  const selected = [...candidates]
    .filter((candidate) => candidate.eta !== null)
    .sort((a, b) => (a.eta ?? 0) - (b.eta ?? 0) || a.carId - b.carId)[0];
  const car = state.cars.find((item) => item.id === selected.carId)!;
  request.carId = car.id;
  request.assignedTick = tick;
  car.waiting.push({ requestId: request.id, remaining: request.remaining });
  car.idleLogged = false;
  syncCommittedPickups(car);

  const reassignNote = reassignReason
    ? `（原派电梯 #${reassignReason.withdrawnFromCar} 停运，承诺撤回后重新派车）`
    : '';
  emit(state.events, {
    tick,
    carId: car.id,
    requestId: request.id,
    type: 'dispatch',
    eta: selected.eta ?? undefined,
    candidates,
    floor: request.origin,
    reason:
      `按已承诺停靠点分别推演最早开门接客时刻；最小 ETA=${selected.eta}，` +
      `ETA 相同则选择电梯 ID 最小者；停运电梯不参与候选。候选：${candidates
        .map((candidate) =>
          candidate.eta === null
            ? `#${candidate.carId}@${candidate.floor}层/${candidate.phase}/停运`
            : `#${candidate.carId}@${candidate.floor}层/${candidate.phase}/ETA${candidate.eta}`
        )
        .join('，')}`,
    message:
      `请求 ${request.id}（${request.origin}→${request.destination}，${request.remaining} 人）派给 #${car.id}；` +
      `最早可接客 tick=${selected.eta}。${reassignNote}`
  });
}

function cancelUnboarded(state: RuntimeState, request: RequestRuntime, tick: number): void {
  if (request.status === 'completed') return;

  if (request.status === 'riding' && request.remaining === 0) {
    emit(state.events, {
      tick,
      requestId: request.id,
      carId: request.carId ?? undefined,
      type: 'cancel_rejected',
      people: 0,
      peopleOnboard: request.boarded - request.completed,
      reason: '乘客已经上车，不可取消',
      message: `请求 ${request.id} 的取消被拒绝：${request.boarded} 名已上车乘客不可取消。`
    });
    return;
  }

  const cancelledPeople = request.remaining;
  if (
    cancelledPeople <= 0 ||
    (request.status !== 'pending' && request.status !== 'waiting' && request.status !== 'riding')
  ) {
    return;
  }

  const carId = request.carId;
  if (carId !== null) {
    const car = state.cars.find((item) => item.id === carId);
    if (car) {
      car.waiting = car.waiting.filter((entry) => entry.requestId !== request.id);
      car.attempted = car.attempted.filter((id) => id !== request.id);
      syncCommittedPickups(car);
    }
  }

  request.cancelled += cancelledPeople;
  request.remaining = 0;
  if (request.boarded - request.completed > 0) {
    // Some boarded passengers are still inside a car; the request stays 'riding' for them.
    request.status = 'riding';
  } else {
    request.status = 'cancelled';
    request.carId = null;
  }

  emit(state.events, {
    tick,
    requestId: request.id,
    carId: carId ?? undefined,
    type: 'cancel',
    people: cancelledPeople,
    peopleOnboard: request.boarded - request.completed,
    reason: '仅取消尚未上车的乘客；已上车部分继续运送',
    message:
      request.boarded - request.completed > 0
        ? `请求 ${request.id} 取消 ${cancelledPeople} 名未上车乘客；已上车 ${request.boarded - request.completed} 人继续乘坐。`
        : `请求 ${request.id} 取消 ${cancelledPeople} 名未上车乘客，请求从等待队列移除。`
  });
}

function applyCarEvents(state: RuntimeState, scenario: ValidatedScenario, tick: number): void {
  const events = scenario.carEvents.filter((event) => event.tick === tick);
  for (const event of events) {
    const car = state.cars.find((item) => item.id === event.carId);
    if (!car) continue; // validation guarantees the car exists

    if (event.type === 'outage') {
      car.outOfService = true;
      car.outageTick = tick;
      car.idleLogged = false;

      // Boarded passengers and their destination commitments stay frozen; every not-yet-boarded
      // commitment is withdrawn and becomes eligible for re-dispatch to other cars.
      const withdrawn: Array<{ requestId: string; people: number }> = [];
      for (const entry of [...car.waiting]) {
        const request = state.requests.find((item) => item.id === entry.requestId)!;
        const people = Math.min(entry.remaining, request.remaining);
        withdrawn.push({ requestId: request.id, people });
        if (request.boarded - request.completed > 0) {
          // Partially boarded requests keep 'riding' (people are still inside this frozen car).
          request.status = 'riding';
        } else {
          request.status = 'waiting';
        }
        request.carId = null;
        request.assignedTick = null;
      }
      car.waiting = [];
      car.attempted = [];
      syncCommittedPickups(car);

      const load = carLoad(car);
      const drops = dropFloors(car, new Map(state.requests.map((r) => [r.id, r])));
      const frozenTarget = car.targetFloor;
      emit(state.events, {
        tick,
        carId: car.id,
        type: 'car_outage',
        floor: car.floor,
        fromFloor: car.floor,
        toFloor: frozenTarget ?? undefined,
        peopleOnboard: load,
        committedPickups: [],
        dropOffs: drops,
        withdrawn,
        reason:
          `冻结位置 ${car.floor} 层、门相位 ${car.phase}（已耗时 ${car.phaseElapsed} tick）；` +
          `已上车 ${load} 人与下客承诺 [${drops.join(', ') || '无'}] 保留，` +
          `未上车承诺 [${withdrawn.map((item) => `${item.requestId}:${item.people}人`).join('，') || '无'}] ` +
          `撤回后按其他可用车重新计算 ETA；停运期间不补行路程。`,
        message:
          `#${car.id} 在 tick ${tick} 临时停运：冻结于 ${car.floor} 层（${car.phase}），` +
          `车内 ${load} 名乘客保留；撤回 ${withdrawn.length} 个未上车承诺。`
      });
    } else {
      car.outOfService = false;
      car.outageTick = null;
      car.idleLogged = false;
      const load = carLoad(car);
      emit(state.events, {
        tick,
        carId: car.id,
        type: 'car_recover',
        floor: car.floor,
        toFloor: car.targetFloor ?? undefined,
        peopleOnboard: load,
        reason:
          `从冻结相位 ${car.phase}（已耗时 ${car.phaseElapsed} tick）继续，不补走停运期间路程；` +
          `本 tick 先参与派车，随后再推进轿厢。`,
        message:
          `#${car.id} 在 tick ${tick} 恢复运行：仍在 ${car.floor} 层，相位 ${car.phase}，` +
          `车内 ${load} 名乘客，重新参与派车。`
      });
    }
  }
}

function makeSnapshot(
  state: RuntimeState,
  scenario: ValidatedScenario,
  tick: number,
  active: boolean
): TickSnapshot {
  const requestMap = new Map(state.requests.map((request) => [request.id, request]));
  return {
    tick,
    active,
    cars: state.cars.map((car) => ({
      id: car.id,
      floor: car.floor,
      targetFloor: car.targetFloor,
      direction: car.direction,
      phase: car.phase,
      phaseElapsed: car.phaseElapsed,
      peopleOnboard: carLoad(car),
      capacity: CAR_CAPACITY,
      outOfService: car.outOfService,
      outageTick: car.outageTick,
      waiting: car.waiting.map((entry) => ({ ...entry })),
      onboard: car.onboard.map((entry) => ({ ...entry })),
      attempted: [...car.attempted],
      committedPickupFloors: pickupFloors(car, requestMap),
      committedDropFloors: dropFloors(car, requestMap)
    })),
    requests: state.requests.map((request) => ({
      id: request.id,
      arrivalTick: request.arrivalTick,
      origin: request.origin,
      destination: request.destination,
      people: request.people,
      remaining: request.remaining,
      boarded: request.boarded,
      completed: request.completed,
      cancelled: request.cancelled,
      cancelTick: request.cancelTick,
      status: request.status,
      carId: request.carId
    })),
    events: structuredClone(state.events),
    totalWaiting: state.requests
      .filter((request) => request.status === 'waiting' || request.status === 'riding')
      .reduce((sum, request) => sum + request.remaining, 0),
    totalUnassigned: state.requests
      .filter(
        (request) =>
          (request.status === 'waiting' || request.status === 'riding') &&
          request.remaining > 0 &&
          !state.cars.some((car) =>
            car.waiting.some((entry) => entry.requestId === request.id)
          )
      )
      .reduce((sum, request) => sum + request.remaining, 0),
    totalRiding: state.requests
      .filter((request) => request.status === 'riding')
      .reduce((sum, request) => sum + Math.max(0, request.boarded - request.completed), 0),
    totalCompleted: state.requests.reduce((sum, request) => sum + request.completed, 0),
    totalCancelled: state.requests.reduce((sum, request) => sum + request.cancelled, 0)
  };
}

function isFinished(state: RuntimeState): boolean {
  const unfinishedRequest = state.requests.some(
    (request) => request.status === 'pending' || request.status === 'waiting' || request.status === 'riding'
  );
  if (unfinishedRequest) return false;
  // Frozen cars cannot advance without an external recovery event; any onboard passenger would
  // keep a request in 'riding' above. An empty frozen car therefore never blocks completion, and
  // no distance is invented for the outage window.
  return state.cars
    .filter((car) => !car.outOfService)
    .every(
      (car) => car.phase === 'closed' && car.onboard.length === 0 && car.waiting.length === 0
    );
}

function outageWithdrawnCar(
  state: RuntimeState,
  request: RequestRuntime,
  tick: number
): { withdrawnFromCar: number } | undefined {
  const event = state.events.find(
    (item) =>
      item.tick === tick &&
      item.type === 'car_outage' &&
      item.withdrawn?.some((entry) => entry.requestId === request.id)
  );
  return event?.carId !== undefined ? { withdrawnFromCar: event.carId } : undefined;
}

function processTick(
  state: RuntimeState,
  scenario: ValidatedScenario,
  tick: number
): void {
  state.events = [];

  // Arrivals are visible at the beginning of the tick; an open car at that floor may serve them.
  for (const request of state.requests) {
    if (request.arrivalTick === tick && request.status === 'pending') {
      request.status = 'waiting';
      emit(state.events, {
        tick,
        requestId: request.id,
        type: 'arrival',
        floor: request.origin,
        people: request.people,
        reason: `${request.people} 人在 ${request.origin} 层登记，目的层 ${request.destination}`,
        message: `请求 ${request.id} 到达：${request.origin} → ${request.destination}，${request.people} 人。`
      });
    }
  }

  // Scheduled cancellation is applied before elevator motion/door transfer.
  for (const request of state.requests) {
    if (request.cancelTick === tick) {
      cancelUnboarded(state, request, tick);
    }
  }

  // Deterministic order within a tick: arrivals → cancels → outages/recoveries
  // (sorted by carId, outage before recover) → new dispatch → car transitions.
  // Outage/recovery therefore applies before this tick's dispatch and car advances.
  applyCarEvents(state, scenario, tick);

  // Dispatch every not-yet-assigned live request before updating cars. This includes residual
  // people of a partially boarded request whose car was withdrawn by an outage. Same-tick ties
  // use arrival tick then request ID ascending. The selected car sees the new commitment in this
  // tick's transition; if every car is frozen the request keeps waiting.
  const requestMap = new Map(state.requests.map((request) => [request.id, request]));
  // A live request is unassigned only when no car still holds a not-yet-boarded commitment for it.
  const committedIds = new Set(state.cars.flatMap((car) => car.waiting.map((entry) => entry.requestId)));
  const unassigned = state.requests
    .filter(
      (request) =>
        (request.status === 'waiting' || request.status === 'riding') &&
        request.remaining > 0 &&
        !committedIds.has(request.id)
    )
    .sort((a, b) => a.arrivalTick - b.arrivalTick || a.id.localeCompare(b.id, 'zh-CN'));
  for (const request of unassigned) {
    const withdrawnFromCar = outageWithdrawnCar(state, request, tick);
    assignRequest(state, request, scenario, tick, withdrawnFromCar);
  }

  for (const car of state.cars) {
    // Frozen cars keep floor, door phase and remaining phase time exactly as they were.
    if (car.outOfService) continue;
    const context: StepContext = { events: state.events, requestMap, tick };
    stepCar(car, context, scenario);
  }
}

export function simulate(input: Scenario | ValidatedScenario): SimulationResult {
  const { value: scenario } = validateScenario(input as Partial<Scenario>);
  const state: RuntimeState = {
    cars: Array.from({ length: scenario.elevators }, (_, index) => initialCar(index)),
    requests: initialRequest(scenario),
    events: []
  };

  const ticks: TickSnapshot[] = [];

  let finalTick = 0;
  for (let tick = 0; tick <= MAX_SIMULATION_TICKS; tick++) {
    processTick(state, scenario, tick);
    const finished = isFinished(state);
    finalTick = tick;
    ticks.push(makeSnapshot(state, scenario, tick, !finished));
    if (finished) break;
  }

  if (!isFinished(state)) {
    throw new Error(`仿真在 ${MAX_SIMULATION_TICKS} tick 后仍未结束，请检查场景参数。`);
  }

  return {
    scenario,
    maxTick: finalTick,
    finalTick,
    ticks,
    events: ticks.flatMap((snapshot) => snapshot.events)
  };
}

export { CAR_CAPACITY, MAX_SIMULATION_TICKS };

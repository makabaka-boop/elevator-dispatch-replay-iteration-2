import {
  CAR_CAPACITY,
  MAX_CARS,
  MAX_FLOORS,
  MAX_REQUESTS,
  MIN_CARS,
  MIN_FLOORS,
  type Scenario,
  type ValidatedRequest,
  type ValidatedScenario
} from './types';

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Number.isFinite(value);
}

export function validateScenario(input: Partial<Scenario> | null | undefined): {
  ok: true;
  value: ValidatedScenario;
} {
  const errors: string[] = [];
  const floors = input?.floors;
  const elevators = input?.elevators;
  const travelTicks = input?.travelTicks;
  const doorOpenTicks = input?.doorOpenTicks;
  const doorCloseTicks = input?.doorCloseTicks;
  const requests = Array.isArray(input?.requests) ? input!.requests : null;

  if (!isFiniteInteger(floors) || floors < MIN_FLOORS || floors > MAX_FLOORS) {
    errors.push(`楼层数必须是 ${MIN_FLOORS} 到 ${MAX_FLOORS} 的整数。`);
  }
  if (!isFiniteInteger(elevators) || elevators < MIN_CARS || elevators > MAX_CARS) {
    errors.push(`电梯台数必须是 ${MIN_CARS} 到 ${MAX_CARS} 的整数。`);
  }
  if (!isFiniteInteger(travelTicks) || travelTicks < 1) {
    errors.push('行驶一层耗时必须是正整数。');
  }
  if (!isFiniteInteger(doorOpenTicks) || doorOpenTicks < 1) {
    errors.push('开门耗时必须是正整数。');
  }
  if (!isFiniteInteger(doorCloseTicks) || doorCloseTicks < 1) {
    errors.push('关门耗时必须是正整数。');
  }
  if (!requests) {
    errors.push('requests 必须是数组。');
  } else if (requests.length > MAX_REQUESTS) {
    errors.push(`请求数量最多为 ${MAX_REQUESTS} 个，当前为 ${requests.length} 个。`);
  }

  const floorCount = isFiniteInteger(floors) ? floors : 0;
  const seenIds = new Set<string>();
  const validRequests: ValidatedRequest[] = [];

  if (requests) {
    requests.forEach((raw, index) => {
      const fallbackId = `R${String(index + 1).padStart(3, '0')}`;
      const id = raw && raw.id !== undefined && raw.id !== null && String(raw.id).trim() !== ''
        ? String(raw.id)
        : fallbackId;
      const prefix = `请求 ${id}`;

      if (seenIds.has(id)) {
        errors.push(`${prefix}: ID 重复。`);
      }
      seenIds.add(id);

      if (!raw || !isFiniteInteger(raw.arrivalTick) || raw.arrivalTick < 0) {
        errors.push(`${prefix}: 到达 tick 必须是非负整数。`);
      }
      if (!isFiniteInteger(raw?.origin) || raw.origin < 1 || raw.origin > floorCount) {
        errors.push(`${prefix}: 出发层必须在 1 到 ${floorCount || MAX_FLOORS} 之间。`);
      }
      if (!isFiniteInteger(raw?.destination) || raw.destination < 1 || raw.destination > floorCount) {
        errors.push(`${prefix}: 目的层必须在 1 到 ${floorCount || MAX_FLOORS} 之间。`);
      }
      if (raw && isFiniteInteger(raw.origin) && isFiniteInteger(raw.destination) && raw.origin === raw.destination) {
        errors.push(`${prefix}: 出发层和目的层不能相同。`);
      }
      if (!raw || !isFiniteInteger(raw.people) || raw.people < 1) {
        errors.push(`${prefix}: 人数必须是正整数。`);
      }

      let cancelTick: number | null = null;
      if (raw && raw.cancelTick !== undefined && raw.cancelTick !== null) {
        if (!isFiniteInteger(raw.cancelTick) || raw.cancelTick < 0) {
          errors.push(`${prefix}: 取消 tick 必须是非负整数或 null。`);
        } else {
          cancelTick = raw.cancelTick;
        }
      }

      if (
        raw && isFiniteInteger(raw.arrivalTick) && cancelTick !== null && cancelTick < raw.arrivalTick
      ) {
        errors.push(`${prefix}: 取消 tick 不能早于到达 tick。`);
      }

      if (raw && isFiniteInteger(raw.arrivalTick) && isFiniteInteger(raw.people)) {
        validRequests.push({
          ...raw,
          id,
          arrivalTick: raw.arrivalTick,
          origin: raw.origin,
          destination: raw.destination,
          people: raw.people,
          cancelTick
        } as ValidatedRequest);
      }
    });
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  const scenario: ValidatedScenario = {
    floors: floors as number,
    elevators: elevators as number,
    travelTicks: travelTicks as number,
    doorOpenTicks: doorOpenTicks as number,
    doorCloseTicks: doorCloseTicks as number,
    // Errors above guarantee valid request shape; sorting keeps same-tick tie-break deterministic.
    requests: validRequests
      .sort((a, b) => a.arrivalTick - b.arrivalTick || a.id.localeCompare(b.id, 'zh-CN'))
      .map((request, index) => ({
        ...request,
        id: request.id || `R${String(index + 1).padStart(3, '0')}`
      }))
  };

  return { ok: true, value: scenario };
}

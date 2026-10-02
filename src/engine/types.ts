export const MIN_FLOORS = 3;
export const MAX_FLOORS = 16;
export const MIN_CARS = 2;
export const MAX_CARS = 4;
export const CAR_CAPACITY = 6;
export const MAX_REQUESTS = 100;
export const DEFAULT_SPEEDS = [1, 2, 4, 8, 16] as const;

export type RequestStatus = 'pending' | 'waiting' | 'riding' | 'completed' | 'cancelled';
export type DoorPhase = 'closed' | 'opening' | 'open' | 'closing' | 'moving';
export type Direction = 1 | -1 | 0;

export interface ScenarioRequest {
  id?: string;
  arrivalTick: number;
  origin: number;
  destination: number;
  people: number;
  /** If set, the still-not-boarded part is cancelled at this tick. Riding people cannot cancel. */
  cancelTick?: number | null;
}

/** 'outage' freezes the car; 'recover' resumes it from the frozen phase. */
export type CarEventType = 'outage' | 'recover';

export interface ScenarioCarEvent {
  carId: number;
  tick: number;
  type: CarEventType;
}

export interface ValidatedCarEvent extends ScenarioCarEvent {
  type: CarEventType;
}

export interface Scenario {
  floors: number;
  elevators: number;
  travelTicks: number;
  doorOpenTicks: number;
  doorCloseTicks: number;
  requests: ScenarioRequest[];
  /** Optional per-tick outage/recover events. Sorted by tick, carId, type after validation. */
  carEvents?: ScenarioCarEvent[];
}

export interface ValidatedRequest extends ScenarioRequest {
  id: string;
  cancelTick: number | null;
}

export interface ValidatedScenario {
  floors: number;
  elevators: number;
  travelTicks: number;
  doorOpenTicks: number;
  doorCloseTicks: number;
  requests: ValidatedRequest[];
  carEvents: ValidatedCarEvent[];
}

export interface CarRequest {
  requestId: string;
  remaining: number;
}

export interface ElevatorRuntime {
  id: number;
  floor: number;
  targetFloor: number | null;
  direction: Direction;
  phase: DoorPhase;
  phaseElapsed: number;
  onboard: CarRequest[];
  waiting: CarRequest[];
  attempted: string[];
  /** request IDs selected but not yet serviced at their origin. */
  committedPickups: string[];
  movementTickStarted: number | null;
  idleLogged: boolean;
  /** Frozen cars skip every tick transition until a matching recover event. */
  outOfService: boolean;
  /** Tick at which the current outage began (null while in service). */
  outageTick: number | null;
}

export interface RequestRuntime {
  id: string;
  arrivalTick: number;
  origin: number;
  destination: number;
  people: number;
  remaining: number;
  boarded: number;
  completed: number;
  cancelled: number;
  cancelTick: number | null;
  status: RequestStatus;
  carId: number | null;
  assignedTick: number | null;
}

export type SimEventType =
  | 'arrival'
  | 'dispatch'
  | 'dispatch_deferred'
  | 'door_opening'
  | 'door_open'
  | 'door_closing'
  | 'door_closed'
  | 'alight'
  | 'board'
  | 'move_start'
  | 'move_arrive'
  | 'cancel'
  | 'cancel_rejected'
  | 'car_outage'
  | 'car_recover'
  | 'idle';

export interface SimEvent {
  tick: number;
  carId?: number;
  requestId?: string;
  type: SimEventType;
  message: string;
  floor?: number;
  fromFloor?: number;
  toFloor?: number;
  people?: number;
  remaining?: number;
  eta?: number;
  candidates?: Array<{
    carId: number;
    eta: number | null;
    floor: number;
    phase: DoorPhase;
    load: number;
  }>;
  committedPickups?: number[];
  dropOffs?: number[];
  reason?: string;
  peopleOnboard?: number;
  /** Pickup commitments withdrawn when the assigned car went out of service. */
  withdrawn?: Array<{ requestId: string; people: number }>;
}

export interface TickRequestView {
  id: string;
  arrivalTick: number;
  origin: number;
  destination: number;
  people: number;
  remaining: number;
  boarded: number;
  completed: number;
  cancelled: number;
  cancelTick: number | null;
  status: RequestStatus;
  carId: number | null;
}

export interface TickCarView {
  id: number;
  floor: number;
  targetFloor: number | null;
  direction: Direction;
  phase: DoorPhase;
  phaseElapsed: number;
  peopleOnboard: number;
  capacity: number;
  outOfService: boolean;
  outageTick: number | null;
  waiting: Array<{ requestId: string; remaining: number }>;
  onboard: Array<{ requestId: string; remaining: number }>;
  attempted: string[];
  committedPickupFloors: number[];
  committedDropFloors: number[];
}

export interface TickSnapshot {
  tick: number;
  cars: TickCarView[];
  requests: TickRequestView[];
  events: SimEvent[];
  active: boolean;
  totalWaiting: number;
  /** Not-yet-boarded people whose assigned car was withdrawn and no car is available. */
  totalUnassigned: number;
  totalRiding: number;
  totalCompleted: number;
  totalCancelled: number;
}

export interface SimulationResult {
  scenario: ValidatedScenario;
  maxTick: number;
  finalTick: number;
  ticks: TickSnapshot[];
  events: SimEvent[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  scenario?: ValidatedScenario;
}

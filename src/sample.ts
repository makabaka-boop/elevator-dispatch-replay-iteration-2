import type { Scenario } from './engine/types';

export const sampleScenario: Scenario = {
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

export const outageScenario: Scenario = {
  floors: 10,
  elevators: 3,
  travelTicks: 2,
  doorOpenTicks: 1,
  doorCloseTicks: 1,
  requests: [
    { id: 'R001', arrivalTick: 0, origin: 1, destination: 8, people: 6 },
    { id: 'R002', arrivalTick: 0, origin: 1, destination: 4, people: 10 },
    { id: 'R003', arrivalTick: 2, origin: 3, destination: 9, people: 2 },
    { id: 'R004', arrivalTick: 6, origin: 6, destination: 2, people: 3 },
    { id: 'R005', arrivalTick: 8, origin: 10, destination: 1, people: 1 }
  ],
  carEvents: [
    // Car 0 freezes mid-move with 6 onboard; residual R002 people are reassigned.
    { carId: 0, tick: 4, type: 'outage' },
    { carId: 0, tick: 9, type: 'recover' },
    // Whole fleet briefly freezes; R004/R005 keep waiting instead of being cancelled.
    { carId: 1, tick: 7, type: 'outage' },
    { carId: 2, tick: 7, type: 'outage' },
    { carId: 1, tick: 11, type: 'recover' },
    { carId: 2, tick: 12, type: 'recover' }
  ]
};

export const stressScenario: Scenario = {
  floors: 16,
  elevators: 4,
  travelTicks: 1,
  doorOpenTicks: 1,
  doorCloseTicks: 1,
  requests: Array.from({ length: 32 }, (_, index) => {
    const origin = (index * 7) % 16 + 1;
    let destination = (index * 11) % 16 + 1;
    if (destination === origin) destination = destination === 16 ? 1 : destination + 1;
    return {
      id: `R${String(index + 1).padStart(3, '0')}`,
      arrivalTick: index * 2,
      origin,
      destination,
      people: (index % 8) + 1,
      ...(index % 9 === 4 ? { cancelTick: index * 2 + 5 } : {})
    };
  })
};

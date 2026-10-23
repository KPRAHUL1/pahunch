import type { Vehicle } from "@/lib/types";

/**
 * Vehicle library. Mass, Cd and frontal area are from published specs where the
 * OEM gives them and from body-dimension estimates where it does not. Crr,
 * drivetrain and regen efficiencies are typical values for the drivetrain class
 * rather than measured per model -- the per-vehicle calibration layer in
 * `calibration.ts` is what corrects the resulting bias against logged trips.
 *
 * `claimedRangeKm` is deliberately carried through to the UI. The gap between
 * the MIDC figure and what this model predicts for a real trip is the entire
 * reason this project exists.
 */
export const VEHICLES: Vehicle[] = [
  {
    id: "nexon-ev-45",
    name: "Tata Nexon EV 45",
    segment: "car",
    capacityKwh: 45,
    usableFraction: 0.93,
    massKg: 1550,
    cd: 0.37,
    frontalAreaM2: 2.32,
    crr: 0.011,
    drivetrainEff: 0.88,
    regenEff: 0.6,
    auxBaseW: 350,
    hvacPeakW: 3200,
    claimedRangeKm: 465,
    claimedRangeStandard: "MIDC",
  },
  {
    id: "tiago-ev-24",
    name: "Tata Tiago EV 24",
    segment: "car",
    capacityKwh: 24,
    usableFraction: 0.92,
    massKg: 1215,
    cd: 0.34,
    frontalAreaM2: 2.1,
    crr: 0.011,
    drivetrainEff: 0.87,
    regenEff: 0.55,
    auxBaseW: 300,
    hvacPeakW: 2600,
    claimedRangeKm: 315,
    claimedRangeStandard: "MIDC",
  },
  {
    id: "windsor-ev",
    name: "MG Windsor EV",
    segment: "car",
    capacityKwh: 38,
    usableFraction: 0.93,
    massKg: 1510,
    cd: 0.35,
    frontalAreaM2: 2.45,
    crr: 0.0105,
    drivetrainEff: 0.89,
    regenEff: 0.62,
    auxBaseW: 340,
    hvacPeakW: 3000,
    claimedRangeKm: 332,
    claimedRangeStandard: "MIDC",
  },
  {
    id: "comet-ev",
    name: "MG Comet EV",
    segment: "car",
    capacityKwh: 17.3,
    usableFraction: 0.92,
    massKg: 815,
    cd: 0.38,
    frontalAreaM2: 1.95,
    crr: 0.012,
    drivetrainEff: 0.86,
    regenEff: 0.5,
    auxBaseW: 260,
    hvacPeakW: 2200,
    claimedRangeKm: 230,
    claimedRangeStandard: "MIDC",
  },
  {
    id: "ather-450x",
    name: "Ather 450X (3.7 kWh)",
    segment: "scooter",
    capacityKwh: 3.7,
    usableFraction: 0.95,
    massKg: 112,
    cd: 0.9,
    // The rider is most of the frontal area on a scooter, and an upright rider
    // is a worse shape than the scooter. Sizing CdA off the bodywork alone put
    // city consumption near 19 Wh/km, below the IDC claim, which cannot be
    // right: a certification cycle is optimistic by construction.
    frontalAreaM2: 0.72,
    crr: 0.014,
    drivetrainEff: 0.85,
    regenEff: 0.35,
    auxBaseW: 65,
    hvacPeakW: 0,
    claimedRangeKm: 150,
    claimedRangeStandard: "IDC",
  },
  {
    id: "ola-s1-pro",
    name: "Ola S1 Pro Gen 3",
    segment: "scooter",
    capacityKwh: 4,
    usableFraction: 0.94,
    massKg: 116,
    cd: 0.92,
    frontalAreaM2: 0.74,
    crr: 0.014,
    drivetrainEff: 0.84,
    regenEff: 0.35,
    auxBaseW: 70,
    hvacPeakW: 0,
    claimedRangeKm: 195,
    claimedRangeStandard: "IDC",
  },
  {
    id: "mahindra-be6",
    name: "Mahindra BE 6 (79 kWh)",
    segment: "car",
    capacityKwh: 79,
    usableFraction: 0.94,
    massKg: 2080,
    cd: 0.32,
    frontalAreaM2: 2.5,
    crr: 0.0105,
    drivetrainEff: 0.9,
    regenEff: 0.65,
    auxBaseW: 420,
    hvacPeakW: 3600,
    claimedRangeKm: 682,
    claimedRangeStandard: "MIDC",
  },
];

export const vehicleById = (id: string): Vehicle => {
  const v = VEHICLES.find((x) => x.id === id);
  if (!v) throw new Error(`Unknown vehicle: ${id}`);
  return v;
};

/** Per-occupant mass including the driver, kg. */
export const OCCUPANT_MASS_KG = 68;

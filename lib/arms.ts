/** Fixed experimental arm definitions — DO NOT change during the 60-day study */

export interface ArmDef {
  arm_code: string;
  discount_pct: number;
  label: string;
}

export const ARM_DEFINITIONS: ArmDef[] = [
  { arm_code: "CONTROL", discount_pct: 0, label: "0% — signal price" },
  { arm_code: "T1", discount_pct: 5, label: "5% below signal" },
  { arm_code: "T2", discount_pct: 10, label: "10% below signal" },
  { arm_code: "T3", discount_pct: 15, label: "15% below signal" },
  { arm_code: "T4", discount_pct: 20, label: "20% below signal" },
  { arm_code: "T5", discount_pct: 25, label: "25% below signal" },
  { arm_code: "T6", discount_pct: 30, label: "30% below signal" },
  { arm_code: "T7", discount_pct: 35, label: "35% below signal" },
];

export const STOP_MULT = 0.65;
export const TP1_MULT = 1.3;
export const TP2_MULT = 2.0;
export const TP3_MULT = 5.0;

export const TP1_SIZE = 0.3333;
export const TP2_SIZE = 0.3333;
export const TP3_SIZE = 0.3334;

export const SIGNAL_OPEN_HOURS = 24;

export function experimentDay(calledAt: Date, startDateStr: string): number {
  const start = new Date(startDateStr + "T00:00:00.000Z");
  const dayMs = 24 * 60 * 60 * 1000;
  const diff = Math.floor(
    (Date.UTC(
      calledAt.getUTCFullYear(),
      calledAt.getUTCMonth(),
      calledAt.getUTCDate()
    ) -
      start.getTime()) /
      dayMs
  );
  return diff + 1;
}

export function specimenId(calledAt: Date, shortHash: string): string {
  const y = calledAt.getUTCFullYear();
  const m = String(calledAt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(calledAt.getUTCDate()).padStart(2, "0");
  return `SIG-${y}${m}${d}-${shortHash}`;
}

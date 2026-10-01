/**
 * Treatment engine + price path tracker
 * Protocol frozen per research brief.
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { fetchTokenMetrics } from "./lib/price";
import {
  STOP_MULT,
  TP1_MULT,
  TP2_MULT,
  TP3_MULT,
  TP1_SIZE,
  TP2_SIZE,
  TP3_SIZE,
  SIGNAL_OPEN_HOURS,
} from "./lib/arms";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || ""
);

const POLL_MS = 60 * 1000;
const NOTIONAL = 100;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function nextSequence(armId: string): Promise<number> {
  const { data } = await supabase
    .from("arm_events")
    .select("sequence_no")
    .eq("arm_id", armId)
    .order("sequence_no", { ascending: false })
    .limit(1);
  return data && data.length > 0 ? data[0].sequence_no + 1 : 1;
}

async function recordEvent(params: {
  armId: string;
  signalId: string;
  eventType: string;
  price: number;
  remainingAfter: number;
  notes?: string;
}) {
  const seq = await nextSequence(params.armId);
  await supabase.from("arm_events").insert({
    arm_id: params.armId,
    signal_id: params.signalId,
    event_type: params.eventType,
    event_price_usd: params.price,
    event_at: new Date().toISOString(),
    remaining_pct_after: params.remainingAfter,
    sequence_no: seq,
    notes: params.notes || null,
  });
}

async function evaluateArm(arm: any, price: number, signalId: string) {
  if (arm.closure_reason) return;

  if (!arm.filled && !arm.no_fill) {
    if (price <= Number(arm.entry_target_usd)) {
      const fillPrice = Number(arm.entry_target_usd);
      const stop = fillPrice * STOP_MULT;
      const tp1 = fillPrice * TP1_MULT;
      const tp2 = fillPrice * TP2_MULT;
      const tp3 = fillPrice * TP3_MULT;

      await supabase
        .from("treatment_arms")
        .update({
          filled: true,
          fill_price_usd: fillPrice,
          filled_at: new Date().toISOString(),
          stop_price_usd: stop,
          tp1_price_usd: tp1,
          tp2_price_usd: tp2,
          tp3_price_usd: tp3,
          remaining_pct: 1.0,
        })
        .eq("id", arm.id);

      await recordEvent({
        armId: arm.id,
        signalId,
        eventType: "ENTRY",
        price: fillPrice,
        remainingAfter: 1.0,
      });

      console.log(`[ENTRY] ${arm.arm_code} @ $${fillPrice.toFixed(8)}`);

      arm.filled = true;
      arm.fill_price_usd = fillPrice;
      arm.stop_price_usd = stop;
      arm.tp1_price_usd = tp1;
      arm.tp2_price_usd = tp2;
      arm.tp3_price_usd = tp3;
      arm.remaining_pct = 1.0;
      arm.tp1_hit = false;
      arm.tp2_hit = false;
      arm.tp3_hit = false;
      arm.stop_hit = false;
    } else {
      return;
    }
  }

  if (!arm.filled) return;

  let remaining = Number(arm.remaining_pct);
  let pnl = Number(arm.realized_pnl_usd || 0);
  const entry = Number(arm.fill_price_usd);
  const updates: Record<string, any> = {};

  if (!arm.tp1_hit && price >= Number(arm.tp1_price_usd)) {
    const sold = TP1_SIZE;
    const proceeds = (sold * NOTIONAL * Number(arm.tp1_price_usd)) / entry;
    pnl += proceeds - sold * NOTIONAL;
    remaining = Math.max(0, remaining - sold);
    updates.tp1_hit = true;
    updates.remaining_pct = remaining;
    updates.realized_pnl_usd = pnl;
    updates.realized_roi = pnl / NOTIONAL;
    await recordEvent({
      armId: arm.id,
      signalId,
      eventType: "TP1",
      price: Number(arm.tp1_price_usd),
      remainingAfter: remaining,
    });
    console.log(`[TP1] ${arm.arm_code}`);
    arm.tp1_hit = true;
  }

  if (arm.tp1_hit && !arm.tp2_hit && price >= Number(arm.tp2_price_usd)) {
    const sold = TP2_SIZE;
    const proceeds = (sold * NOTIONAL * Number(arm.tp2_price_usd)) / entry;
    pnl += proceeds - sold * NOTIONAL;
    remaining = Math.max(0, remaining - sold);
    updates.tp2_hit = true;
    updates.remaining_pct = remaining;
    updates.realized_pnl_usd = pnl;
    updates.realized_roi = pnl / NOTIONAL;
    await recordEvent({
      armId: arm.id,
      signalId,
      eventType: "TP2",
      price: Number(arm.tp2_price_usd),
      remainingAfter: remaining,
    });
    console.log(`[TP2] ${arm.arm_code}`);
    arm.tp2_hit = true;
  }

  if (arm.tp2_hit && !arm.tp3_hit && price >= Number(arm.tp3_price_usd)) {
    const sold = TP3_SIZE;
    const proceeds = (sold * NOTIONAL * Number(arm.tp3_price_usd)) / entry;
    pnl += proceeds - sold * NOTIONAL;
    remaining = 0;
    updates.tp3_hit = true;
    updates.remaining_pct = 0;
    updates.realized_pnl_usd = pnl;
    updates.realized_roi = pnl / NOTIONAL;
    updates.closure_reason = "full_tp";
    updates.closed_at = new Date().toISOString();
    await recordEvent({
      armId: arm.id,
      signalId,
      eventType: "TP3",
      price: Number(arm.tp3_price_usd),
      remainingAfter: 0,
    });
    console.log(`[TP3] ${arm.arm_code} FULL EXIT`);
    arm.tp3_hit = true;
  }

  if (remaining > 0 && !arm.stop_hit && price <= Number(arm.stop_price_usd)) {
    const sold = remaining;
    const proceeds = (sold * NOTIONAL * Number(arm.stop_price_usd)) / entry;
    pnl += proceeds - sold * NOTIONAL;
    remaining = 0;
    updates.stop_hit = true;
    updates.remaining_pct = 0;
    updates.realized_pnl_usd = pnl;
    updates.realized_roi = pnl / NOTIONAL;
    updates.closure_reason = "stop";
    updates.closed_at = new Date().toISOString();
    await recordEvent({
      armId: arm.id,
      signalId,
      eventType: "STOP",
      price: Number(arm.stop_price_usd),
      remainingAfter: 0,
    });
    console.log(`[STOP] ${arm.arm_code}`);
  }

  if (Object.keys(updates).length > 0) {
    await supabase.from("treatment_arms").update(updates).eq("id", arm.id);
  }
}

async function maybeCloseSignal(signalId: string) {
  const { data: arms } = await supabase
    .from("treatment_arms")
    .select("closure_reason")
    .eq("signal_id", signalId);
  if (!arms || arms.length === 0) return;
  if (arms.every((a) => a.closure_reason)) {
    await supabase
      .from("signals")
      .update({ status: "closed", closed_at: new Date().toISOString() })
      .eq("id", signalId);
  }
}

async function expireNoFills(signal: any) {
  const openUntil =
    new Date(signal.called_at).getTime() + SIGNAL_OPEN_HOURS * 3600 * 1000;
  if (Date.now() < openUntil) return;

  const { data: arms } = await supabase
    .from("treatment_arms")
    .select("*")
    .eq("signal_id", signal.id)
    .eq("filled", false)
    .eq("no_fill", false);

  if (!arms || arms.length === 0) {
    await maybeCloseSignal(signal.id);
    return;
  }

  for (const arm of arms) {
    await supabase
      .from("treatment_arms")
      .update({
        no_fill: true,
        closure_reason: "no_fill",
        closed_at: new Date().toISOString(),
        remaining_pct: 0,
      })
      .eq("id", arm.id);

    await recordEvent({
      armId: arm.id,
      signalId: signal.id,
      eventType: "NO_FILL",
      price: 0,
      remainingAfter: 0,
      notes: `No entry within ${SIGNAL_OPEN_HOURS}h`,
    });
    console.log(`[NO_FILL] ${arm.arm_code} on ${signal.specimen_id}`);
  }
  await maybeCloseSignal(signal.id);
}

async function processOpenSignals() {
  console.log(`[${new Date().toISOString()}] Treatment engine tick…`);

  const { data: signals, error } = await supabase
    .from("signals")
    .select("*")
    .eq("status", "open")
    .not("signal_price_usd", "is", null);

  if (error || !signals || signals.length === 0) {
    console.log("No open signals.");
    return;
  }

  for (const signal of signals) {
    const metrics = await fetchTokenMetrics(signal.contract_address);
    if (!metrics) {
      console.log(`[SKIP] No price for ${signal.specimen_id}`);
      await expireNoFills(signal);
      await sleep(300);
      continue;
    }

    const price = metrics.priceUsd;
    const pathUpdates: Record<string, any> = {};
    if (signal.lowest_price_usd == null || price < Number(signal.lowest_price_usd)) {
      pathUpdates.lowest_price_usd = price;
      pathUpdates.lowest_at = new Date().toISOString();
    }
    if (signal.highest_price_usd == null || price > Number(signal.highest_price_usd)) {
      pathUpdates.highest_price_usd = price;
      pathUpdates.highest_at = new Date().toISOString();
    }
    if (Object.keys(pathUpdates).length > 0) {
      await supabase.from("signals").update(pathUpdates).eq("id", signal.id);
    }

    await supabase.from("price_ticks").insert({
      signal_id: signal.id,
      price_usd: price,
      liquidity_usd: metrics.liquidityUsd,
      source: metrics.source,
      observed_at: new Date().toISOString(),
    });

    const { data: arms } = await supabase
      .from("treatment_arms")
      .select("*")
      .eq("signal_id", signal.id);

    if (arms) {
      for (const arm of arms) {
        if (arm.closure_reason) continue;
        await evaluateArm(arm, price, signal.id);
      }
    }

    await expireNoFills(signal);
    await sleep(400);
  }
}

console.log("[TRACKER] Treatment engine started");
console.log(`[TRACKER] Poll every ${POLL_MS / 1000}s | Open window ${SIGNAL_OPEN_HOURS}h`);
setInterval(processOpenSignals, POLL_MS);
processOpenSignals();

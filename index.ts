import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import input from "input";
import { fetchTokenMetrics } from "./lib/price";
import {
  ARM_DEFINITIONS,
  experimentDay,
  specimenId,
} from "./lib/arms";

dotenv.config();

const SOLANA_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const EVM_REGEX = /0x[a-fA-F0-9]{40}/g;

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH || "";
const stringSession = new StringSession(process.env.TELEGRAM_SESSION_STRING || "");

const EXPERIMENT_START = process.env.EXPERIMENT_START_DATE || "2026-10-01";

if (!apiId || !apiHash || !process.env.TELEGRAM_SESSION_STRING) {
  console.error("[CRITICAL] Missing TELEGRAM credentials");
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("[CRITICAL] Missing SUPABASE credentials");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function isDuplicate(contractAddress: string): Promise<boolean> {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("signals")
    .select("id")
    .eq("contract_address", contractAddress)
    .gte("called_at", fiveMinAgo)
    .limit(1);
  if (error) {
    console.error("[DB]", error.message);
    return false;
  }
  return !!(data && data.length > 0);
}

async function createSpecimen(params: {
  channelName: string;
  contractAddress: string;
  rawMessage: string;
  metrics: Awaited<ReturnType<typeof fetchTokenMetrics>>;
  fetchFailed: boolean;
  fetchError?: string;
}) {
  const now = new Date();
  const short = params.contractAddress.slice(-6).toUpperCase();
  const sid = specimenId(now, short);
  const day = experimentDay(now, EXPERIMENT_START);

  const signalPrice = params.metrics?.priceUsd ?? null;
  const resolved = !params.fetchFailed && signalPrice != null && signalPrice > 0;

  const { data: signal, error: sigErr } = await supabase
    .from("signals")
    .insert({
      specimen_id: sid,
      experiment_day: day > 0 ? day : null,
      called_at: now.toISOString(),
      channel_name: params.channelName,
      caller: null,
      token_symbol: resolved ? params.metrics!.symbol : "UNKNOWN",
      contract_address: params.contractAddress,
      network: resolved ? params.metrics!.chainId : "unknown",
      signal_price_usd: signalPrice,
      signal_fdv: resolved ? params.metrics!.marketCap : null,
      signal_liquidity: resolved ? params.metrics!.liquidityUsd : null,
      pair_url: resolved ? params.metrics!.pairUrl : null,
      raw_message: params.rawMessage.substring(0, 1000),
      fetch_status: resolved ? "success" : "failed",
      fetch_source: resolved ? params.metrics!.source : null,
      fetch_error: resolved
        ? null
        : params.fetchError || "Unable to resolve price",
      lowest_price_usd: signalPrice,
      highest_price_usd: signalPrice,
      lowest_at: signalPrice ? now.toISOString() : null,
      highest_at: signalPrice ? now.toISOString() : null,
      status: "open",
    })
    .select("id, specimen_id, signal_price_usd")
    .single();

  if (sigErr || !signal) {
    console.error("[DB signal insert]", sigErr?.message);
    return;
  }

  if (resolved && signal.signal_price_usd) {
    const p0 = Number(signal.signal_price_usd);
    const armRows = ARM_DEFINITIONS.map((def) => {
      const entryTarget = p0 * (1 - def.discount_pct / 100);
      return {
        signal_id: signal.id,
        arm_code: def.arm_code,
        discount_pct: def.discount_pct,
        entry_target_usd: entryTarget,
        filled: false,
        no_fill: false,
        remaining_pct: 1.0,
        tp1_hit: false,
        tp2_hit: false,
        tp3_hit: false,
        stop_hit: false,
        realized_pnl_usd: 0,
        realized_roi: 0,
      };
    });

    const { error: armErr } = await supabase
      .from("treatment_arms")
      .insert(armRows);

    if (armErr) {
      console.error("[DB arms insert]", armErr.message);
    } else {
      console.log(
        `[SPECIMEN] ${signal.specimen_id} | \[ {params.metrics!.symbol} @ \]{p0} | Day ${day} | 8 arms created`
      );
    }
  } else {
    console.log(
      `[SPECIMEN] ${signal.specimen_id} | price unresolved — logged without arms`
    );
  }
}

async function processMessage(event: NewMessageEvent) {
  try {
    const messageTextRaw = event.message.message || "";
    // Collapse whitespace so addresses split across lines still match
    const messageText = messageTextRaw.replace(/\s+/g, "");
    const displayText = messageTextRaw;

    let channelTitle = "Unknown";
    try {
      const chat = await event.message.getChat();
      channelTitle =
        (chat as Api.Channel)?.title || (chat as any)?.title || "Unknown";
    } catch (e: any) {
      console.warn("[CHAT] could not resolve chat:", e?.message || e);
    }

    const titleLower = channelTitle.toLowerCase();
    const isApex =
      titleLower.includes("apex") && titleLower.includes("gamble");

    if (isApex) {
      console.log(
        `[MSG] "\( {channelTitle}" textLen= \){displayText.length} normalizedLen=${messageText.length}`
      );
      if (displayText.length > 0 && displayText.length < 220) {
        console.log(`[MSG BODY] ${displayText.slice(0, 200)}`);
      }
    }

    if (!isApex) return;

    if (!messageText) {
      console.log(`[MSG] empty text — skip`);
      return;
    }

    const solana = messageText.match(SOLANA_REGEX) || [];
    const evm = messageText.match(EVM_REGEX) || [];
    const addresses = Array.from(new Set([...solana, ...evm]));

    if (addresses.length === 0) {
      console.log(`[MSG] no contract address found`);
      return;
    }

    console.log(`[MSG] addresses: ${addresses.join(", ")}`);

    for (const address of addresses) {
      if (await isDuplicate(address)) {
        console.log(`[DUPLICATE] ${address}`);
        continue;
      }

      console.log(`\n[APEX GAMBLES CALL] ${address}`);
      const metrics = await fetchTokenMetrics(address);
      const fetchFailed =
        !metrics || metrics.priceUsd == null || metrics.priceUsd <= 0;

      await createSpecimen({
        channelName: channelTitle,
        contractAddress: address,
        rawMessage: displayText,
        metrics,
        fetchFailed,
        fetchError: fetchFailed
          ? "Unable to resolve price from DexScreener or GeckoTerminal"
          : undefined,
      });
    }
  } catch (err: any) {
    console.error("[processMessage]", err?.message || err);
  }
}

async function main() {
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () =>
      await input.text("Enter your Telegram phone number (+...): "),
    password: async () =>
      await input.text("Enter 2FA password (if enabled): "),
    phoneCode: async () =>
      await input.text("Enter Telegram verification code: "),
    onError: (err) => console.log(err),
  });

  console.log("\n================ LOGIN SUCCESSFUL ================");
  console.log("[BOT ACTIVE] Monitoring Apex Gambles → experiment pipeline\n");
  console.log(`[CONFIG] Experiment Day 1 start: ${EXPERIMENT_START} (UTC)`);

  client.addEventHandler(processMessage, new NewMessage({}));
}

main().catch(console.error);

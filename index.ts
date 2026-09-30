import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import dotenv from "dotenv";
import input from "input";

dotenv.config();

const SOLANA_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const EVM_REGEX = /0x[a-fA-F0-9]{40}/g;

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH || "";
const stringSession = new StringSession(process.env.TELEGRAM_SESSION_STRING || "");

if (!apiId || !apiHash || !process.env.TELEGRAM_SESSION_STRING) {
  console.error("[CRITICAL] Missing TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION_STRING");
  process.exit(1);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("[CRITICAL] Missing SUPABASE_URL / SUPABASE_KEY");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

interface TokenMetrics {
  symbol: string;
  priceUsd: number;
  liquidityUsd: number | null;
  marketCap: number | null;
  chainId: string;
  pairUrl: string | null;
  source: "DexScreener" | "GeckoTerminal";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectNetwork(address: string): string {
  if (address.startsWith("0x")) return "eth";
  return "solana";
}

async function fetchTokenMetrics(tokenAddress: string): Promise<TokenMetrics | null> {
  const dsUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(dsUrl, { timeout: 7000 });
      const pairs = res.data?.pairs || [];

      if (pairs.length > 0) {
        pairs.sort(
          (a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
        );
        const pair = pairs[0];
        const price = pair.priceUsd ? parseFloat(pair.priceUsd) : NaN;

        if (!isNaN(price) && price > 0) {
          return {
            symbol: pair.baseToken?.symbol || "UNKNOWN",
            priceUsd: price,
            liquidityUsd: pair.liquidity?.usd ?? null,
            marketCap: pair.fdv ?? pair.marketCap ?? null,
            chainId: pair.chainId || "unknown",
            pairUrl: pair.url || null,
            source: "DexScreener",
          };
        }
      }
      break;
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 429 && attempt < 3) {
        const delay = attempt * 2500;
        console.warn(
          `[DexScreener 429] ${tokenAddress} – retry ${attempt}/3 in ${delay / 1000}s`
        );
        await sleep(delay);
        continue;
      }
      console.warn(
        `[DexScreener Failed] ${tokenAddress}: ${err.message}. Trying GeckoTerminal…`
      );
      break;
    }
  }

  try {
    const network = detectNetwork(tokenAddress);
    const gtUrl = `https://api.geckoterminal.com/api/v2/networks/\( {network}/tokens/ \){tokenAddress}`;
    const gtRes = await axios.get(gtUrl, {
      timeout: 7000,
      headers: { Accept: "application/json;version=20230203" },
    });

    const attr = gtRes.data?.data?.attributes;
    if (attr?.price_usd) {
      const price = parseFloat(attr.price_usd);
      if (!isNaN(price) && price > 0) {
        return {
          symbol: (attr.symbol || "UNKNOWN").toUpperCase(),
          priceUsd: price,
          liquidityUsd: attr.total_reserve_in_usd
            ? parseFloat(attr.total_reserve_in_usd)
            : null,
          marketCap: attr.fdv_usd ? parseFloat(attr.fdv_usd) : null,
          chainId: network,
          pairUrl: null,
          source: "GeckoTerminal",
        };
      }
    }
  } catch (err: any) {
    console.error(`[GeckoTerminal Failed] ${tokenAddress}: ${err.message}`);
  }

  return null;
}

async function isDuplicateCall(contractAddress: string): Promise<boolean> {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("token_calls")
    .select("id")
    .eq("contract_address", contractAddress)
    .gte("created_at", fiveMinutesAgo)
    .limit(1);

  if (error) {
    console.error("[Database Error]:", error.message);
    return false;
  }

  return !!(data && data.length > 0);
}

async function processMessage(event: NewMessageEvent) {
  const chat = await event.message.getChat();
  const channelTitle = (chat as Api.Channel)?.title || "Unknown Channel";

  if (!channelTitle.toLowerCase().includes("apex gambles")) {
    return;
  }

  const messageText = event.message.message;
  if (!messageText) return;

  const solanaMatches = messageText.match(SOLANA_REGEX) || [];
  const evmMatches = messageText.match(EVM_REGEX) || [];
  const extractedAddresses = Array.from(
    new Set([...solanaMatches, ...evmMatches])
  );

  if (extractedAddresses.length === 0) return;

  for (const address of extractedAddresses) {
    const isDup = await isDuplicateCall(address);
    if (isDup) {
      console.log(`[DUPLICATE IGNORED] ${address}`);
      continue;
    }

    console.log(`\n[APEX GAMBLES CALL] ${address}`);

    const metrics = await fetchTokenMetrics(address);

    const resolved =
      metrics && metrics.priceUsd != null && metrics.priceUsd > 0;

    const callPayload = {
      channel_name: channelTitle,
      contract_address: address,
      chain_id: resolved ? metrics!.chainId : "unknown",
      symbol: resolved ? metrics!.symbol : "UNKNOWN",
      entry_price_usd: resolved ? metrics!.priceUsd : null,
      entry_fdv: resolved ? metrics!.marketCap : null,
      entry_liquidity: resolved ? metrics!.liquidityUsd : null,
      pair_url: resolved ? metrics!.pairUrl : null,
      raw_message: messageText.substring(0, 1000),
      fetch_status: resolved ? "success" : "failed",
      fetch_source: resolved ? metrics!.source : null,
      fetch_error: resolved
        ? null
        : "Unable to resolve price from DexScreener or GeckoTerminal",
    };

    const { error } = await supabase.from("token_calls").insert(callPayload);

    if (error) {
      console.error("[Database Insert Error]:", error.message);
    } else if (resolved) {
      console.log(
        `[LOGGED via ${metrics!.source}] \[ {metrics!.symbol} | Price: \]{metrics!.priceUsd} | Liq: \[ {metrics!.liquidityUsd} | MC: \]{metrics!.marketCap}`
      );
    } else {
      console.log(
        `[LOGGED AS FAILED] ${address} – price unresolved (still tracked)`
      );
    }
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
  console.log("[BOT ACTIVE] Monitoring Apex Gambles in real-time...\n");

  client.addEventHandler(processMessage, new NewMessage({}));
}

main().catch(console.error);

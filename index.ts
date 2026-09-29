import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import dotenv from "dotenv";
import input from "input";

dotenv.config();

// Contract Address Patterns (Solana & EVM)
const SOLANA_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const EVM_REGEX = /0x[a-fA-F0-9]{40}/g;

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH || "";
const stringSession = new StringSession(process.env.TELEGRAM_SESSION_STRING || "");

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || ""
);

interface DexScreenerPair {
  chainId: string;
  priceUsd: string;
  fdv: number;
  liquidity?: { usd: number };
  baseToken: { symbol: string };
  url: string;
}

// Fetch live price & liquidity data from DexScreener
async function fetchDexData(contractAddress: string): Promise<DexScreenerPair | null> {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`;
    const response = await axios.get(url, { timeout: 5000 });
    const pairs: DexScreenerPair[] = response.data?.pairs || [];

    if (!pairs.length) return null;

    // Sort pairs by highest liquidity
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return pairs[0];
  } catch (error) {
    console.error(`[DexScreener API Error] ${contractAddress}:`, (error as Error).message);
    return null;
  }
}

// Prevent logging the same contract address if called within 5 minutes
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

  return data && data.length > 0;
}

// Handle incoming messages exclusively from target channels
async function processMessage(event: NewMessageEvent) {
  const chat = await event.message.getChat();
  const channelTitle = (chat as Api.Channel)?.title || "Unknown Channel";

  // Filter: Only allow messages from "Apex Gambles"
  if (!channelTitle.toLowerCase().includes("apex gambles")) {
    return;
  }

  const messageText = event.message.message;
  if (!messageText) return;

  const solanaMatches = messageText.match(SOLANA_REGEX) || [];
  const evmMatches = messageText.match(EVM_REGEX) || [];
  const extractedAddresses = Array.from(new Set([...solanaMatches, ...evmMatches]));

  if (extractedAddresses.length === 0) return;

  for (const address of extractedAddresses) {
    const isDup = await isDuplicateCall(address);
    if (isDup) {
      console.log(`[DUPLICATE IGNORED] Address ${address} was already logged recently.`);
      continue;
    }

    console.log(`\n[APEX GAMBLES CALL DETECTED] Token: ${address}`);

    const dexData = await fetchDexData(address);

    const callPayload = {
      channel_name: channelTitle,
      contract_address: address,
      chain_id: dexData?.chainId || "unknown",
      symbol: dexData?.baseToken?.symbol || "UNKNOWN",
      entry_price_usd: dexData?.priceUsd ? parseFloat(dexData.priceUsd) : null,
      entry_fdv: dexData?.fdv || null,
      entry_liquidity: dexData?.liquidity?.usd || null,
      pair_url: dexData?.url || null,
      raw_message: messageText.substring(0, 1000)
    };

    const { error } = await supabase.from("token_calls").insert(callPayload);

    if (error) {
      console.error("[Database Insert Error]:", error.message);
    } else {
      console.log(`[SUCCESSFULLY LOGGED TO SUPABASE]`);
      console.log(`Symbol: $${callPayload.symbol} | Price: $${callPayload.entry_price_usd} | Liquidity: $${callPayload.entry_liquidity}\n`);
    }
  }
}

async function main() {
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("Enter your Telegram phone number (+...): "),
    password: async () => await input.text("Enter 2FA password (if enabled): "),
    phoneCode: async () => await input.text("Enter Telegram verification code: "),
    onError: (err) => console.log(err),
  });

  console.log("\n================ LOGIN SUCCESSFUL ================");
  console.log("[BOT ACTIVE] Monitoring Apex Gambles in real-time...\n");

  client.addEventHandler(processMessage, new NewMessage({}));
}

main().catch(console.error);


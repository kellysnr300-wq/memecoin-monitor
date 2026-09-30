import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || ""
);

interface TokenMetrics {
  priceUsd: number;
  marketCap: number | null;
  liquidityUsd: number | null;
  source: "DexScreener" | "GeckoTerminal";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectNetwork(address: string): string {
  if (address.startsWith("0x")) return "eth";
  return "solana";
}

async function fetchCurrentPrice(
  contractAddress: string
): Promise<TokenMetrics | null> {
  const dsUrl = `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`;

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
            priceUsd: price,
            marketCap: pair.fdv ?? pair.marketCap ?? null,
            liquidityUsd: pair.liquidity?.usd ?? null,
            source: "DexScreener",
          };
        }
      }
      break;
    } catch (err: any) {
      if (err.response?.status === 429 && attempt < 3) {
        await sleep(attempt * 2500);
        continue;
      }
      break;
    }
  }

  try {
    const network = detectNetwork(contractAddress);
    const gtUrl = `https://api.geckoterminal.com/api/v2/networks/\( {network}/tokens/ \){contractAddress}`;
    const gtRes = await axios.get(gtUrl, {
      timeout: 7000,
      headers: { Accept: "application/json;version=20230203" },
    });
    const attr = gtRes.data?.data?.attributes;
    if (attr?.price_usd) {
      const price = parseFloat(attr.price_usd);
      if (!isNaN(price) && price > 0) {
        return {
          priceUsd: price,
          marketCap: attr.fdv_usd ? parseFloat(attr.fdv_usd) : null,
          liquidityUsd: attr.total_reserve_in_usd
            ? parseFloat(attr.total_reserve_in_usd)
            : null,
          source: "GeckoTerminal",
        };
      }
    }
  } catch {
    // silent
  }

  return null;
}

async function trackPerformance() {
  console.log(
    `[${new Date().toISOString()}] Checking active calls for performance updates…`
  );

  const twentyFourHoursAgo = new Date(
    Date.now() - 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: activeCalls, error } = await supabase
    .from("token_calls")
    .select("id, contract_address, entry_price_usd, created_at")
    .gte("created_at", twentyFourHoursAgo)
    .not("entry_price_usd", "is", null);

  if (error || !activeCalls || activeCalls.length === 0) {
    console.log("No active calls found to update.");
    return;
  }

  for (const call of activeCalls) {
    if (!call.entry_price_usd) continue;

    const createdAt = new Date(call.created_at).getTime();
    const elapsedMinutes = Math.floor(
      (Date.now() - createdAt) / (1000 * 60)
    );

    const currentData = await fetchCurrentPrice(call.contract_address);
    if (!currentData) {
      console.log(`[TRACKER SKIP] No price for ${call.contract_address}`);
      continue;
    }

    const multiplier = parseFloat(
      (currentData.priceUsd / call.entry_price_usd).toFixed(2)
    );

    const { error: insertError } = await supabase
      .from("price_snapshots")
      .insert({
        call_id: call.id,
        elapsed_minutes: elapsedMinutes,
        current_price_usd: currentData.priceUsd,
        current_fdv: currentData.marketCap,
        multiplier,
      });

    if (!insertError) {
      console.log(
        `[TRACKER SUCCESS] Call ${call.id} | ${elapsedMinutes}m | ${multiplier}x (via ${currentData.source})`
      );
    } else {
      console.error(`[TRACKER DB ERROR] ${insertError.message}`);
    }

    await sleep(400);
  }
}

setInterval(trackPerformance, 5 * 60 * 1000);
trackPerformance();

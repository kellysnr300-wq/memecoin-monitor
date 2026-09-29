import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || ""
);

interface DexScreenerPair {
  priceUsd: string;
  fdv: number;
  liquidity?: { usd: number };
}

async function fetchCurrentPrice(contractAddress: string): Promise<DexScreenerPair | null> {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`;
    const response = await axios.get(url, { timeout: 5000 });
    const pairs: DexScreenerPair[] = response.data?.pairs || [];
    if (!pairs.length) return null;

    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return pairs[0];
  } catch (error) {
    return null;
  }
}

async function trackPerformance() {
  console.log(`[${new Date().toISOString()}] Checking active calls for performance updates...`);

  // Fetch calls logged in the last 24 hours
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: activeCalls, error } = await supabase
    .from("token_calls")
    .select("id, contract_address, entry_price_usd, created_at")
    .gte("created_at", twentyFourHoursAgo);

  if (error || !activeCalls || activeCalls.length === 0) {
    console.log("No active calls found to update.");
    return;
  }

  for (const call of activeCalls) {
    if (!call.entry_price_usd) continue;

    const createdAt = new Date(call.created_at).getTime();
    const elapsedMinutes = Math.floor((Date.now() - createdAt) / (1000 * 60));

    // Fetch current price
    const currentData = await fetchCurrentPrice(call.contract_address);
    if (!currentData || !currentData.priceUsd) continue;

    const currentPrice = parseFloat(currentData.priceUsd);
    const multiplier = parseFloat((currentPrice / call.entry_price_usd).toFixed(2));

    // Insert performance snapshot into database
    const { error: insertError } = await supabase.from("price_snapshots").insert({
      call_id: call.id,
      elapsed_minutes: elapsedMinutes,
      current_price_usd: currentPrice,
      current_fdv: currentData.fdv || null,
      multiplier: multiplier
    });

    if (!insertError) {
      console.log(`[TRACKER SUCCESS] Call ID: ${call.id} | Elapsed: ${elapsedMinutes}m | Multiplier: ${multiplier}x`);
    }
  }
}

// Run every 5 minutes
setInterval(trackPerformance, 5 * 60 * 1000);
trackPerformance();


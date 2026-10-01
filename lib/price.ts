import axios from "axios";

export interface TokenMetrics {
  symbol: string;
  priceUsd: number;
  liquidityUsd: number | null;
  marketCap: number | null;
  chainId: string;
  pairUrl: string | null;
  source: "DexScreener" | "GeckoTerminal";
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function detectNetwork(address: string): string {
  if (address.startsWith("0x")) return "eth";
  return "solana";
}

export async function fetchTokenMetrics(
  tokenAddress: string
): Promise<TokenMetrics | null> {
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
      if (err.response?.status === 429 && attempt < 3) {
        await sleep(attempt * 2500);
        continue;
      }
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
  } catch {
    // silent
  }

  return null;
}

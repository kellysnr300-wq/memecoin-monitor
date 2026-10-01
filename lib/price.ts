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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectNetwork(address: string): string {
  if (address.startsWith("0x")) return "eth";
  return "solana";
}

export async function fetchTokenMetrics(
  tokenAddress: string
): Promise<TokenMetrics | null> {
  const dsUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;

  // Primary source: DexScreener
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(dsUrl, {
        timeout: 7000,
        headers: {
          Accept: "application/json",
        },
      });

      const pairs = Array.isArray(res.data?.pairs) ? res.data.pairs : [];

      if (pairs.length > 0) {
        // Use the pair with the greatest liquidity.
        pairs.sort(
          (a: any, b: any) =>
            Number(b?.liquidity?.usd || 0) -
            Number(a?.liquidity?.usd || 0)
        );

        const pair = pairs[0];
        const price = pair?.priceUsd
          ? Number.parseFloat(pair.priceUsd)
          : NaN;

        if (Number.isFinite(price) && price > 0) {
          console.log(
            `[PRICE] DexScreener ${tokenAddress} -> $${price}`
          );

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

        console.warn(
          `[PRICE] DexScreener returned pairs but no valid price for ${tokenAddress}`
        );
      } else {
        console.warn(
          `[PRICE] DexScreener returned no pairs for ${tokenAddress}`
        );
      }

      break;
    } catch (err: any) {
      const status = err?.response?.status;
      const message = err?.message || String(err);

      console.error(
        `[PRICE] DexScreener attempt ${attempt}/3 failed for ${tokenAddress}: ${status || "NO_STATUS"} ${message}`
      );

      if (status === 429 && attempt < 3) {
        await sleep(attempt * 2500);
        continue;
      }

      break;
    }
  }

  // Fallback source: GeckoTerminal
  try {
    const network = detectNetwork(tokenAddress);
    const gtUrl = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${tokenAddress}`;

    const gtRes = await axios.get(gtUrl, {
      timeout: 7000,
      headers: {
        Accept: "application/json;version=20230203",
      },
    });

    const attr = gtRes.data?.data?.attributes;

    if (attr?.price_usd) {
      const price = Number.parseFloat(attr.price_usd);

      if (Number.isFinite(price) && price > 0) {
        console.log(
          `[PRICE] GeckoTerminal ${tokenAddress} -> $${price}`
        );

        return {
          symbol: (attr.symbol || "UNKNOWN").toUpperCase(),
          priceUsd: price,
          liquidityUsd: attr.total_reserve_in_usd
            ? Number.parseFloat(attr.total_reserve_in_usd)
            : null,
          marketCap: attr.fdv_usd
            ? Number.parseFloat(attr.fdv_usd)
            : null,
          chainId: network,
          pairUrl: null,
          source: "GeckoTerminal",
        };
      }
    }

    console.warn(
      `[PRICE] GeckoTerminal returned no valid price for ${tokenAddress}`
    );
  } catch (err: any) {
    const status = err?.response?.status;
    const message = err?.message || String(err);

    console.error(
      `[PRICE] GeckoTerminal failed for ${tokenAddress}: ${status || "NO_STATUS"} ${message}`
    );
  }

  console.error(
    `[PRICE] ALL SOURCES FAILED for ${tokenAddress}`
  );

  return null;
}

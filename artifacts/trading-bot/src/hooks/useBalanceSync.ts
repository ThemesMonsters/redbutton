/**
 * Balance Sync via Browser Relay
 *
 * Bybit REST is geo-blocked on Replit/AWS IPs, so the private WS is used for
 * balance updates. But the WS only pushes when something changes — on a stable
 * set of open positions the cache goes null. This hook fills the gap by:
 *   1. Asking the server for a signed GET request for wallet balance
 *   2. Executing that request directly from the browser (not geo-blocked)
 *   3. Posting the result back to the server so it can update its wallet cache
 *
 * Runs once on mount, then every 60 s.
 */

import { useEffect } from "react";

const INTERVAL_MS = 60_000;
const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

async function syncBalance() {
  try {
    // Step 1: get signed request from server
    const reqRes = await fetch(`${BASE}/api/balance/sync-request`);
    if (!reqRes.ok) return;
    const { url, headers } = await reqRes.json() as { url: string; headers: Record<string, string> };

    // Step 2: execute from browser (not geo-blocked)
    const bybitRes = await fetch(url, { headers });
    if (!bybitRes.ok) return;
    const data = await bybitRes.json();
    if (data.retCode !== 0) return;

    const account = data.result?.list?.[0];
    if (!account) return;
    const balance = parseFloat(account.totalWalletBalance ?? "0");
    const equity = parseFloat(account.totalEquity ?? account.totalWalletBalance ?? "0");
    if (isNaN(balance) || balance <= 0) return;

    // Step 3: post result back to server to update its wallet cache
    await fetch(`${BASE}/api/balance/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ balance, equity }),
    });
  } catch {
    // network error — silently ignore, will retry next interval
  }
}

export function useBalanceSync() {
  useEffect(() => {
    syncBalance();
    const id = setInterval(syncBalance, INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
}

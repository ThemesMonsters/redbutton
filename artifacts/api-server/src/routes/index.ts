import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { botConfigTable } from "@workspace/db";
import { hasApiKeys } from "../lib/bybit-client";
import { getPrivateBalance, setWalletCache } from "../lib/private-feed";
import healthRouter from "./health";
import botRouter from "./bot";
import positionsRouter from "./positions";
import tradesRouter from "./trades";
import marketRouter from "./market";
import signalsRouter from "./signals";
import analyticsRouter from "./analytics";
import settingsRouter from "./settings";
import liveOrdersRouter from "./live-orders";
import strategyPresetsRouter from "./strategy-presets";

const router: IRouter = Router();

// Browser-relay: returns a signed GET request for wallet balance that the browser can execute
router.get("/balance/sync-request", async (req, res) => {
  try {
    const configs = await db
      .select({ bybitApiKey: botConfigTable.bybitApiKey, bybitApiSecret: botConfigTable.bybitApiSecret })
      .from(botConfigTable).limit(1);
    const key = process.env.BYBIT_API_KEY || configs[0]?.bybitApiKey || null;
    const secret = process.env.BYBIT_API_SECRET || configs[0]?.bybitApiSecret || null;
    if (!key || !secret) { res.status(400).json({ error: "No API keys configured" }); return; }
    const crypto = await import("node:crypto");
    const ts = String(Date.now());
    const recvWindow = "20000";
    const qs = "accountType=UNIFIED";
    const sig = crypto.createHmac("sha256", secret).update(ts + key + recvWindow + qs).digest("hex");
    res.json({
      url: "https://api.bybit.com/v5/account/wallet-balance?accountType=UNIFIED",
      headers: {
        "X-BAPI-API-KEY": key,
        "X-BAPI-SIGN": sig,
        "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-RECV-WINDOW": recvWindow,
      },
    });
  } catch (err) {
    (req as any).log.error({ err }, "Failed to build balance sync request");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Browser-relay: browser posts back the Bybit wallet response so server can update its cache
router.post("/balance/sync", async (req, res) => {
  try {
    const { balance, equity } = req.body as { balance?: number; equity?: number };
    const b = Number(balance);
    const e = Number(equity ?? balance);
    if (isNaN(b) || b < 0) { res.status(400).json({ error: "Invalid balance" }); return; }
    setWalletCache(b, e);
    res.json({ ok: true, balance: b, equity: e });
  } catch (err) {
    (req as any).log.error({ err }, "Failed to sync wallet cache");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Balance endpoint lives at /api/balance (matches OpenAPI spec + generated hooks)
router.get("/balance", async (req, res) => {
  try {
    const configs = await db.select().from(botConfigTable).limit(1);
    const config = configs[0];
    const paperBalance = config ? parseFloat(String(config.paperBalance)) : 10000;
    const liveInitialBalance = config ? parseFloat(String(config.liveInitialBalance ?? "0")) : 0;
    // Private WS feed (not REST — Bybit REST is geo-blocked on Replit/AWS IPs)
    const live = hasApiKeys() ? getPrivateBalance() : null;
    res.json({
      paperBalance,
      liveInitialBalance,
      liveBalance: live?.balance ?? null,
      liveEquity: live?.equity ?? null,
      currency: "USDT",
      hasApiKeys: hasApiKeys(),
    });
  } catch (err) {
    (req as any).log.error({ err }, "Failed to get balance");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.use(healthRouter);
router.use("/bot", botRouter);
router.use("/positions", positionsRouter);
router.use("/trades", tradesRouter);
router.use("/market", marketRouter);
router.use("/signals", signalsRouter);
router.use("/analytics", analyticsRouter);
router.use("/settings", settingsRouter);
router.use("/live-orders", liveOrdersRouter);
router.use("/strategy-presets", strategyPresetsRouter);

export default router;

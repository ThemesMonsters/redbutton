import { Router } from "express";
import { db } from "@workspace/db";
import { botConfigTable, positionsTable, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { setApiKeys } from "../lib/bybit-client";
import { setRelayKeys } from "../lib/live-order-relay";
import { initPrivateFeed, closePrivateFeed } from "../lib/private-feed";
import { initWSApiClient, closeWSApiClient } from "../lib/bybit-ws-api";

const router = Router();

router.delete("/trades", async (req, res) => {
  try {
    const result = await db.delete(tradesTable).returning({ id: tradesTable.id });
    res.json({ deleted: result.length, message: `Deleted ${result.length} trade records` });
  } catch (err) {
    req.log.error({ err }, "Failed to reset trade history");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/positions", async (req, res) => {
  try {
    const result = await db
      .update(positionsTable)
      .set({ isOpen: false, closedAt: new Date() })
      .where(eq(positionsTable.isOpen, true))
      .returning({ id: positionsTable.id });
    res.json({ closed: result.length, message: `Closed ${result.length} open positions` });
  } catch (err) {
    req.log.error({ err }, "Failed to close all positions");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/all", async (req, res) => {
  try {
    const [closedResult, deletedResult] = await Promise.all([
      db.update(positionsTable)
        .set({ isOpen: false, closedAt: new Date() })
        .where(eq(positionsTable.isOpen, true))
        .returning({ id: positionsTable.id }),
      db.delete(tradesTable).returning({ id: tradesTable.id }),
    ]);
    res.json({
      closedPositions: closedResult.length,
      deletedTrades: deletedResult.length,
      message: `Closed ${closedResult.length} positions and deleted ${deletedResult.length} trades`,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to reset all data");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/reset-balance", async (req, res) => {
  try {
    const configs = await db.select().from(botConfigTable).limit(1);
    if (configs.length === 0) {
      res.status(404).json({ error: "No config found" });
      return;
    }
    await db
      .update(botConfigTable)
      .set({ paperBalance: "10000" })
      .where(eq(botConfigTable.id, configs[0].id));
    res.json({ paperBalance: 10000, message: "Paper balance reset to $10,000" });
  } catch (err) {
    req.log.error({ err }, "Failed to reset paper balance");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/live-balance", async (req, res) => {
  try {
    const { balance } = req.body as { balance?: number };
    const val = Number(balance);
    if (isNaN(val) || val < 0) {
      res.status(400).json({ error: "Invalid balance value" });
      return;
    }
    const configs = await db.select().from(botConfigTable).limit(1);
    if (configs.length === 0) { res.status(404).json({ error: "No config found" }); return; }
    await db.update(botConfigTable)
      .set({ liveInitialBalance: String(val) })
      .where(eq(botConfigTable.id, configs[0].id));
    res.json({ liveInitialBalance: val, message: `Live initial balance set to $${val}` });
  } catch (err) {
    req.log.error({ err }, "Failed to save live initial balance");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/live-balance", async (req, res) => {
  try {
    const configs = await db.select({ liveInitialBalance: botConfigTable.liveInitialBalance }).from(botConfigTable).limit(1);
    const val = configs[0]?.liveInitialBalance ?? "0";
    res.json({ liveInitialBalance: parseFloat(String(val)) });
  } catch (err) {
    req.log.error({ err }, "Failed to get live initial balance");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/stats", async (req, res) => {
  try {
    const [openPositions, allTrades] = await Promise.all([
      db.select({ id: positionsTable.id }).from(positionsTable).where(eq(positionsTable.isOpen, true)),
      db.select({ id: tradesTable.id }).from(tradesTable),
    ]);
    res.json({
      openPositions: openPositions.length,
      tradeHistory: allTrades.length,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get stats");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/api-keys/diagnose-request", async (req, res) => {
  try {
    const configs = await db
      .select({ bybitApiKey: botConfigTable.bybitApiKey, bybitApiSecret: botConfigTable.bybitApiSecret })
      .from(botConfigTable)
      .limit(1);
    const key = process.env.BYBIT_API_KEY || configs[0]?.bybitApiKey || null;
    const secret = process.env.BYBIT_API_SECRET || configs[0]?.bybitApiSecret || null;
    if (!key || !secret) {
      res.status(400).json({ error: "No API keys configured" });
      return;
    }

    const crypto = await import("node:crypto");
    const ts = String(Date.now());
    const recvWindow = "20000";
    function makeSignedRequest(qs: string, url: string) {
      const t = String(Date.now());
      const val = t + key + recvWindow + qs;
      const sig = crypto.createHmac("sha256", secret!).update(val).digest("hex");
      return {
        url,
        method: "GET",
        headers: {
          "X-BAPI-API-KEY": key,
          "X-BAPI-SIGN": sig,
          "X-BAPI-TIMESTAMP": t,
          "X-BAPI-RECV-WINDOW": recvWindow,
        },
      };
    }

    res.json({
      walletRequest: makeSignedRequest(
        "accountType=UNIFIED",
        "https://api.bybit.com/v5/account/wallet-balance?accountType=UNIFIED",
      ),
      accountInfoRequest: makeSignedRequest(
        "",
        "https://api.bybit.com/v5/account/info",
      ),
      queryApiRequest: makeSignedRequest(
        "",
        "https://api.bybit.com/v5/user/query-api",
      ),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to build diagnose request");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/api-keys/status", async (req, res) => {
  try {
    const configs = await db
      .select({ bybitApiKey: botConfigTable.bybitApiKey })
      .from(botConfigTable)
      .limit(1);
    const hasEnvKeys = !!(process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET);
    const hasDbKeys = !!(configs[0]?.bybitApiKey);
    res.json({
      configured: hasEnvKeys || hasDbKeys,
      source: hasEnvKeys ? "env" : hasDbKeys ? "database" : "none",
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get API key status");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/api-keys", async (req, res) => {
  try {
    const { apiKey, apiSecret } = req.body as { apiKey?: string; apiSecret?: string };
    const key = apiKey?.trim() || null;
    const secret = apiSecret?.trim() || null;

    const configs = await db.select().from(botConfigTable).limit(1);
    if (configs.length === 0) {
      res.status(404).json({ error: "No config found" });
      return;
    }
    await db
      .update(botConfigTable)
      .set({ bybitApiKey: key, bybitApiSecret: secret })
      .where(eq(botConfigTable.id, configs[0].id));

    setApiKeys(key, secret);
    setRelayKeys(key, secret);
    if (key && secret) {
      closePrivateFeed();
      closeWSApiClient();
      initPrivateFeed(key, secret);
      initWSApiClient(key, secret);
    }

    res.json({
      configured: !!(key && secret),
      source: "database",
      message: key && secret ? "API keys saved and active" : "API keys cleared",
    });
  } catch (err) {
    req.log.error({ err }, "Failed to save API keys");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/api-keys", async (req, res) => {
  try {
    const configs = await db.select().from(botConfigTable).limit(1);
    if (configs.length === 0) {
      res.status(404).json({ error: "No config found" });
      return;
    }
    await db
      .update(botConfigTable)
      .set({ bybitApiKey: null, bybitApiSecret: null })
      .where(eq(botConfigTable.id, configs[0].id));
    setApiKeys(null, null);
    setRelayKeys(null, null);
    closePrivateFeed();
    closeWSApiClient();
    res.json({ configured: false, source: "none", message: "API keys removed" });
  } catch (err) {
    req.log.error({ err }, "Failed to delete API keys");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

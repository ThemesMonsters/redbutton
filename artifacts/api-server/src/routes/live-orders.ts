import { Router } from "express";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { liveOrderQueueTable } from "@workspace/db";
import { eq, and, lt } from "drizzle-orm";
import { logger } from "../lib/logger";

function freshSign(signInput: string, key: string, secret: string, recvWindow: string) {
  const ts = String(Date.now());
  const val = ts + key + recvWindow + signInput;
  const sig = crypto.createHmac("sha256", secret).update(val).digest("hex");
  return { ts, sig };
}

const router = Router();

router.get("/pending", async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 65_000);
    await db
      .update(liveOrderQueueTable)
      .set({ status: "failed", errorMessage: "Timed out — browser did not execute within 65 s" })
      .where(
        and(
          eq(liveOrderQueueTable.status, "pending"),
          lt(liveOrderQueueTable.createdAt, cutoff),
        ),
      );

    const rows = await db
      .select()
      .from(liveOrderQueueTable)
      .where(eq(liveOrderQueueTable.status, "pending"))
      .limit(10);

    const { getRelayKeys } = await import("../lib/live-order-relay.js");
    const { key: relayKey, secret: relaySecret } = getRelayKeys();

    res.json({
      orders: rows.map(o => {
        const apiKey    = o.apiKey ?? relayKey ?? "";
        const apiSecret = relaySecret ?? "";
        const rw        = o.recvWindow ?? "30000";
        const method    = o.method ?? "POST";
        // Re-sign with a fresh timestamp right before sending to the browser.
        // The original signature may be >30 s old (Bybit rejects stale timestamps).
        const { ts, sig } = (apiKey && apiSecret)
          ? freshSign(o.body ?? "", apiKey, apiSecret, rw)
          : { ts: o.ts ?? "", sig: o.sign ?? "" };
        return {
          id: o.id,
          requestId: o.requestId,
          method,
          url: o.url,
          body: o.body,
          headers: {
            "X-BAPI-API-KEY":      apiKey,
            "X-BAPI-SIGN":         sig,
            "X-BAPI-TIMESTAMP":    ts,
            "X-BAPI-RECV-WINDOW":  rw,
            "Content-Type":        "application/json",
          },
        };
      }),
    });
  } catch (err) {
    req.log.error({ err }, "live-orders: failed to get pending");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id/result", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { bybitOrderId, error, responseBody } = req.body as {
    bybitOrderId?: string;
    error?: string;
    responseBody?: string;
  };

  try {
    await db
      .update(liveOrderQueueTable)
      .set({
        status:       error ? "failed" : "done",
        bybitOrderId: bybitOrderId ?? null,
        responseBody: responseBody ?? null,
        errorMessage: error ?? null,
      })
      .where(eq(liveOrderQueueTable.id, id));

    if (error) {
      logger.error({ id, error }, "Browser relay: request execution failed");
    } else {
      logger.info({ id, bybitOrderId }, "Browser relay: request executed successfully");
    }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "live-orders: failed to store result");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

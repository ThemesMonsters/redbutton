import { Router } from "express";
import { db } from "@workspace/db";
import { tradesTable, positionsTable, botConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { getCurrentPrice } from "../lib/market-feed";
import { hasApiKeys } from "../lib/bybit-client";
import { getPrivateBalance } from "../lib/private-feed";

const router = Router();

router.get("/pnl", async (req, res) => {
  try {
    const configs = await db.select().from(botConfigTable).limit(1);
    const config = configs[0];
    const paperBalance = config ? parseFloat(String(config.paperBalance)) : 10000;
    const mode = config?.mode || "paper";

    const trades = await db.select().from(tradesTable);
    const openPositions = await db.select().from(positionsTable).where(eq(positionsTable.isOpen, true));

    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - 7);
    const monthStart = new Date(now); monthStart.setDate(now.getDate() - 30);

    const todayTrades = trades.filter(t => t.closedAt && new Date(t.closedAt) >= todayStart);
    const weekTrades = trades.filter(t => t.closedAt && new Date(t.closedAt) >= weekStart);
    const monthTrades = trades.filter(t => t.closedAt && new Date(t.closedAt) >= monthStart);
    const paperTrades = trades.filter(t => t.mode === "paper");
    const liveTrades = trades.filter(t => t.mode === "live");

    const closedPnl = trades.reduce((s, t) => s + parseFloat(t.pnl), 0);
    const todayPnl = todayTrades.reduce((s, t) => s + parseFloat(t.pnl), 0);
    const weekPnl = weekTrades.reduce((s, t) => s + parseFloat(t.pnl), 0);
    const monthPnl = monthTrades.reduce((s, t) => s + parseFloat(t.pnl), 0);
    const paperPnl = paperTrades.reduce((s, t) => s + parseFloat(t.pnl), 0);
    const livePnl = liveTrades.reduce((s, t) => s + parseFloat(t.pnl), 0);

    let unrealizedPnl = 0;
    for (const pos of openPositions) {
      const price = getCurrentPrice(pos.symbol);
      const entry = parseFloat(pos.entryPrice);
      const qty = parseFloat(pos.quantity);
      if (price > 0) {
        unrealizedPnl += pos.side === "long" ? (price - entry) * qty : (entry - price) * qty;
      }
    }

    const totalPnl = closedPnl + unrealizedPnl;

    const liveInitialBalance = config ? parseFloat(String(config.liveInitialBalance ?? "0")) : 0;

    let currentBalance: number | null = null;
    let balanceSource: "live" | "calculated" | null = null;

    if (mode === "live" && hasApiKeys()) {
      const live = getPrivateBalance();
      if (live?.equity && live.equity > 0) {
        currentBalance = live.equity;
        balanceSource = "live";
      } else if (liveInitialBalance > 0) {
        const liveTotalPnl = liveTrades.reduce((s, t) => s + parseFloat(t.pnl), 0) + unrealizedPnl;
        currentBalance = liveInitialBalance + liveTotalPnl;
        balanceSource = "calculated";
      }
    } else {
      currentBalance = paperBalance + totalPnl;
      balanceSource = "calculated";
    }

    const winners = trades.filter(t => parseFloat(t.pnl) > 0);
    const losers = trades.filter(t => parseFloat(t.pnl) <= 0);
    const winRate = trades.length > 0 ? winners.length / trades.length : 0;
    const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + parseFloat(t.pnl), 0) / winners.length : 0;
    const avgLoss = losers.length > 0 ? Math.abs(losers.reduce((s, t) => s + parseFloat(t.pnl), 0) / losers.length) : 0;
    const totalWins = winners.reduce((s, t) => s + parseFloat(t.pnl), 0);
    const totalLoss = Math.abs(losers.reduce((s, t) => s + parseFloat(t.pnl), 0));
    const profitFactor = totalLoss > 0 ? totalWins / totalLoss : totalWins > 0 ? 99 : 0;

    let peak = paperBalance;
    let equity = paperBalance;
    let maxDrawdown = 0;
    for (const t of trades.sort((a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime())) {
      equity += parseFloat(t.pnl);
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const totalPnlPercent = (totalPnl / paperBalance) * 100;

    res.json({
      totalPnl, totalPnlPercent, unrealizedPnl, currentBalance,
      balanceSource,
      todayPnl, weekPnl, monthPnl,
      winRate, totalTrades: trades.length, winningTrades: winners.length, losingTrades: losers.length,
      avgWin, avgLoss, profitFactor, maxDrawdown, paperPnl, livePnl,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get P&L summary");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/daily", async (req, res) => {
  try {
    const { days = "30" } = req.query as { days?: string };
    const d = parseInt(days) || 30;
    const since = new Date();
    since.setDate(since.getDate() - d);
    const trades = await db.select().from(tradesTable).where(sql`${tradesTable.closedAt} >= ${since}`);

    const byDate = new Map<string, { pnl: number; trades: number; wins: number }>();
    for (const t of trades) {
      const date = new Date(t.closedAt!).toISOString().split("T")[0];
      const entry = byDate.get(date) || { pnl: 0, trades: 0, wins: 0 };
      entry.pnl += parseFloat(t.pnl);
      entry.trades += 1;
      if (parseFloat(t.pnl) > 0) entry.wins += 1;
      byDate.set(date, entry);
    }

    const result = [];
    for (let i = d; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const key = date.toISOString().split("T")[0];
      const entry = byDate.get(key) || { pnl: 0, trades: 0, wins: 0 };
      result.push({ date: key, pnl: entry.pnl, trades: entry.trades, winRate: entry.trades > 0 ? entry.wins / entry.trades : 0 });
    }
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to get daily P&L");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/strategies", async (req, res) => {
  try {
    const trades = await db.select().from(tradesTable);

    const strategyMap = new Map<string, {
      trades: number; wins: number; pnl: number; bestTrade: number; worstTrade: number;
    }>();

    for (const trade of trades) {
      const strats = (trade.strategy || "unknown").split("+").map(s => s.trim()).filter(Boolean);
      for (const s of strats) {
        const existing = strategyMap.get(s) || { trades: 0, wins: 0, pnl: 0, bestTrade: -Infinity, worstTrade: Infinity };
        const pnl = parseFloat(trade.pnl);
        existing.trades++;
        if (pnl > 0) existing.wins++;
        existing.pnl += pnl;
        if (pnl > existing.bestTrade) existing.bestTrade = pnl;
        if (pnl < existing.worstTrade) existing.worstTrade = pnl;
        strategyMap.set(s, existing);
      }
    }

    const result = Array.from(strategyMap.entries()).map(([strategy, stats]) => ({
      strategy,
      totalTrades: stats.trades,
      winningTrades: stats.wins,
      losingTrades: stats.trades - stats.wins,
      winRate: stats.trades > 0 ? stats.wins / stats.trades : 0,
      totalPnl: stats.pnl,
      avgPnl: stats.trades > 0 ? stats.pnl / stats.trades : 0,
      bestTrade: stats.bestTrade === -Infinity ? 0 : stats.bestTrade,
      worstTrade: stats.worstTrade === Infinity ? 0 : stats.worstTrade,
    }));

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to get strategy stats");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

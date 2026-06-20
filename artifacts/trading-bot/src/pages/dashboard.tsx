import { useState, useEffect, useRef } from "react";
import { useLiveOrderRelay } from "@/hooks/useLiveOrderRelay";
import { useBalanceSync } from "@/hooks/useBalanceSync";
import { Layout } from "@/components/layout";
import {
  useGetBotStatus, useGetPnlSummary, useListPositions, useListSignals,
  useStartBot, useStopBot, useSyncPositions, useGetDailyPnl,
  useListStrategyPresets, useClosePosition, useGetStrategyStats,
  getGetBotStatusQueryKey, getListPositionsQueryKey, getGetPnlSummaryQueryKey,
  getListSignalsQueryKey, getGetDailyPnlQueryKey, getListStrategyPresetsQueryKey,
  getGetStrategyStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from "@/components/ui/table";
import { TrendingUp, TrendingDown, RefreshCw, Zap, X, Wifi } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid,
} from "recharts";

function StatCard({ label, value, sub, positive, loading, highlight }: {
  label: string; value: string; sub?: string; positive?: boolean; loading?: boolean; highlight?: boolean;
}) {
  return (
    <div className={cn("bg-card border p-3 rounded-sm", highlight ? "border-chart-1/40" : "border-border/60")}>
      <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1.5">{label}</div>
      {loading ? <Skeleton className="h-6 w-20 bg-accent" /> : (
        <div className={cn("text-xl font-mono font-bold", positive === true && "text-chart-1", positive === false && "text-destructive")}>
          {value}
        </div>
      )}
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function LiveDot({ active }: { active: boolean }) {
  return (
    <span className="relative flex h-2 w-2">
      {active && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-chart-1 opacity-75" />}
      <span className={cn("relative inline-flex rounded-full h-2 w-2", active ? "bg-chart-1" : "bg-muted-foreground")} />
    </span>
  );
}

function TpProgressBar({ pos }: { pos: any }) {
  const entry = parseFloat(String(pos.entryPrice));
  const current = parseFloat(String(pos.currentPrice));
  const tp = pos.takeProfit ? parseFloat(String(pos.takeProfit)) : null;
  const sl = pos.stopLoss ? parseFloat(String(pos.stopLoss)) : null;

  if (!tp || tp === 0 || entry === 0) return null;

  let progress: number;
  if (pos.side === "long") {
    progress = tp !== entry ? ((current - entry) / (tp - entry)) * 100 : 0;
  } else {
    progress = tp !== entry ? ((entry - current) / (entry - tp)) * 100 : 0;
  }
  progress = Math.max(0, Math.min(progress, 100));

  const color = progress >= 75 ? "bg-chart-1" : progress >= 40 ? "bg-yellow-400" : "bg-muted-foreground/60";

  return (
    <div className="mt-1.5">
      <div className="flex items-center justify-between text-[9px] text-muted-foreground mb-0.5">
        <span>Progress to TP</span>
        <span className={cn("font-mono font-bold", progress >= 75 ? "text-chart-1" : progress >= 40 ? "text-yellow-400" : "")}>
          {progress.toFixed(0)}%
        </span>
      </div>
      <div className="h-1 bg-muted/40 rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${progress}%` }} />
      </div>
      <div className="flex justify-between text-[9px] text-muted-foreground mt-0.5 font-mono">
        {sl && <span className="text-destructive/70">SL ${sl.toLocaleString(undefined, { maximumFractionDigits: sl < 1 ? 4 : 2 })}</span>}
        <span className="text-chart-1/80 ml-auto">TP ${tp.toLocaleString(undefined, { maximumFractionDigits: tp < 1 ? 4 : 2 })}</span>
      </div>
    </div>
  );
}

function PositionCard({ pos, onClose, closing }: { pos: any; onClose: () => void; closing: boolean }) {
  const upnl = parseFloat(String(pos.unrealizedPnl));
  const upnlPct = parseFloat(String(pos.unrealizedPnlPercent));
  const entry = parseFloat(String(pos.entryPrice));
  const qty = parseFloat(String(pos.quantity));
  const lev = pos.leverage ?? 1;
  const marginUsdt = entry > 0 && qty > 0 ? (entry * qty) / Math.max(lev, 1) : 0;
  const notional = entry * qty;

  const fmtPrice = (v: number) => v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 1 }) :
    v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(5) : v.toFixed(6);

  return (
    <div className="bg-card border border-border/60 rounded-sm p-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <Badge className={cn("text-[9px] px-1.5 h-4 rounded-sm font-mono",
            pos.side === "long" ? "bg-chart-1/10 text-chart-1 border-chart-1/30" : "bg-destructive/10 text-destructive border-destructive/30"
          )} variant="outline">{pos.side.toUpperCase()}</Badge>
          <span className="font-mono text-sm font-bold">{pos.symbol}</span>
          <Badge variant="outline" className="text-[9px] px-1 h-4 rounded-sm font-mono text-muted-foreground">{lev}×</Badge>
          {pos.presetName && (
            <Badge variant="outline" className="text-[9px] px-1.5 h-4 rounded-sm font-mono bg-blue-500/10 text-blue-400 border-blue-500/30">
              {pos.presetName}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={cn("font-mono text-sm font-bold", upnl >= 0 ? "text-chart-1" : "text-destructive")}>
            {upnl >= 0 ? "+" : ""}${upnl.toFixed(2)}
          </span>
          <Button variant="ghost" size="sm" className="h-5 w-5 p-0 hover:bg-destructive/20 hover:text-destructive" onClick={onClose} disabled={closing}>
            <X className="w-3 h-3" />
          </Button>
        </div>
      </div>

      {/* Prices */}
      <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
        <span>Entry <span className="text-foreground">${fmtPrice(entry)}</span></span>
        <span className="text-muted-foreground/50">→</span>
        <span>Now <span className="text-foreground">${fmtPrice(parseFloat(String(pos.currentPrice)))}</span></span>
        <span className={cn("font-bold ml-auto", upnlPct >= 0 ? "text-chart-1" : "text-destructive")}>
          {upnlPct >= 0 ? "+" : ""}{upnlPct.toFixed(2)}%
        </span>
      </div>

      {/* Margin + Strategy */}
      <div className="flex items-center gap-3 mt-1 text-[9px] text-muted-foreground">
        <span>Margin <span className="text-foreground font-mono font-medium">${marginUsdt.toFixed(2)}</span></span>
        <span>Notional <span className="text-foreground font-mono">${notional.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></span>
        {pos.strategy && <span className="ml-auto font-mono">{pos.strategy.replace(/_/g, " ")}</span>}
      </div>

      {/* TP Progress bar */}
      <TpProgressBar pos={pos} />
    </div>
  );
}

function PnlChart({ data }: { data: Array<{ date: string; pnl: number }> }) {
  const cumulative = data.reduce((acc, d, i) => {
    const prev = i > 0 ? acc[i - 1].cumPnl : 0;
    acc.push({ ...d, cumPnl: prev + d.pnl });
    return acc;
  }, [] as Array<{ date: string; pnl: number; cumPnl: number }>);

  const min = Math.min(0, ...cumulative.map(d => d.cumPnl));
  const max = Math.max(0, ...cumulative.map(d => d.cumPnl));
  const isPositive = cumulative.length > 0 && cumulative[cumulative.length - 1].cumPnl >= 0;

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="bg-card border border-border/60 rounded-sm px-2.5 py-2 text-[10px] font-mono">
        <div className="text-muted-foreground">{d.date}</div>
        <div className={cn("font-bold", d.cumPnl >= 0 ? "text-chart-1" : "text-destructive")}>
          Equity: {d.cumPnl >= 0 ? "+" : ""}${d.cumPnl.toFixed(2)}
        </div>
        <div className={cn("mt-0.5", d.pnl >= 0 ? "text-chart-1/70" : "text-destructive/70")}>
          Day: {d.pnl >= 0 ? "+" : ""}${d.pnl.toFixed(2)}
        </div>
      </div>
    );
  };

  if (!data.length || data.every(d => d.pnl === 0)) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
        No trade history yet — chart appears after first closed trades
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={cumulative} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={isPositive ? "hsl(var(--chart-1))" : "hsl(var(--destructive))"} stopOpacity={0.3} />
            <stop offset="95%" stopColor={isPositive ? "hsl(var(--chart-1))" : "hsl(var(--destructive))"} stopOpacity={0.03} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" opacity={0.4} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))", fontFamily: "monospace" }}
          tickFormatter={v => v.slice(5)}
          interval="preserveStartEnd"
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))", fontFamily: "monospace" }}
          tickFormatter={v => `$${v.toFixed(1)}`}
          domain={[min * 1.1, max * 1.1]}
          axisLine={false}
          tickLine={false}
          width={52}
        />
        <Tooltip content={<CustomTooltip />} />
        <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="3 3" />
        <Area
          type="monotone"
          dataKey="cumPnl"
          stroke={isPositive ? "hsl(var(--chart-1))" : "hsl(var(--destructive))"}
          strokeWidth={1.5}
          fill="url(#pnlGrad)"
          dot={false}
          activeDot={{ r: 3, strokeWidth: 0 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function fmtPnl(v: number) {
  return `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`;
}

function fmtPct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}

function pnlColor(v: number) {
  return v > 0 ? "text-chart-1" : v < 0 ? "text-destructive" : "text-muted-foreground";
}

export default function Dashboard() {
  useLiveOrderRelay();
  useBalanceSync();

  const queryClient = useQueryClient();
  const [secAgo, setSecAgo] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(Date.now());
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<NodeJS.Timeout | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const { data: status, isLoading: statusLoading } = useGetBotStatus({
    query: { refetchInterval: 3000, queryKey: getGetBotStatusQueryKey() }
  });
  const { data: pnl, isLoading: pnlLoading } = useGetPnlSummary({
    query: {
      refetchInterval: 5000, queryKey: getGetPnlSummaryQueryKey(),
      onSuccess: () => {
        setLastUpdated(Date.now()); setSecAgo(0); setFlash(true);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlash(false), 600);
      }
    } as any
  });
  const { data: positions } = useListPositions({}, {
    query: { refetchInterval: 5000, queryKey: getListPositionsQueryKey({}) }
  });
  const { data: presets } = useListStrategyPresets({
    query: { refetchInterval: 10000, queryKey: getListStrategyPresetsQueryKey() }
  });
  const { data: signals } = useListSignals({ limit: 6 }, {
    query: { refetchInterval: 8000, queryKey: getListSignalsQueryKey({ limit: 6 }) }
  });
  const { data: dailyData } = useGetDailyPnl({ days: 90 }, {
    query: { refetchInterval: 60000, queryKey: getGetDailyPnlQueryKey({ days: 90 }) }
  });
  const { data: strategyStats } = useGetStrategyStats({
    query: { refetchInterval: 30000, queryKey: getGetStrategyStatsQueryKey() }
  });

  const startBot = useStartBot();
  const stopBot = useStopBot();
  const closePosition = useClosePosition();
  const syncPositions = useSyncPositions({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListPositionsQueryKey({}) });
        setSyncResult(`↑${data.imported} added, ↓${data.closed} closed`);
        setTimeout(() => setSyncResult(null), 4000);
      },
    }
  });

  useEffect(() => {
    const id = setInterval(() => setSecAgo(Math.floor((Date.now() - lastUpdated) / 1000)), 1000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  const handleToggle = () => {
    if (status?.running) {
      stopBot.mutate(undefined, { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() }) });
    } else {
      startBot.mutate(undefined, { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() }) });
    }
  };

  const handleClose = (id: number) => {
    closePosition.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPositionsQueryKey({}) });
        queryClient.invalidateQueries({ queryKey: getGetPnlSummaryQueryKey() });
      }
    });
  };

  const totalPnl = pnl?.totalPnl ?? 0;
  const unrealizedPnl = pnl?.unrealizedPnl ?? 0;
  const realizedPnl = totalPnl - unrealizedPnl;
  const pnlToday = pnl?.todayPnl ?? 0;
  const currentBalance = pnl?.currentBalance ?? null;
  const isLiveMode = status?.mode === "live";
  const enabledPresets = (presets ?? []).filter((p: any) => p.enabled);

  return (
    <Layout>
      <div className="space-y-4">
        {/* Browser relay banner */}
        {isLiveMode && status?.running && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-sm border border-chart-1/30 bg-chart-1/5 text-[11px] font-mono text-chart-1">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-chart-1 opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-chart-1" />
            </span>
            Browser relay active — live orders execute via this tab. Keep the dashboard open.
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Dashboard</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <LiveDot active={status?.running ?? false} />
              <p className="text-xs text-muted-foreground">
                {status?.mode === "live" ? "Live Trading" : "Paper Trading"}
                {status?.running && status?.uptime != null && (
                  <> · {status.uptime < 60 ? `${status.uptime}s` : `${Math.floor(status.uptime / 60)}m`}</>
                )}
              </p>
              <div className={cn("flex items-center gap-1 text-[10px] font-mono text-muted-foreground transition-colors", flash && "text-chart-1")}>
                <RefreshCw className={cn("w-2.5 h-2.5", flash && "animate-spin")} />
                {secAgo === 0 ? "just now" : `${secAgo}s ago`}
              </div>
            </div>
          </div>
          <Button
            size="sm"
            onClick={handleToggle}
            disabled={startBot.isPending || stopBot.isPending}
            className={cn(
              "font-mono text-xs px-4 h-8 rounded-sm",
              status?.running
                ? "bg-destructive hover:bg-destructive/80 text-destructive-foreground"
                : "bg-chart-1 hover:bg-chart-1/80 text-background"
            )}
          >
            {startBot.isPending || stopBot.isPending ? "..." : status?.running ? "STOP BOT" : "START BOT"}
          </Button>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label="Balance"
            value={currentBalance !== null && currentBalance > 0
              ? `$${currentBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
              : "—"}
            sub={isLiveMode
              ? pnl?.balanceSource === "live" ? "live · bybit equity" : "estimated"
              : "paper account"}
            highlight
            loading={pnlLoading}
          />
          <StatCard
            label="Total P&L"
            value={`${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`}
            sub={`${(pnl?.totalPnlPercent || 0).toFixed(2)}% realized + open`}
            positive={totalPnl >= 0}
            loading={pnlLoading}
          />
          <StatCard
            label="Unrealized"
            value={`${unrealizedPnl >= 0 ? "+" : ""}$${unrealizedPnl.toFixed(2)}`}
            sub={`${status?.openPositionsCount ?? 0} open · realized $${realizedPnl.toFixed(2)}`}
            positive={unrealizedPnl >= 0}
            loading={pnlLoading || statusLoading}
          />
          <StatCard
            label="Today P&L"
            value={`${pnlToday >= 0 ? "+" : ""}$${pnlToday.toFixed(2)}`}
            sub={`Win rate ${((pnl?.winRate || 0) * 100).toFixed(1)}% · ${pnl?.totalTrades || 0} trades`}
            positive={pnlToday >= 0}
            loading={pnlLoading}
          />
        </div>

        {/* 50/50 main panels */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* ── LEFT: Open Positions ───────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-widest">Open Positions</span>
                {(positions?.length ?? 0) > 0 && (
                  <Badge variant="outline" className="text-[9px] font-mono h-4 px-1.5">{positions!.length}</Badge>
                )}
              </div>
              <button
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                onClick={() => syncPositions.mutate()}
                disabled={syncPositions.isPending}
              >
                <RefreshCw className={cn("w-3 h-3", syncPositions.isPending && "animate-spin")} />
                Sync
              </button>
            </div>
            {syncResult && (
              <div className="text-[10px] font-mono text-chart-1 bg-chart-1/5 border border-chart-1/20 px-3 py-1.5 rounded-sm">
                {syncResult}
              </div>
            )}
            {!positions || positions.length === 0 ? (
              <div className="bg-card border border-border/60 rounded-sm flex items-center justify-center py-16">
                <p className="text-xs text-muted-foreground">No open positions</p>
              </div>
            ) : (
              <div className="space-y-2">
                {positions.map(p => (
                  <PositionCard
                    key={p.id}
                    pos={p}
                    onClose={() => handleClose(p.id)}
                    closing={closePosition.isPending}
                  />
                ))}
              </div>
            )}
          </div>

          {/* ── RIGHT: Active Strategies + Signals ────────────────── */}
          <div className="flex flex-col gap-3">
            {/* Strategy presets */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold uppercase tracking-widest">Active Strategies</span>
                <Badge variant="outline" className="text-[9px] font-mono h-4 px-1.5">
                  {enabledPresets.length} enabled
                </Badge>
              </div>
              {enabledPresets.length === 0 ? (
                <div className="bg-card border border-border/60 rounded-sm px-4 py-6 text-center text-xs text-muted-foreground">
                  No enabled strategy presets — go to Strategy to create one
                </div>
              ) : (
                <div className="space-y-1.5">
                  {enabledPresets.map((p: any) => (
                    <div key={p.id} className="bg-card border border-border/60 rounded-sm px-3 py-2.5 flex items-start gap-3">
                      <div className="w-1.5 h-1.5 rounded-full bg-chart-1 mt-1.5 shrink-0 animate-pulse" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-semibold">{p.name}</span>
                          <Badge variant="outline" className="text-[9px] px-1.5 h-4 font-mono">${p.positionSizeUsdt} × {p.leverage}x</Badge>
                          {!p.averagingEnabled && <Badge variant="outline" className="text-[9px] px-1.5 h-4 font-mono text-destructive border-destructive/30">SL ${p.stopLossUsdt}</Badge>}
                          <Badge variant="outline" className="text-[9px] px-1.5 h-4 font-mono text-chart-1 border-chart-1/30">TP ${p.takeProfitUsdt}</Badge>
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-[9px] text-muted-foreground font-mono">
                          <span>{p.symbols?.length ?? 0} symbols</span>
                          <span>·</span>
                          <span>{(p.strategies ?? []).join(", ").replace(/_/g, " ")}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recent signals */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Zap className="w-3.5 h-3.5 text-chart-1" />
                <span className="text-xs font-semibold uppercase tracking-widest">Recent Signals</span>
              </div>
              <div className="bg-card border border-border/60 rounded-sm divide-y divide-border/40 max-h-64 overflow-y-auto">
                {!signals || signals.length === 0 ? (
                  <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                    No signals yet — start the bot
                  </div>
                ) : signals.map(s => (
                  <div key={s.id} className="px-3 py-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        {s.direction === "long"
                          ? <TrendingUp className="w-3 h-3 text-chart-1" />
                          : <TrendingDown className="w-3 h-3 text-destructive" />}
                        <span className="font-mono text-xs font-medium">{s.symbol}</span>
                        <Badge className="text-[9px] px-1 h-3.5 rounded-sm" variant="outline">
                          {s.strategy?.replace(/_/g, " ")}
                        </Badge>
                        {s.acted && <span className="text-[9px] text-chart-1 font-mono">▶ TRADED</span>}
                      </div>
                      <span className="text-[9px] text-muted-foreground">
                        {formatDistanceToNow(new Date(s.createdAt), { addSuffix: true })}
                      </span>
                    </div>
                    {s.description && (
                      <p className="text-[9px] text-muted-foreground mt-0.5 leading-tight truncate">{s.description}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ── BOTTOM: Cumulative P&L Chart ───────────────────────── */}
        <div className="bg-card border border-border/60 rounded-sm">
          <div className="px-4 py-2.5 border-b border-border/60 flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold uppercase tracking-widest">Cumulative P&L</span>
              <span className="text-[10px] text-muted-foreground ml-2">90 days · realized trades</span>
            </div>
            <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
              <span>Week <span className={cn("font-bold", (pnl?.weekPnl ?? 0) >= 0 ? "text-chart-1" : "text-destructive")}>
                {(pnl?.weekPnl ?? 0) >= 0 ? "+" : ""}${(pnl?.weekPnl ?? 0).toFixed(2)}
              </span></span>
              <span>Month <span className={cn("font-bold", (pnl?.monthPnl ?? 0) >= 0 ? "text-chart-1" : "text-destructive")}>
                {(pnl?.monthPnl ?? 0) >= 0 ? "+" : ""}${(pnl?.monthPnl ?? 0).toFixed(2)}
              </span></span>
              <span>WR <span className="text-foreground font-bold">{((pnl?.winRate ?? 0) * 100).toFixed(1)}%</span></span>
            </div>
          </div>
          <div className="h-52 px-2 py-3">
            {!dailyData ? (
              <Skeleton className="h-full w-full bg-accent/50" />
            ) : (
              <PnlChart data={dailyData as any} />
            )}
          </div>
        </div>

        {/* ── Strategy Performance ────────────────────────────────── */}
        <div className="bg-card border border-border/60 rounded-sm">
          <div className="px-4 py-2.5 border-b border-border/60">
            <span className="text-xs font-semibold uppercase tracking-widest">Strategy Performance</span>
            <span className="text-[10px] text-muted-foreground ml-2">all closed trades · sorted by P&L</span>
          </div>
          {!strategyStats ? (
            <div className="p-4 space-y-2">
              {[0, 1, 2].map(i => <Skeleton key={i} className="h-8 w-full bg-accent/50" />)}
            </div>
          ) : strategyStats.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-muted-foreground">
              No strategy data yet — stats appear after first closed trades
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[10px] uppercase tracking-widest">Strategy</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-right">Trades</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-right">Win Rate</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-right">Total P&L</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-right">Avg P&L</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-right">Best</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-right">Worst</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...strategyStats]
                  .sort((a, b) => b.totalPnl - a.totalPnl || b.winRate - a.winRate)
                  .map((s) => (
                    <TableRow key={s.strategy}>
                      <TableCell className="font-mono text-xs font-medium">{s.strategy.replace(/_/g, " ")}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {s.totalTrades}
                        <span className="text-[9px] ml-1 text-chart-1/70">{s.winningTrades}W</span>
                        <span className="text-[9px] ml-0.5 text-destructive/70">{s.losingTrades}L</span>
                      </TableCell>
                      <TableCell className={cn("text-right font-mono text-xs font-bold", s.winRate >= 0.5 ? "text-chart-1" : "text-destructive")}>
                        {fmtPct(s.winRate)}
                      </TableCell>
                      <TableCell className={cn("text-right font-mono text-xs font-bold", pnlColor(s.totalPnl))}>
                        {fmtPnl(s.totalPnl)}
                      </TableCell>
                      <TableCell className={cn("text-right font-mono text-xs", pnlColor(s.avgPnl))}>
                        {fmtPnl(s.avgPnl)}
                      </TableCell>
                      <TableCell className={cn("text-right font-mono text-xs", pnlColor(s.bestTrade))}>
                        {fmtPnl(s.bestTrade)}
                      </TableCell>
                      <TableCell className={cn("text-right font-mono text-xs", pnlColor(s.worstTrade))}>
                        {fmtPnl(s.worstTrade)}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </Layout>
  );
}

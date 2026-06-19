import { useState } from "react";
import { Layout } from "@/components/layout";
import { useListTrades, getListTradesQueryKey } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

export default function Trades() {
  const [filter, setFilter] = useState<"all" | "paper" | "live">("all");
  const { data: trades, isLoading } = useListTrades(
    { limit: 100, mode: filter === "all" ? undefined : filter },
    { query: { queryKey: getListTradesQueryKey({ limit: 100, mode: filter === "all" ? undefined : filter }) } }
  );

  const totalPnl = (trades || []).reduce((sum, t) => sum + parseFloat(String(t.pnl)), 0);
  const wins = (trades || []).filter(t => parseFloat(String(t.pnl)) > 0).length;
  const avgCount = (trades || []).filter(t => t.wasAveraged).length;

  return (
    <Layout>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Trade History</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {trades?.length || 0} trades &bull; Win rate {trades?.length ? ((wins / trades.length) * 100).toFixed(1) : "0"}%
              {avgCount > 0 && <> &bull; {avgCount} averaged</>}
            </p>
          </div>
          <Select value={filter} onValueChange={v => setFilter(v as any)}>
            <SelectTrigger className="h-7 text-xs font-mono w-24"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs font-mono">ALL</SelectItem>
              <SelectItem value="paper" className="text-xs font-mono">PAPER</SelectItem>
              <SelectItem value="live" className="text-xs font-mono">LIVE</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Summary row */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-card border border-border/60 p-3 rounded-sm">
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Total Realized P&L</div>
            <div className={cn("text-xl font-mono font-bold mt-1", totalPnl >= 0 ? "text-chart-1" : "text-destructive")}>
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
            </div>
          </div>
          <div className="bg-card border border-border/60 p-3 rounded-sm">
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Winning Trades</div>
            <div className="text-xl font-mono font-bold mt-1 text-chart-1">{wins}</div>
          </div>
          <div className="bg-card border border-border/60 p-3 rounded-sm">
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Losing Trades</div>
            <div className="text-xl font-mono font-bold mt-1 text-destructive">{(trades?.length || 0) - wins}</div>
          </div>
        </div>

        <div className="bg-card border border-border/60 rounded-sm overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-3">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-10 w-full bg-accent" />)}</div>
          ) : !trades?.length ? (
            <div className="p-16 text-center">
              <p className="text-sm text-muted-foreground">No trades yet</p>
              <p className="text-xs text-muted-foreground mt-1">Trades appear here when positions are closed</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-border/60 text-muted-foreground text-[10px] uppercase tracking-widest">
                    <th className="text-left px-4 py-2.5">Symbol</th>
                    <th className="text-left px-3 py-2.5">Side</th>
                    <th className="text-left px-3 py-2.5">Статус</th>
                    <th className="text-right px-3 py-2.5">P&L</th>
                    <th className="text-right px-3 py-2.5">P&L%</th>
                    <th className="text-right px-3 py-2.5">Entry</th>
                    <th className="text-right px-3 py-2.5">Exit</th>
                    <th className="text-right px-3 py-2.5">Qty</th>
                    <th className="text-right px-3 py-2.5">Lev</th>
                    <th className="text-left px-3 py-2.5">Strategy</th>
                    <th className="text-left px-3 py-2.5">Mode</th>
                    <th className="text-left px-3 py-2.5">Opened</th>
                    <th className="text-left px-3 py-2.5">Closed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {trades.map(t => {
                    const pnl = parseFloat(String(t.pnl));
                    const pnlPct = parseFloat(String(t.pnlPercent));
                    const isProfit = pnl > 0;
                    const isLoss = pnl < 0;
                    return (
                      <tr key={t.id} className="hover:bg-accent/30 transition-colors">
                        <td className="px-4 py-2.5 font-semibold">{t.symbol}</td>

                        {/* Side */}
                        <td className="px-3 py-2.5">
                          <Badge className={cn("text-[9px] px-1.5 h-4 rounded-sm", t.side === "long" ? "bg-chart-1/10 text-chart-1 border-chart-1/30" : "bg-destructive/10 text-destructive border-destructive/30")} variant="outline">
                            {t.side.toUpperCase()}
                          </Badge>
                        </td>

                        {/* Status + Averaging badges */}
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1 flex-wrap">
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[9px] px-1.5 h-4 rounded-sm font-mono",
                                isProfit
                                  ? "bg-chart-1/15 text-chart-1 border-chart-1/30"
                                  : isLoss
                                    ? "bg-destructive/15 text-destructive border-destructive/30"
                                    : "bg-accent/30 text-muted-foreground border-border/40"
                              )}
                            >
                              {isProfit ? "▲ ПРИБЫЛЬ" : isLoss ? "▼ УБЫТОК" : "● НОЛЬ"}
                            </Badge>
                            {t.wasAveraged && (
                              <Badge
                                variant="outline"
                                className="text-[9px] px-1.5 h-4 rounded-sm font-mono bg-violet-500/10 text-violet-400 border-violet-500/30"
                              >
                                ×{t.averageCount + 1} avg
                              </Badge>
                            )}
                          </div>
                        </td>

                        {/* P&L */}
                        <td className={cn("px-3 py-2.5 text-right font-bold", isProfit ? "text-chart-1" : isLoss ? "text-destructive" : "text-muted-foreground")}>
                          {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                        </td>
                        <td className={cn("px-3 py-2.5 text-right", isProfit ? "text-chart-1" : isLoss ? "text-destructive" : "text-muted-foreground")}>
                          {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                        </td>

                        <td className="px-3 py-2.5 text-right">${parseFloat(String(t.entryPrice)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        <td className="px-3 py-2.5 text-right">${parseFloat(String(t.exitPrice)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        <td className="px-3 py-2.5 text-right">{parseFloat(String(t.quantity)).toFixed(4)}</td>
                        <td className="px-3 py-2.5 text-right">{t.leverage}x</td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-col gap-0.5">
                            {t.presetName && (
                              <Badge variant="outline" className="text-[9px] px-1.5 h-4 rounded-sm font-mono bg-blue-500/10 text-blue-400 border-blue-500/30 w-fit">
                                {t.presetName}
                              </Badge>
                            )}
                            <span className="text-muted-foreground text-[10px]">{t.strategy.replace(/_/g, " ")}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge variant="outline" className="text-[9px] px-1.5 h-4 rounded-sm">{t.mode.toUpperCase()}</Badge>
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground text-[10px]">{format(new Date(t.openedAt), "MMM d HH:mm")}</td>
                        <td className="px-3 py-2.5 text-muted-foreground text-[10px]">{format(new Date(t.closedAt), "MMM d HH:mm")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}

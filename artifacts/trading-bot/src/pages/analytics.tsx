import { Layout } from "@/components/layout";
import { useGetPnlSummary, useGetDailyPnl, getGetPnlSummaryQueryKey, getGetDailyPnlQueryKey } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, ReferenceLine, Cell } from "recharts";
import { format } from "date-fns";

function StatCard({ label, value, positive, sub }: { label: string; value: string; positive?: boolean; sub?: string }) {
  return (
    <div className="bg-card border border-border/60 p-4 rounded-sm">
      <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">{label}</div>
      <div className={cn("text-2xl font-mono font-bold", positive === true && "text-chart-1", positive === false && "text-destructive")}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  const v = payload[0].value;
  return (
    <div className="bg-popover border border-border rounded-sm px-3 py-2 text-xs font-mono">
      <div className="text-muted-foreground mb-1">{label}</div>
      <div className={cn("font-bold", v >= 0 ? "text-chart-1" : "text-destructive")}>{v >= 0 ? "+" : ""}${v?.toFixed(2)}</div>
    </div>
  );
};

export default function Analytics() {
  const { data: pnl, isLoading: pnlLoading } = useGetPnlSummary({ query: { queryKey: getGetPnlSummaryQueryKey() } });
  const { data: daily, isLoading: dailyLoading } = useGetDailyPnl({ days: 30 }, { query: { queryKey: getGetDailyPnlQueryKey({ days: 30 }) } });

  const chartData = (daily || []).map(d => ({
    date: format(new Date(d.date), "MMM d"),
    pnl: parseFloat(String(d.pnl)),
    trades: d.trades,
    winRate: parseFloat(String(d.winRate)),
  }));

  const totalPnl = pnl?.totalPnl ?? 0;
  const winRate = (pnl?.winRate ?? 0) * 100;

  return (
    <Layout>
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Analytics</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Performance stats and P&L breakdown</p>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {pnlLoading ? [1,2,3,4].map(i => <div key={i} className="bg-card border border-border/60 p-4 rounded-sm"><Skeleton className="h-8 w-20 bg-accent" /></div>) : <>
            <StatCard label="Total P&L" value={`${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`} positive={totalPnl >= 0} sub={`${(pnl?.totalPnlPercent ?? 0).toFixed(2)}%`} />
            <StatCard label="Win Rate" value={`${winRate.toFixed(1)}%`} positive={winRate >= 50} sub={`${pnl?.winningTrades ?? 0}W / ${pnl?.losingTrades ?? 0}L`} />
            <StatCard label="Profit Factor" value={(pnl?.profitFactor ?? 0).toFixed(2)} positive={(pnl?.profitFactor ?? 0) > 1} />
            <StatCard label="Max Drawdown" value={`${(pnl?.maxDrawdown ?? 0).toFixed(2)}%`} positive={false} />
          </>}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {pnlLoading ? [1,2,3,4].map(i => <div key={i} className="bg-card border border-border/60 p-4 rounded-sm"><Skeleton className="h-8 w-20 bg-accent" /></div>) : <>
            <StatCard label="Today P&L" value={`${(pnl?.todayPnl ?? 0) >= 0 ? "+" : ""}$${(pnl?.todayPnl ?? 0).toFixed(2)}`} positive={(pnl?.todayPnl ?? 0) >= 0} />
            <StatCard label="Week P&L" value={`${(pnl?.weekPnl ?? 0) >= 0 ? "+" : ""}$${(pnl?.weekPnl ?? 0).toFixed(2)}`} positive={(pnl?.weekPnl ?? 0) >= 0} />
            <StatCard label="Avg Win" value={`$${(pnl?.avgWin ?? 0).toFixed(2)}`} positive={true} />
            <StatCard label="Avg Loss" value={`$${(pnl?.avgLoss ?? 0).toFixed(2)}`} positive={false} />
          </>}
        </div>

        {/* Daily P&L Chart */}
        <div className="bg-card border border-border/60 rounded-sm p-4">
          <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-4">Daily P&L (30 days)</div>
          {dailyLoading ? (
            <Skeleton className="h-48 w-full bg-accent" />
          ) : !chartData.length ? (
            <div className="h-48 flex items-center justify-center text-xs text-muted-foreground">No data yet — trades will appear here</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: "hsl(215.4 16.3% 56.9%)", fontFamily: "monospace" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: "hsl(215.4 16.3% 56.9%)", fontFamily: "monospace" }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine y={0} stroke="hsl(216 34% 17%)" />
                <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                  {chartData.map((entry, index) => (
                    <Cell key={index} fill={entry.pnl >= 0 ? "hsl(172 100% 48%)" : "hsl(350 100% 65%)"} opacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Paper vs Live */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-card border border-border/60 p-4 rounded-sm">
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">Paper P&L</div>
            <div className={cn("text-xl font-mono font-bold", (pnl?.paperPnl ?? 0) >= 0 ? "text-chart-1" : "text-destructive")}>
              {(pnl?.paperPnl ?? 0) >= 0 ? "+" : ""}${(pnl?.paperPnl ?? 0).toFixed(2)}
            </div>
          </div>
          <div className="bg-card border border-border/60 p-4 rounded-sm">
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">Live P&L</div>
            <div className={cn("text-xl font-mono font-bold", (pnl?.livePnl ?? 0) >= 0 ? "text-chart-1" : "text-destructive")}>
              {(pnl?.livePnl ?? 0) >= 0 ? "+" : ""}${(pnl?.livePnl ?? 0).toFixed(2)}
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}

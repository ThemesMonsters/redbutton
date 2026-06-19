import { useState } from "react";
import { Layout } from "@/components/layout";
import { useGetMarketTicker, useGetKlines, getGetMarketTickerQueryKey, getGetKlinesQueryKey } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, Tooltip, Line } from "recharts";
import { format } from "date-fns";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
const INTERVALS = [
  { label: "1m", value: "1" },
  { label: "5m", value: "5" },
  { label: "15m", value: "15" },
  { label: "1h", value: "60" },
  { label: "4h", value: "240" },
  { label: "1D", value: "D" },
];

const CandleTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="bg-popover border border-border rounded-sm px-3 py-2 text-[10px] font-mono space-y-0.5">
      <div className="text-muted-foreground">{format(new Date(d.timestamp), "MMM d HH:mm")}</div>
      <div>O: <span className="text-foreground">{d.open.toFixed(2)}</span></div>
      <div>H: <span className="text-chart-1">{d.high.toFixed(2)}</span></div>
      <div>L: <span className="text-destructive">{d.low.toFixed(2)}</span></div>
      <div>C: <span className="text-foreground font-bold">{d.close.toFixed(2)}</span></div>
      <div>V: <span className="text-muted-foreground">{d.volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></div>
    </div>
  );
};

export default function Market() {
  const [selectedSymbol, setSelectedSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState("60");

  const { data: tickers, isLoading: tickersLoading } = useGetMarketTicker(
    {},
    { query: { refetchInterval: 15000, queryKey: getGetMarketTickerQueryKey({}) } }
  );

  const { data: klines, isLoading: klinesLoading } = useGetKlines(
    { symbol: selectedSymbol, interval: interval as any, limit: 80 },
    { query: { refetchInterval: 30000, queryKey: getGetKlinesQueryKey({ symbol: selectedSymbol, interval: interval as any, limit: 80 }) } }
  );

  const displayTickers = (tickers || []).filter(t => SYMBOLS.includes(t.symbol));
  const selectedTicker = displayTickers.find(t => t.symbol === selectedSymbol);

  const chartData = (klines || []).map(k => ({
    ...k,
    bullish: k.close >= k.open,
    bodyTop: Math.max(k.open, k.close),
    bodyBottom: Math.min(k.open, k.close),
    bodySize: Math.abs(k.close - k.open),
    wickTop: k.high,
    wickBottom: k.low,
  }));

  return (
    <Layout>
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Market</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Live market data — refreshes every 15s</p>
        </div>

        {/* Ticker Row */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
          {tickersLoading ? SYMBOLS.map(s => <div key={s} className="bg-card border border-border/60 p-3 rounded-sm"><Skeleton className="h-10 w-full bg-accent" /></div>) :
            displayTickers.map(t => {
              const change = parseFloat(String(t.changePercent24h));
              const isSelected = t.symbol === selectedSymbol;
              return (
                <button
                  key={t.symbol}
                  onClick={() => setSelectedSymbol(t.symbol)}
                  className={cn(
                    "bg-card border rounded-sm p-3 text-left transition-all hover:border-chart-1/50",
                    isSelected ? "border-chart-1/60 bg-chart-1/5" : "border-border/60"
                  )}
                >
                  <div className="text-[10px] text-muted-foreground font-mono mb-1">{t.symbol.replace("USDT", "")}/USDT</div>
                  <div className="font-mono font-bold text-sm">${parseFloat(String(t.lastPrice)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                  <div className={cn("font-mono text-[10px] mt-0.5", change >= 0 ? "text-chart-1" : "text-destructive")}>
                    {change >= 0 ? "+" : ""}{change.toFixed(2)}%
                  </div>
                </button>
              );
            })
          }
        </div>

        {/* Selected ticker info */}
        {selectedTicker && (
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: "24h High", value: `$${parseFloat(String(selectedTicker.high24h)).toLocaleString(undefined, { maximumFractionDigits: 2 })}` },
              { label: "24h Low", value: `$${parseFloat(String(selectedTicker.low24h)).toLocaleString(undefined, { maximumFractionDigits: 2 })}` },
              { label: "24h Volume", value: parseFloat(String(selectedTicker.volume24h)).toLocaleString(undefined, { maximumFractionDigits: 0 }) },
              { label: "24h Change", value: `${parseFloat(String(selectedTicker.change24h)) >= 0 ? "+" : ""}$${parseFloat(String(selectedTicker.change24h)).toFixed(2)}` },
            ].map(item => (
              <div key={item.label} className="bg-card border border-border/60 p-3 rounded-sm">
                <div className="text-[10px] text-muted-foreground uppercase tracking-widest">{item.label}</div>
                <div className="font-mono text-sm font-bold mt-1">{item.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Chart */}
        <div className="bg-card border border-border/60 rounded-sm p-4">
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{selectedSymbol} Chart</span>
            <div className="flex gap-1">
              {INTERVALS.map(iv => (
                <button
                  key={iv.value}
                  onClick={() => setInterval(iv.value)}
                  className={cn(
                    "px-2 py-1 text-[10px] font-mono rounded-sm transition-colors",
                    interval === iv.value ? "bg-chart-1/20 text-chart-1 border border-chart-1/40" : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  )}
                >
                  {iv.label}
                </button>
              ))}
            </div>
          </div>
          {klinesLoading ? (
            <Skeleton className="h-64 w-full bg-accent" />
          ) : !chartData.length ? (
            <div className="h-64 flex items-center justify-center text-xs text-muted-foreground">Loading chart data...</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <XAxis
                  dataKey="timestamp"
                  tick={{ fontSize: 9, fill: "hsl(215.4 16.3% 56.9%)", fontFamily: "monospace" }}
                  tickFormatter={ts => format(new Date(ts), interval === "D" ? "MMM d" : "HH:mm")}
                  axisLine={false} tickLine={false} interval="preserveStartEnd"
                />
                <YAxis
                  domain={["auto", "auto"]}
                  tick={{ fontSize: 9, fill: "hsl(215.4 16.3% 56.9%)", fontFamily: "monospace" }}
                  axisLine={false} tickLine={false}
                  tickFormatter={v => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                  width={70}
                />
                <Tooltip content={<CandleTooltip />} />
                <Line type="monotone" dataKey="close" stroke="hsl(172 100% 48%)" strokeWidth={1.5} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </Layout>
  );
}

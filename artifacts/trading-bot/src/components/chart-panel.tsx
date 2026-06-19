import { useEffect, useRef, useState, useCallback } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type CandlestickData,
  type LineData,
  type Time,
} from "lightweight-charts";
import { X, RefreshCw, TrendingUp, TrendingDown, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

interface FibLevel { ratio: number; price: number; label: string }
interface OrderBlock { low: number; high: number; direction: "long" | "short" }
interface OpenPosition { id: number; side: string; entryPrice: number; quantity: number; leverage: number; unrealizedPnl: number; stopLoss?: number | null; takeProfit?: number | null }
interface RecentSignal { strategy: string; direction: string; price: number; strength: number; createdAt: string }
interface RsiPoint { time: number; value: number }
interface VolumeProfilePoint { price: number; volume: number; relVol: number }

interface StrategyLevels {
  symbol: string;
  currentPrice: number;
  poc?: number | null;
  fibHigh?: number | null;
  fibLow?: number | null;
  fibLevels: FibLevel[];
  orderBlocks: OrderBlock[];
  openPositions: OpenPosition[];
  recentSignals: RecentSignal[];
  rsiValue?: number | null;
  rsiValues?: RsiPoint[];
  volumeProfile?: VolumeProfilePoint[];
}

interface Kline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ChartPanelProps {
  symbol: string;
  strategies: string[];
  strategyTimeframe?: string;
  onClose: () => void;
}

const INTERVALS = [
  { label: "1m", value: "1" },
  { label: "5m", value: "5" },
  { label: "15m", value: "15" },
  { label: "1h", value: "60" },
  { label: "4h", value: "240" },
  { label: "1D", value: "D" },
];

const FIB_COLORS: Record<number, string> = {
  0.236: "#6366f1",
  0.382: "#8b5cf6",
  0.5: "#a78bfa",
  0.618: "#c084fc",
  0.786: "#d946ef",
};

const STRATEGY_LABELS: Record<string, string> = {
  volume_profile: "Vol Profile",
  fibonacci: "Fibonacci",
  order_blocks: "OB",
  rsi: "RSI",
};

export function ChartPanel({ symbol, strategies, strategyTimeframe, onClose }: ChartPanelProps) {
  const mainChartRef = useRef<HTMLDivElement>(null);
  const rsiChartRef = useRef<HTMLDivElement>(null);
  const vpCanvasRef = useRef<HTMLCanvasElement>(null);
  const mainApiRef = useRef<IChartApi | null>(null);
  const rsiApiRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const isSyncingRef = useRef(false);
  const levelsRef = useRef<StrategyLevels | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  const [interval, setSelectedInterval] = useState(strategyTimeframe || "60");
  const [levels, setLevels] = useState<StrategyLevels | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const showRsi = strategies.includes("rsi");

  // ── Volume Profile canvas renderer ──────────────────────────────────────────
  const drawVolumeProfile = useCallback(() => {
    const canvas = vpCanvasRef.current;
    const series = candleSeriesRef.current;
    if (!canvas || !series) return;
    const vp = levelsRef.current?.volumeProfile;
    const poc = levelsRef.current?.poc;

    const parent = canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w === 0 || h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";

    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!vp?.length) return;

    const bucketSize = vp.length > 1 ? Math.abs(vp[1].price - vp[0].price) : 1;
    const maxBarWidth = w * 0.12; // 12% of chart width, right-aligned

    for (const bucket of vp) {
      if (bucket.relVol < 0.02) continue;

      const yTop = series.priceToCoordinate(bucket.price + bucketSize / 2);
      const yBot = series.priceToCoordinate(bucket.price - bucketSize / 2);
      if (yTop == null || yBot == null) continue;

      const barH = Math.max(1.5, Math.abs(yBot - yTop) - 0.5);
      const yStart = Math.min(yTop, yBot);
      const barW = bucket.relVol * maxBarWidth;

      const isPOC = poc != null && Math.abs(bucket.price - poc) < bucketSize * 0.7;
      if (isPOC) {
        ctx.fillStyle = "rgba(250, 204, 21, 0.92)";
      } else if (bucket.relVol > 0.75) {
        ctx.fillStyle = "rgba(0, 200, 150, 0.55)";
      } else if (bucket.relVol > 0.45) {
        ctx.fillStyle = "rgba(0, 200, 150, 0.32)";
      } else {
        ctx.fillStyle = "rgba(0, 200, 150, 0.14)";
      }
      ctx.fillRect(w - barW, yStart, barW, barH);
    }
  }, []);

  // ── Fetch klines + levels ──────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [klinesRes, levelsRes] = await Promise.all([
        fetch(`/api/market/klines?symbol=${symbol}&interval=${interval}&limit=300`),
        fetch(`/api/market/levels?symbol=${symbol}&interval=${interval}&strategies=${strategies.join(",")}`),
      ]);
      const klines: Kline[] = await klinesRes.json();
      const lvls: StrategyLevels = await levelsRes.json();
      levelsRef.current = lvls;
      setLevels(lvls);

      if (candleSeriesRef.current && klines.length > 0) {
        const data: CandlestickData[] = klines.map(k => ({
          time: Math.floor(k.timestamp / 1000) as Time,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
        }));
        candleSeriesRef.current.setData(data);
        // Remove all old price lines before adding new ones
        priceLinesRef.current.forEach(pl => { try { candleSeriesRef.current!.removePriceLine(pl); } catch {} });
        priceLinesRef.current = updatePriceLines(candleSeriesRef.current, lvls);
        mainApiRef.current?.timeScale().fitContent();
        // Draw VP after chart renders with a short delay so coordinates are ready
        requestAnimationFrame(() => drawVolumeProfile());
      }

      if (rsiSeriesRef.current && lvls.rsiValues && lvls.rsiValues.length > 0) {
        const rsiData: LineData[] = lvls.rsiValues.map(r => ({
          time: r.time as Time,
          value: r.value,
        }));
        rsiSeriesRef.current.setData(rsiData);
        rsiApiRef.current?.timeScale().fitContent();
      }
    } catch {
      setError("Failed to load chart data");
    } finally {
      setLoading(false);
    }
  }, [symbol, interval, strategies]);

  // ── Init main chart ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mainChartRef.current) return;

    const chart = createChart(mainChartRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#070d1a" },
        textColor: "#94a3b8",
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#0f1f3d", style: LineStyle.Dashed },
        horzLines: { color: "#0f1f3d", style: LineStyle.Dashed },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#00f5e4", labelBackgroundColor: "#00f5e4", width: 1, style: LineStyle.Dashed },
        horzLine: { color: "#00f5e4", labelBackgroundColor: "#00f5e4", width: 1, style: LineStyle.Dashed },
      },
      rightPriceScale: { borderColor: "#1e3a5f", textColor: "#64748b" },
      timeScale: { borderColor: "#1e3a5f", timeVisible: true, secondsVisible: false },
      width: mainChartRef.current.clientWidth,
      height: 480,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#00c896",
      downColor: "#f43f5e",
      borderUpColor: "#00c896",
      borderDownColor: "#f43f5e",
      wickUpColor: "#00c896",
      wickDownColor: "#f43f5e",
    });

    mainApiRef.current = chart;
    candleSeriesRef.current = candleSeries;

    // Redraw VP histogram when user scrolls/zooms
    const onRangeChange = () => drawVolumeProfile();
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
        drawVolumeProfile();
      }
    });
    resizeObserver.observe(mainChartRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      chart.remove();
      mainApiRef.current = null;
      candleSeriesRef.current = null;
    };
  }, [drawVolumeProfile]);

  // ── Init RSI sub-chart ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!rsiChartRef.current || !showRsi) return;

    const chart = createChart(rsiChartRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#050b14" },
        textColor: "#64748b",
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "#0a1628", style: LineStyle.Dashed },
        horzLines: { color: "#0a1628", style: LineStyle.Dashed },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#00f5e480", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#00f5e4" },
        horzLine: { color: "#00f5e480", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#00f5e4" },
      },
      rightPriceScale: { borderColor: "#1e3a5f", textColor: "#475569", minimumWidth: 60 },
      timeScale: { borderColor: "#1e3a5f", timeVisible: true, secondsVisible: false },
      width: rsiChartRef.current.clientWidth,
      height: 130,
    });

    const rsiLine = chart.addLineSeries({
      color: "#a78bfa",
      lineWidth: 2,
      priceScaleId: "right",
      lastValueVisible: true,
      priceLineVisible: false,
    });

    // Overbought line (70)
    rsiLine.createPriceLine({
      price: 70,
      color: "#f43f5e80",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "70",
    });

    // Oversold line (30)
    rsiLine.createPriceLine({
      price: 30,
      color: "#00c89680",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "30",
    });

    // Midline (50)
    rsiLine.createPriceLine({
      price: 50,
      color: "#94a3b820",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: false,
      title: "",
    });

    rsiApiRef.current = chart;
    rsiSeriesRef.current = rsiLine;

    // Force RSI price scale to [0, 100]
    chart.priceScale("right").applyOptions({ autoScale: false, scaleMargins: { top: 0.05, bottom: 0.05 } });

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    resizeObserver.observe(rsiChartRef.current);

    // Sync time range: main → RSI
    const onMainRangeChange = (range: Parameters<Parameters<ReturnType<IChartApi["timeScale"]>["subscribeVisibleLogicalRangeChange"]>[0]>[0]) => {
      if (isSyncingRef.current || !range) return;
      isSyncingRef.current = true;
      rsiApiRef.current?.timeScale().setVisibleLogicalRange(range);
      isSyncingRef.current = false;
    };
    mainApiRef.current?.timeScale().subscribeVisibleLogicalRangeChange(onMainRangeChange);

    // Sync time range: RSI → main
    const onRsiRangeChange = (range: Parameters<Parameters<ReturnType<IChartApi["timeScale"]>["subscribeVisibleLogicalRangeChange"]>[0]>[0]) => {
      if (isSyncingRef.current || !range) return;
      isSyncingRef.current = true;
      mainApiRef.current?.timeScale().setVisibleLogicalRange(range);
      isSyncingRef.current = false;
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRsiRangeChange);

    return () => {
      resizeObserver.disconnect();
      mainApiRef.current?.timeScale().unsubscribeVisibleLogicalRangeChange(onMainRangeChange);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRsiRangeChange);
      chart.remove();
      rsiApiRef.current = null;
      rsiSeriesRef.current = null;
    };
  }, [showRsi]);

  // Fetch on symbol/interval change
  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-refresh every 15s
  useEffect(() => {
    const id = setInterval(fetchData, 15_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const rsiColor = levels?.rsiValue != null
    ? levels.rsiValue > 70 ? "text-rose-400"
    : levels.rsiValue < 30 ? "text-emerald-400"
    : "text-muted-foreground"
    : "text-muted-foreground";

  return (
    <div className="bg-card border border-border/60 rounded-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/40 bg-background/60">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-chart-1" />
            <span className="text-sm font-bold font-mono text-foreground">
              {symbol.replace("USDT", "")}<span className="text-muted-foreground">/USDT</span>
            </span>
          </div>
          {levels && (
            <span className="text-xs font-mono text-chart-1 font-bold">
              ${levels.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
            </span>
          )}
          {levels?.rsiValue != null && (
            <span className={cn("text-[10px] font-mono px-1.5 py-0.5 rounded-sm border", rsiColor,
              levels.rsiValue > 70 ? "border-rose-400/30 bg-rose-400/5" :
              levels.rsiValue < 30 ? "border-emerald-400/30 bg-emerald-400/5" :
              "border-border/40 bg-accent/20"
            )}>
              RSI {levels.rsiValue.toFixed(1)}
              {levels.rsiValue > 70 && " ↓OB"}
              {levels.rsiValue < 30 && " ↑OS"}
            </span>
          )}
          <div className="flex gap-0.5">
            {strategies.map(s => (
              <span key={s} className="text-[9px] font-mono px-1.5 py-0.5 bg-chart-1/10 border border-chart-1/20 text-chart-1 rounded-sm">
                {STRATEGY_LABELS[s] ?? s}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5">
            {INTERVALS.map(iv => (
              <button
                key={iv.value}
                onClick={() => setSelectedInterval(iv.value)}
                className={cn(
                  "px-2 py-0.5 text-[10px] font-mono rounded-sm transition-all",
                  interval === iv.value
                    ? "bg-chart-1 text-background font-bold"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                )}
              >
                {iv.label}
              </button>
            ))}
          </div>
          <button onClick={fetchData} className="text-muted-foreground hover:text-foreground transition-colors p-0.5">
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          </button>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors p-0.5">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main candle chart */}
      <div className="relative">
        <div ref={mainChartRef} className="w-full" />
        <canvas ref={vpCanvasRef} className="absolute inset-0 pointer-events-none" style={{ height: "480px" }} />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60 pointer-events-none">
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              Loading...
            </div>
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-xs text-destructive font-mono">{error}</p>
          </div>
        )}
      </div>

      {/* RSI sub-chart */}
      {showRsi && (
        <div className="border-t border-border/30">
          <div className="flex items-center gap-2 px-3 py-1 bg-background/40 border-b border-border/20">
            <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">RSI (14)</span>
            <span className="text-[9px] font-mono text-rose-400/70">70 overbought</span>
            <span className="text-[9px] font-mono text-muted-foreground/40">·</span>
            <span className="text-[9px] font-mono text-emerald-400/70">30 oversold</span>
          </div>
          <div ref={rsiChartRef} className="w-full" />
        </div>
      )}

      {/* Legend & Levels Panel */}
      {levels && (
        <div className="border-t border-border/40 grid grid-cols-3 divide-x divide-border/40">
          {/* Volume Profile / POC */}
          <div className="p-3 space-y-1.5">
            <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">Volume Profile</div>
            {levels.poc != null ? (
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <span className="inline-block w-3 h-0.5 bg-yellow-400 rounded" />
                  POC
                </span>
                <span className="text-[10px] font-mono text-yellow-400 font-bold">
                  ${levels.poc.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                </span>
              </div>
            ) : (
              <div className="text-[10px] text-muted-foreground/50 italic">Not active</div>
            )}
          </div>

          {/* Fibonacci Levels */}
          <div className="p-3 space-y-1.5">
            <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">Fibonacci</div>
            {levels.fibLevels.length > 0 ? (
              <div className="space-y-0.5">
                {levels.fibLevels.slice(0, 4).map(f => (
                  <div key={f.ratio} className="flex items-center justify-between">
                    <span className="text-[9px] text-muted-foreground flex items-center gap-1">
                      <span className="inline-block w-3 h-0.5 rounded" style={{ backgroundColor: FIB_COLORS[f.ratio] ?? "#a78bfa" }} />
                      {f.label}
                    </span>
                    <span className="text-[9px] font-mono" style={{ color: FIB_COLORS[f.ratio] ?? "#a78bfa" }}>
                      ${f.price.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[10px] text-muted-foreground/50 italic">Not active</div>
            )}
          </div>

          {/* Order Blocks + Positions + Signals */}
          <div className="p-3 space-y-2">
            {levels.orderBlocks.length > 0 && (
              <div className="space-y-1">
                <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">Order Blocks</div>
                {levels.orderBlocks.slice(0, 3).map((ob, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className={cn("text-[9px] flex items-center gap-1", ob.direction === "long" ? "text-emerald-400" : "text-rose-400")}>
                      {ob.direction === "long" ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
                      {ob.direction.toUpperCase()} OB
                    </span>
                    <span className="text-[9px] font-mono text-muted-foreground">
                      {ob.low.toLocaleString(undefined, { maximumFractionDigits: 2 })}–{ob.high.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {levels.openPositions.length > 0 && (
              <div className="space-y-1">
                <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">Open Position</div>
                {levels.openPositions.map(p => (
                  <div key={p.id} className="flex items-center justify-between">
                    <span className={cn("text-[9px] flex items-center gap-1", p.side === "long" ? "text-emerald-400" : "text-rose-400")}>
                      {p.side === "long" ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
                      {p.side.toUpperCase()} ×{p.leverage}
                    </span>
                    <span className={cn("text-[9px] font-mono font-bold", p.unrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
                      {p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {levels.recentSignals.length > 0 && (
              <div>
                <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-1">Latest Signal</div>
                {levels.recentSignals.slice(0, 2).map((s, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className={cn("text-[9px] flex items-center gap-1", s.direction === "long" ? "text-emerald-400" : "text-rose-400")}>
                      {s.direction === "long" ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
                      {s.direction.toUpperCase()}
                    </span>
                    <span className="text-[9px] text-muted-foreground font-mono">{s.strategy.replace(/_/g, " ")}</span>
                  </div>
                ))}
              </div>
            )}
            {levels.orderBlocks.length === 0 && levels.openPositions.length === 0 && levels.recentSignals.length === 0 && (
              <div className="text-[10px] text-muted-foreground/50 italic">No signals yet</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Overlay price lines onto series ────────────────────────────────────────────
// Returns the list of created lines so the caller can remove them next refresh.
function updatePriceLines(series: ISeriesApi<"Candlestick">, levels: StrategyLevels): IPriceLine[] {
  const lines: IPriceLine[] = [];

  // POC line
  if (levels.poc != null && levels.poc > 0) {
    lines.push(series.createPriceLine({
      price: levels.poc,
      color: "#facc15",
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "◆ POC",
    }));
  }

  // Fibonacci lines
  for (const f of levels.fibLevels) {
    lines.push(series.createPriceLine({
      price: f.price,
      color: FIB_COLORS[f.ratio] ?? "#a78bfa",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: f.label,
    }));
  }

  // Order blocks
  for (const ob of levels.orderBlocks) {
    const isLong = ob.direction === "long";
    const color = isLong ? "#00c896" : "#f43f5e";
    const dimColor = isLong ? "#00c89660" : "#f43f5e60";

    lines.push(series.createPriceLine({
      price: ob.high,
      color,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: isLong ? "▲ OB hi" : "▼ OB hi",
    }));
    lines.push(series.createPriceLine({
      price: ob.low,
      color: dimColor,
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: isLong ? "▲ OB lo" : "▼ OB lo",
    }));
  }

  // Open positions — entry, SL, TP
  for (const pos of levels.openPositions) {
    const isLong = pos.side === "long";
    lines.push(series.createPriceLine({
      price: pos.entryPrice,
      color: isLong ? "#00c896" : "#f43f5e",
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: `● ${isLong ? "LONG" : "SHORT"} entry ×${pos.leverage}`,
    }));
    if (pos.stopLoss != null) {
      lines.push(series.createPriceLine({
        price: pos.stopLoss,
        color: "#f43f5e",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "✕ SL",
      }));
    }
    if (pos.takeProfit != null) {
      lines.push(series.createPriceLine({
        price: pos.takeProfit,
        color: "#00c896",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "✓ TP",
      }));
    }
  }

  return lines;
}

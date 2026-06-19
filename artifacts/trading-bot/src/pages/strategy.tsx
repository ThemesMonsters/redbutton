import { useEffect, useState } from "react";
import { Layout } from "@/components/layout";
import {
  useGetBotConfig, useUpdateBotConfig, useGetBalance,
  useListStrategyPresets, useCreateStrategyPreset, useUpdateStrategyPreset, useDeleteStrategyPreset,
  getGetBotConfigQueryKey, getGetBalanceQueryKey, getListStrategyPresetsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, Wifi, WifiOff, Plus, Trash2, X, Wallet } from "lucide-react";

const ALL_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "MATICUSDT", "LTCUSDT", "TRXUSDT", "ATOMUSDT", "NEARUSDT",
];

const STRATEGY_OPTIONS = [
  { id: "volume_profile",  label: "Volume Profile",         desc: "1H POC-based entry at highest-volume price level" },
  { id: "fibonacci",       label: "Fibonacci Retracement",  desc: "1H swing retracement entry at configurable level (e.g. 0.618)" },
  { id: "order_blocks",    label: "Order Blocks",           desc: "1H institutional zones — entry at last impulse candle" },
  { id: "rsi",             label: "RSI Crossover",          desc: "RSI crosses oversold/overbought, confirmed by 1H volume" },
  { id: "liquidation",     label: "Liquidation Sweep",      desc: "Entry after price sweeps a top-10% liquidation cluster" },
];

const TIMEFRAME_OPTIONS = [
  { label: "1m", value: "1" }, { label: "5m", value: "5" }, { label: "15m", value: "15" },
  { label: "1h", value: "60" }, { label: "4h", value: "240" }, { label: "1D", value: "D" },
];

const LEVERAGE_OPTIONS = [1, 2, 3, 5, 10, 15, 20, 25, 50, 100];

type Preset = {
  id: number;
  name: string;
  enabled: boolean;
  symbols: string[];
  strategies: string[];
  strategyMode: "AND" | "OR";
  positionSizeUsdt: number;
  leverage: number;
  maxPositions: number;
  stopLossUsdt: number;
  takeProfitUsdt: number;
  averagingEnabled: boolean;
  averagingThresholdPercent: number;
  maxAveragingCount: number;
  averagingAmountUsdt: number;
  timeframe: string;
  volumeProfileParams: any;
  fibonacciParams: any;
  orderBlockParams: any;
  rsiParams: any;
};

const DEFAULT_PRESET = (): Omit<Preset, "id" | "createdAt" | "updatedAt"> => ({
  name: "New Strategy",
  enabled: true,
  symbols: ["BTCUSDT", "ETHUSDT"],
  strategies: ["volume_profile"],
  strategyMode: "OR",
  positionSizeUsdt: 1,
  leverage: 10,
  maxPositions: 3,
  stopLossUsdt: 1,
  takeProfitUsdt: 2,
  averagingEnabled: false,
  averagingThresholdPercent: 80,
  maxAveragingCount: 2,
  averagingAmountUsdt: 1,
  timeframe: "60",
  volumeProfileParams: { lookbackBars: 100, pocTolerance: 0.005 },
  fibonacciParams: { entryLevel: 0.618, slLevel: 0.786 },
  orderBlockParams: { lookbackBars: 50, minImpulsePercent: 1.5 },
  rsiParams: { period: 14, oversoldLevel: 30, overboughtLevel: 70 },
});

function PresetCard({
  preset,
  onSave,
  onDelete,
  onToggle,
}: {
  preset: Preset;
  onSave: (id: number, data: Partial<Preset>) => void;
  onDelete: (id: number) => void;
  onToggle: (id: number, enabled: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState<Preset>({ ...preset });
  const [symbolInput, setSymbolInput] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setForm({ ...preset });
    setDirty(false);
  }, [preset]);

  const update = (patch: Partial<Preset>) => {
    setForm(f => ({ ...f, ...patch }));
    setDirty(true);
  };

  const updateNested = (key: keyof Preset, patch: object) => {
    setForm(f => ({ ...f, [key]: { ...(f[key] as any), ...patch } }));
    setDirty(true);
  };

  const toggleStrategy = (id: string) => {
    const next = form.strategies.includes(id)
      ? form.strategies.filter(s => s !== id)
      : [...form.strategies, id];
    update({ strategies: next });
  };

  const toggleSymbol = (sym: string) => {
    const next = form.symbols.includes(sym)
      ? form.symbols.filter(s => s !== sym)
      : [...form.symbols, sym];
    update({ symbols: next });
  };

  const addCustomSymbol = () => {
    const sym = symbolInput.trim().toUpperCase();
    if (!sym || form.symbols.includes(sym)) { setSymbolInput(""); return; }
    update({ symbols: [...form.symbols, sym] });
    setSymbolInput("");
  };

  const tradeNotional = form.positionSizeUsdt * form.leverage;

  return (
    <div className={cn("bg-card border rounded-sm transition-colors", form.enabled ? "border-border/60" : "border-border/30 opacity-60")}>
      {/* Preset header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <Switch
          checked={form.enabled}
          onCheckedChange={v => { onToggle(preset.id, v); }}
          className="h-4 w-7"
        />
        <button
          onClick={() => setExpanded(e => !e)}
          className="flex-1 flex items-center gap-2 text-left"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
          <span className="font-semibold text-sm">{preset.name}</span>
          <div className="flex items-center gap-1.5 ml-2 flex-wrap">
            <Badge variant="outline" className="text-[9px] px-1.5 h-4 font-mono">${preset.positionSizeUsdt} × {preset.leverage}x</Badge>
            {!preset.averagingEnabled && <Badge variant="outline" className="text-[9px] px-1.5 h-4 font-mono text-destructive border-destructive/30">SL ${preset.stopLossUsdt}</Badge>}
            <Badge variant="outline" className="text-[9px] px-1.5 h-4 font-mono text-chart-1 border-chart-1/30">TP ${preset.takeProfitUsdt}</Badge>
            {preset.strategies.slice(0, 3).map(s => (
              <Badge key={s} variant="outline" className="text-[9px] px-1.5 h-4 font-mono bg-accent/30">
                {STRATEGY_OPTIONS.find(o => o.id === s)?.label.split(" ")[0] ?? s}
              </Badge>
            ))}
            <span className="text-[10px] text-muted-foreground">{preset.symbols.length} symbols</span>
          </div>
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
          onClick={() => onDelete(preset.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {expanded && (
        <div className="border-t border-border/60 p-4 space-y-5">
          {/* Name */}
          <div>
            <Label className="text-[10px] text-muted-foreground mb-1.5 block uppercase tracking-widest">Preset name</Label>
            <Input
              className="h-7 text-xs font-mono max-w-xs"
              value={form.name}
              onChange={e => update({ name: e.target.value })}
            />
          </div>

          {/* ── Money management ────────────────────────────────────── */}
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">Money Management</div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div>
                <Label className="text-[10px] text-muted-foreground mb-1 block">Position size (USDT)</Label>
                <Input
                  className="h-7 text-xs font-mono"
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={form.positionSizeUsdt}
                  onChange={e => update({ positionSizeUsdt: parseFloat(e.target.value) || 0 })}
                />
                <p className="text-[9px] text-muted-foreground mt-0.5">Margin per trade</p>
              </div>
              {!form.averagingEnabled && (
              <div>
                <Label className="text-[10px] text-muted-foreground mb-1 block">Stop Loss (USDT)</Label>
                <Input
                  className={cn("h-7 text-xs font-mono", form.stopLossUsdt <= 0 ? "border-destructive/40" : "")}
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={form.stopLossUsdt}
                  onChange={e => update({ stopLossUsdt: parseFloat(e.target.value) || 0 })}
                />
                <p className="text-[9px] text-muted-foreground mt-0.5">Max loss per trade</p>
              </div>
              )}
              <div>
                <Label className="text-[10px] text-muted-foreground mb-1 block">Take Profit (USDT)</Label>
                <Input
                  className="h-7 text-xs font-mono border-chart-1/40"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={form.takeProfitUsdt}
                  onChange={e => update({ takeProfitUsdt: parseFloat(e.target.value) || 0 })}
                />
                <p className="text-[9px] text-muted-foreground mt-0.5">Target profit per trade</p>
              </div>
              <div>
                <Label className="text-[10px] text-muted-foreground mb-1 block">Max positions</Label>
                <Input
                  className="h-7 text-xs font-mono"
                  type="number"
                  min={1}
                  max={20}
                  value={form.maxPositions}
                  onChange={e => update({ maxPositions: parseInt(e.target.value) || 1 })}
                />
                <p className="text-[9px] text-muted-foreground mt-0.5">For this preset</p>
              </div>
            </div>

            {/* Leverage */}
            <div className="mt-3">
              <Label className="text-[10px] text-muted-foreground mb-1.5 block">Leverage</Label>
              <div className="flex flex-wrap gap-1.5">
                {LEVERAGE_OPTIONS.map(lev => (
                  <button
                    key={lev}
                    onClick={() => update({ leverage: lev })}
                    className={cn(
                      "h-6 px-2.5 text-[10px] font-mono rounded-sm border transition-colors",
                      form.leverage === lev
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-accent/30 text-muted-foreground border-border/60 hover:border-primary/40"
                    )}
                  >
                    {lev}×
                  </button>
                ))}
              </div>
              <p className="text-[9px] text-muted-foreground mt-1">
                Notional = ${form.positionSizeUsdt} × {form.leverage}x = <span className="text-foreground font-mono">${tradeNotional.toFixed(2)}</span>
                {form.leverage >= 20 && <span className="text-destructive ml-2">⚠ High leverage = high risk</span>}
              </p>
            </div>

            {/* Averaging */}
            <div className="mt-3 border border-border/40 rounded-sm p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Switch
                  checked={form.averagingEnabled}
                  onCheckedChange={v => update({ averagingEnabled: v })}
                  className="h-4 w-7"
                />
                <Label className="text-xs cursor-pointer">Averaging (DCA)</Label>
              </div>
              {form.averagingEnabled && (
                <div className="grid grid-cols-3 gap-3 pt-1">
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1 block">Avg. amount (USDT)</Label>
                    <Input
                      className="h-7 text-xs font-mono"
                      type="number"
                      min={0.01}
                      step={0.01}
                      value={form.averagingAmountUsdt}
                      onChange={e => update({ averagingAmountUsdt: parseFloat(e.target.value) || 0 })}
                    />
                    <p className="text-[9px] text-muted-foreground mt-0.5">Margin for avg entry</p>
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1 block">Trigger (% to SL)</Label>
                    <Input
                      className="h-7 text-xs font-mono"
                      type="number"
                      min={10}
                      max={99}
                      value={form.averagingThresholdPercent}
                      onChange={e => update({ averagingThresholdPercent: parseFloat(e.target.value) || 80 })}
                    />
                    <p className="text-[9px] text-muted-foreground mt-0.5">% of SL distance</p>
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1 block">Max avg entries</Label>
                    <Input
                      className="h-7 text-xs font-mono"
                      type="number"
                      min={1}
                      max={5}
                      value={form.maxAveragingCount}
                      onChange={e => update({ maxAveragingCount: parseInt(e.target.value) || 1 })}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── Symbols ─────────────────────────────────────────────── */}
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">Trading Symbols</div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {form.symbols.map(sym => (
                <button
                  key={sym}
                  onClick={() => toggleSymbol(sym)}
                  className={cn(
                    "h-6 px-2 text-[10px] font-mono rounded-sm border flex items-center gap-1 transition-colors",
                    form.symbols.includes(sym)
                      ? "bg-primary/10 text-primary border-primary/40"
                      : "bg-accent/30 text-muted-foreground border-border/60"
                  )}
                >
                  {sym.replace("USDT", "")}
                  <X className="h-2.5 w-2.5 opacity-50" />
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1 mb-2">
              {ALL_SYMBOLS.filter(s => !form.symbols.includes(s)).map(sym => (
                <button
                  key={sym}
                  onClick={() => toggleSymbol(sym)}
                  className="h-5 px-1.5 text-[9px] font-mono rounded-sm border border-border/40 text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors"
                >
                  + {sym.replace("USDT", "")}
                </button>
              ))}
            </div>
            <div className="flex gap-2 mt-1">
              <Input
                className="h-7 text-xs font-mono max-w-[160px]"
                placeholder="Custom (e.g. WLDUSDT)"
                value={symbolInput}
                onChange={e => setSymbolInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addCustomSymbol()}
              />
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addCustomSymbol}>Add</Button>
            </div>
          </div>

          {/* ── Strategies & combination ──────────────────────────── */}
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">Signal Strategies</div>
            <div className="space-y-2 mb-3">
              {STRATEGY_OPTIONS.map(s => (
                <div
                  key={s.id}
                  onClick={() => toggleStrategy(s.id)}
                  className={cn(
                    "flex items-start gap-3 p-2.5 rounded-sm border cursor-pointer transition-colors",
                    form.strategies.includes(s.id)
                      ? "bg-primary/5 border-primary/30"
                      : "border-border/40 hover:border-border"
                  )}
                >
                  <Checkbox
                    checked={form.strategies.includes(s.id)}
                    onCheckedChange={() => toggleStrategy(s.id)}
                    onClick={e => e.stopPropagation()}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="text-xs font-medium">{s.label}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Strategy combination mode */}
            {form.strategies.length > 1 && (
              <div className="flex items-center gap-3">
                <Label className="text-[10px] text-muted-foreground">Combination mode:</Label>
                {(["OR", "AND"] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => update({ strategyMode: m })}
                    className={cn(
                      "h-6 px-3 text-[10px] font-mono rounded-sm border transition-colors",
                      form.strategyMode === m
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-accent/30 text-muted-foreground border-border/60 hover:border-primary/40"
                    )}
                  >
                    {m}
                  </button>
                ))}
                <span className="text-[10px] text-muted-foreground">
                  {form.strategyMode === "OR"
                    ? "— any one strategy fires"
                    : "— all strategies must agree"}
                </span>
              </div>
            )}
          </div>

          {/* ── Indicator parameters (per selected strategy) ──────── */}
          <div className="space-y-3">
            {form.strategies.includes("volume_profile") && (
              <div className="border border-border/40 rounded-sm p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">Volume Profile</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1 block">Lookback bars (1H)</Label>
                    <Input className="h-7 text-xs font-mono" type="number" min={20} max={500}
                      value={form.volumeProfileParams?.lookbackBars ?? 100}
                      onChange={e => updateNested("volumeProfileParams", { lookbackBars: parseInt(e.target.value) })} />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1 block">POC tolerance (%)</Label>
                    <Input className="h-7 text-xs font-mono" type="number" step={0.1} min={0.1} max={5}
                      value={((form.volumeProfileParams?.pocTolerance ?? 0.005) * 100).toFixed(1)}
                      onChange={e => updateNested("volumeProfileParams", { pocTolerance: parseFloat(e.target.value) / 100 })} />
                  </div>
                </div>
              </div>
            )}

            {form.strategies.includes("fibonacci") && (
              <div className="border border-border/40 rounded-sm p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">Fibonacci Retracement</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1 block">Entry level</Label>
                    <Input className="h-7 text-xs font-mono" type="number" step={0.001} min={0.1} max={0.99}
                      value={form.fibonacciParams?.entryLevel ?? 0.618}
                      onChange={e => updateNested("fibonacciParams", { entryLevel: parseFloat(e.target.value) })} />
                    <p className="text-[9px] text-muted-foreground mt-0.5">e.g. 0.618 or 0.5</p>
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1 block">SL level</Label>
                    <Input className="h-7 text-xs font-mono" type="number" step={0.001} min={0.1} max={0.99}
                      value={form.fibonacciParams?.slLevel ?? 0.786}
                      onChange={e => updateNested("fibonacciParams", { slLevel: parseFloat(e.target.value) })} />
                    <p className="text-[9px] text-muted-foreground mt-0.5">e.g. 0.786 or 1.0</p>
                  </div>
                </div>
                <p className="text-[9px] text-muted-foreground mt-2">
                  Enters when price is within ±0.5% of the entry level on a qualifying 1H swing (≥5% rise in ≤20 bars, above-avg volume). SL/TP amounts from money management above.
                </p>
              </div>
            )}

            {form.strategies.includes("order_blocks") && (
              <div className="border border-border/40 rounded-sm p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">Order Blocks</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1 block">Lookback bars (1H)</Label>
                    <Input className="h-7 text-xs font-mono" type="number" min={10} max={200}
                      value={form.orderBlockParams?.lookbackBars ?? 50}
                      onChange={e => updateNested("orderBlockParams", { lookbackBars: parseInt(e.target.value) })} />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1 block">Min impulse (%)</Label>
                    <Input className="h-7 text-xs font-mono" type="number" step={0.1} min={0.1}
                      value={form.orderBlockParams?.minImpulsePercent ?? 1.5}
                      onChange={e => updateNested("orderBlockParams", { minImpulsePercent: parseFloat(e.target.value) })} />
                  </div>
                </div>
              </div>
            )}

            {form.strategies.includes("rsi") && (
              <div className="border border-border/40 rounded-sm p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">RSI</div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1 block">Period</Label>
                    <Input className="h-7 text-xs font-mono" type="number" min={2} max={50}
                      value={form.rsiParams?.period ?? 14}
                      onChange={e => updateNested("rsiParams", { period: parseInt(e.target.value) })} />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1 block">Oversold</Label>
                    <Input className="h-7 text-xs font-mono" type="number" min={5} max={45}
                      value={form.rsiParams?.oversoldLevel ?? 30}
                      onChange={e => updateNested("rsiParams", { oversoldLevel: parseInt(e.target.value) })} />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1 block">Overbought</Label>
                    <Input className="h-7 text-xs font-mono" type="number" min={55} max={95}
                      value={form.rsiParams?.overboughtLevel ?? 70}
                      onChange={e => updateNested("rsiParams", { overboughtLevel: parseInt(e.target.value) })} />
                  </div>
                </div>
              </div>
            )}

            {form.strategies.includes("liquidation") && (
              <div className="border border-border/40 rounded-sm p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">Liquidation Sweep</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] font-mono">
                  <span className="opacity-60">Cluster filter</span><span>top 10% by USD size (24h)</span>
                  <span className="opacity-60">Entry signal</span><span>sweep + reversal close + body ≥60%/≤40%</span>
                  <span className="opacity-60">Data source</span><span>Bybit WS liquidation topic (live)</span>
                </div>
                <p className="text-[9px] text-muted-foreground mt-2">No configurable params. SL/TP from money management above. Signals appear after ~1–4 h of accumulation.</p>
              </div>
            )}
          </div>

          {/* ── Timeframe ─────────────────────────────────────────── */}
          <div>
            <Label className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1.5 block">Bot scan timeframe</Label>
            <div className="flex gap-1.5">
              {TIMEFRAME_OPTIONS.map(tf => (
                <button
                  key={tf.value}
                  onClick={() => update({ timeframe: tf.value })}
                  className={cn(
                    "h-6 px-2.5 text-[10px] font-mono rounded-sm border transition-colors",
                    form.timeframe === tf.value
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-accent/30 text-muted-foreground border-border/60 hover:border-primary/40"
                  )}
                >
                  {tf.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Save button ───────────────────────────────────────── */}
          {dirty && (
            <div className="flex items-center gap-3 pt-1 border-t border-border/40">
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={() => { onSave(preset.id, form); setDirty(false); }}
              >
                Save Preset
              </Button>
              <button
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => { setForm({ ...preset }); setDirty(false); }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Strategy() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: config, isLoading: configLoading } = useGetBotConfig({ query: { queryKey: getGetBotConfigQueryKey() } });
  const { data: balance } = useGetBalance({ query: { refetchInterval: 30000, queryKey: getGetBalanceQueryKey() } });
  const { data: presets, isLoading: presetsLoading } = useListStrategyPresets({ query: { queryKey: getListStrategyPresetsQueryKey(), refetchInterval: 5000 } });

  const updateConfig = useUpdateBotConfig();
  const createPreset = useCreateStrategyPreset();
  const updatePreset = useUpdateStrategyPreset();
  const deletePreset = useDeleteStrategyPreset();

  const [mode, setMode] = useState<"paper" | "live">("paper");

  useEffect(() => {
    if (config) setMode(config.mode as "paper" | "live");
  }, [config]);

  const wsConnected = (config as any)?.wsConnected ?? false;
  const liveBalance = balance?.liveEquity ?? balance?.liveBalance ?? null;
  const paperBalance = balance?.paperBalance ?? 0;

  const handleSavePreset = async (id: number, data: Partial<Preset>) => {
    try {
      await updatePreset.mutateAsync({ id, data: data as any });
      qc.invalidateQueries({ queryKey: getListStrategyPresetsQueryKey() });
      toast({ title: "Saved", description: `Preset "${data.name}" updated` });
    } catch {
      toast({ title: "Error", description: "Failed to save preset", variant: "destructive" });
    }
  };

  const handleTogglePreset = async (id: number, enabled: boolean) => {
    try {
      await updatePreset.mutateAsync({ id, data: { enabled } as any });
      qc.invalidateQueries({ queryKey: getListStrategyPresetsQueryKey() });
    } catch {
      toast({ title: "Error", description: "Failed to toggle preset", variant: "destructive" });
    }
  };

  const handleDeletePreset = async (id: number) => {
    if (!confirm("Delete this strategy preset?")) return;
    try {
      await deletePreset.mutateAsync({ id });
      qc.invalidateQueries({ queryKey: getListStrategyPresetsQueryKey() });
      toast({ title: "Deleted" });
    } catch {
      toast({ title: "Error", description: "Failed to delete preset", variant: "destructive" });
    }
  };

  const handleCreatePreset = async () => {
    try {
      await createPreset.mutateAsync({ data: DEFAULT_PRESET() as any });
      qc.invalidateQueries({ queryKey: getListStrategyPresetsQueryKey() });
      toast({ title: "Created", description: "New strategy preset added — edit it below" });
    } catch {
      toast({ title: "Error", description: "Failed to create preset", variant: "destructive" });
    }
  };

  const handleSaveMode = async (newMode: "paper" | "live") => {
    try {
      await updateConfig.mutateAsync({ data: { mode: newMode } as any });
      qc.invalidateQueries({ queryKey: getGetBotConfigQueryKey() });
      setMode(newMode);
      toast({ title: `Switched to ${newMode.toUpperCase()} mode` });
    } catch {
      toast({ title: "Error", variant: "destructive" });
    }
  };

  return (
    <Layout>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Strategy Presets</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Each preset runs independently with its own symbols, conditions, and money management
            </p>
          </div>
          <div className="flex items-center gap-2">
            {wsConnected
              ? <Badge variant="outline" className="text-[10px] gap-1 text-chart-1 border-chart-1/40"><Wifi className="h-3 w-3" /> WS LIVE</Badge>
              : <Badge variant="outline" className="text-[10px] gap-1 text-muted-foreground"><WifiOff className="h-3 w-3" /> WS OFF</Badge>
            }
          </div>
        </div>

        {/* Global: Mode + Balance */}
        <div className="bg-card border border-border/60 rounded-sm p-4">
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-3">Global Settings</div>
          <div className="flex items-center gap-6 flex-wrap">
            {/* Mode toggle */}
            <div>
              <Label className="text-[10px] text-muted-foreground mb-1.5 block">Trading mode</Label>
              <div className="flex gap-1.5">
                {(["paper", "live"] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => handleSaveMode(m)}
                    className={cn(
                      "h-7 px-4 text-xs font-mono rounded-sm border transition-colors",
                      mode === m
                        ? m === "live" ? "bg-chart-1 text-black border-chart-1" : "bg-primary text-primary-foreground border-primary"
                        : "bg-accent/30 text-muted-foreground border-border/60 hover:border-primary/40"
                    )}
                  >
                    {m.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Balance display */}
            {mode === "paper" && (
              <div className="flex items-center gap-2">
                <Wallet className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Paper:</span>
                <span className="font-mono text-sm font-semibold">${paperBalance.toFixed(2)} USDT</span>
              </div>
            )}
            {mode === "live" && liveBalance !== null && (
              <div className="flex items-center gap-2">
                <Wallet className="h-4 w-4 text-chart-1" />
                <span className="text-xs text-muted-foreground">Equity:</span>
                <span className="font-mono text-sm font-semibold text-chart-1">${liveBalance.toFixed(2)} USDT</span>
              </div>
            )}

            <p className="text-[10px] text-muted-foreground ml-auto">
              Mode applies to all presets simultaneously
            </p>
          </div>
        </div>

        {/* Preset list */}
        <div className="space-y-2">
          {presetsLoading || configLoading ? (
            [1, 2].map(i => <Skeleton key={i} className="h-12 w-full bg-accent" />)
          ) : !presets?.length ? (
            <div className="bg-card border border-border/60 rounded-sm p-12 text-center">
              <p className="text-sm text-muted-foreground">No strategy presets yet</p>
              <p className="text-xs text-muted-foreground mt-1">Create your first preset to start automated trading</p>
              <Button size="sm" className="mt-4 gap-1.5" onClick={handleCreatePreset}>
                <Plus className="h-3.5 w-3.5" />
                Create First Preset
              </Button>
            </div>
          ) : (
            presets.map(p => (
              <PresetCard
                key={p.id}
                preset={p as Preset}
                onSave={handleSavePreset}
                onDelete={handleDeletePreset}
                onToggle={handleTogglePreset}
              />
            ))
          )}
        </div>

        {presets && presets.length > 0 && (
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={handleCreatePreset}>
            <Plus className="h-3.5 w-3.5" />
            Add Another Preset
          </Button>
        )}
      </div>
    </Layout>
  );
}

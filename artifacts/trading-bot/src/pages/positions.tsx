import { useState } from "react";
import { Layout } from "@/components/layout";
import {
  useListPositions,
  useClosePosition,
  useOpenPosition,
  getListPositionsQueryKey,
  getGetBotStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { Plus, X } from "lucide-react";

function OpenPositionDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const openPosition = useOpenPosition();
  const [form, setForm] = useState({ symbol: "BTCUSDT", side: "long" as "long" | "short", quantity: "0.001", leverage: "5", mode: "paper" as "paper" | "live", stopLoss: "", takeProfit: "" });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    openPosition.mutate({ data: { symbol: form.symbol, side: form.side, quantity: parseFloat(form.quantity), leverage: parseInt(form.leverage), mode: form.mode, stopLoss: form.stopLoss ? parseFloat(form.stopLoss) : undefined, takeProfit: form.takeProfit ? parseFloat(form.takeProfit) : undefined } }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListPositionsQueryKey({}) });
        toast({ title: "Position opened" });
        onClose();
      },
      onError: () => toast({ title: "Failed to open position", variant: "destructive" }),
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Symbol</Label>
          <Select value={form.symbol} onValueChange={v => setForm(f => ({ ...f, symbol: v }))}>
            <SelectTrigger className="h-8 text-xs font-mono"><SelectValue /></SelectTrigger>
            <SelectContent>{["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"].map(s => <SelectItem key={s} value={s} className="font-mono text-xs">{s}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Side</Label>
          <Select value={form.side} onValueChange={v => setForm(f => ({ ...f, side: v as "long" | "short" }))}>
            <SelectTrigger className="h-8 text-xs font-mono"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="long" className="text-xs font-mono">LONG</SelectItem>
              <SelectItem value="short" className="text-xs font-mono">SHORT</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Quantity</Label>
          <Input className="h-8 text-xs font-mono" value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} required />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Leverage</Label>
          <Input className="h-8 text-xs font-mono" type="number" min={1} max={100} value={form.leverage} onChange={e => setForm(f => ({ ...f, leverage: e.target.value }))} required />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Mode</Label>
          <Select value={form.mode} onValueChange={v => setForm(f => ({ ...f, mode: v as "paper" | "live" }))}>
            <SelectTrigger className="h-8 text-xs font-mono"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="paper" className="text-xs font-mono">PAPER</SelectItem>
              <SelectItem value="live" className="text-xs font-mono">LIVE</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Stop Loss (optional)</Label>
          <Input className="h-8 text-xs font-mono" placeholder="Price" value={form.stopLoss} onChange={e => setForm(f => ({ ...f, stopLoss: e.target.value }))} />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Take Profit (optional)</Label>
          <Input className="h-8 text-xs font-mono" placeholder="Price" value={form.takeProfit} onChange={e => setForm(f => ({ ...f, takeProfit: e.target.value }))} />
        </div>
      </div>
      <Button type="submit" disabled={openPosition.isPending} className="w-full h-8 text-xs bg-chart-1 hover:bg-chart-1/80 text-background font-mono">
        {openPosition.isPending ? "Opening..." : "Open Position"}
      </Button>
    </form>
  );
}

export default function Positions() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "paper" | "live">("all");
  const { data: positions, isLoading } = useListPositions(
    { mode: filter === "all" ? undefined : filter },
    { query: { refetchInterval: 10000, queryKey: getListPositionsQueryKey({ mode: filter === "all" ? undefined : filter }) } }
  );
  const closePosition = useClosePosition();

  const handleClose = (id: number) => {
    closePosition.mutate({ id }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListPositionsQueryKey({}) });
        qc.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        toast({ title: "Position closed" });
      },
      onError: () => toast({ title: "Failed to close position", variant: "destructive" }),
    });
  };

  return (
    <Layout>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Positions</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Open positions — live P&L updates every 10s</p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={filter} onValueChange={v => setFilter(v as any)}>
              <SelectTrigger className="h-7 text-xs font-mono w-24"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs font-mono">ALL</SelectItem>
                <SelectItem value="paper" className="text-xs font-mono">PAPER</SelectItem>
                <SelectItem value="live" className="text-xs font-mono">LIVE</SelectItem>
              </SelectContent>
            </Select>
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="h-7 text-xs bg-chart-1 hover:bg-chart-1/80 text-background font-mono gap-1 rounded-sm">
                  <Plus className="w-3 h-3" /> Open
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-sm">
                <DialogHeader><DialogTitle className="text-sm font-mono">Open Position</DialogTitle></DialogHeader>
                <OpenPositionDialog onClose={() => setDialogOpen(false)} />
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className="bg-card border border-border/60 rounded-sm overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-12 w-full bg-accent" />)}</div>
          ) : !positions?.length ? (
            <div className="p-16 text-center">
              <p className="text-sm text-muted-foreground">No open positions</p>
              <p className="text-xs text-muted-foreground mt-1">Start the bot or open a manual position</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-border/60 text-muted-foreground text-[10px] uppercase tracking-widest">
                    <th className="text-left px-4 py-2.5">Symbol</th>
                    <th className="text-left px-3 py-2.5">Side</th>
                    <th className="text-right px-3 py-2.5">Entry</th>
                    <th className="text-right px-3 py-2.5">Current</th>
                    <th className="text-right px-3 py-2.5">Qty</th>
                    <th className="text-right px-3 py-2.5">Lev</th>
                    <th className="text-right px-3 py-2.5">P&L</th>
                    <th className="text-right px-3 py-2.5">P&L%</th>
                    <th className="text-left px-3 py-2.5">Strategy</th>
                    <th className="text-left px-3 py-2.5">Mode</th>
                    <th className="text-left px-3 py-2.5">Opened</th>
                    <th className="px-3 py-2.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {positions.map(p => (
                    <tr key={p.id} className="hover:bg-accent/30 transition-colors">
                      <td className="px-4 py-3 font-semibold">{p.symbol}</td>
                      <td className="px-3 py-3">
                        <Badge className={cn("text-[9px] px-1.5 h-4 rounded-sm", p.side === "long" ? "bg-chart-1/10 text-chart-1 border-chart-1/30" : "bg-destructive/10 text-destructive border-destructive/30")} variant="outline">
                          {p.side.toUpperCase()}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 text-right">${parseFloat(String(p.entryPrice)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td className="px-3 py-3 text-right">${parseFloat(String(p.currentPrice)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td className="px-3 py-3 text-right">{parseFloat(String(p.quantity)).toFixed(4)}</td>
                      <td className="px-3 py-3 text-right">{p.leverage}x</td>
                      <td className={cn("px-3 py-3 text-right font-bold", p.unrealizedPnl >= 0 ? "text-chart-1" : "text-destructive")}>
                        {p.unrealizedPnl >= 0 ? "+" : ""}${parseFloat(String(p.unrealizedPnl)).toFixed(2)}
                      </td>
                      <td className={cn("px-3 py-3 text-right", p.unrealizedPnlPercent >= 0 ? "text-chart-1" : "text-destructive")}>
                        {p.unrealizedPnlPercent >= 0 ? "+" : ""}{parseFloat(String(p.unrealizedPnlPercent)).toFixed(2)}%
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">{p.strategy}</td>
                      <td className="px-3 py-3">
                        <Badge variant="outline" className="text-[9px] px-1.5 h-4 rounded-sm">{p.mode.toUpperCase()}</Badge>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground text-[10px]">{formatDistanceToNow(new Date(p.openedAt), { addSuffix: true })}</td>
                      <td className="px-3 py-3">
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 hover:bg-destructive/20 hover:text-destructive" onClick={() => handleClose(p.id)} disabled={closePosition.isPending}>
                          <X className="w-3 h-3" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}

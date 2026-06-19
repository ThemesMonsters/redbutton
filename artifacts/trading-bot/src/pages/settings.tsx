import { useState, useEffect } from "react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Trash2, XCircle, RefreshCw, DollarSign, Loader2, Key, Eye, EyeOff, CheckCircle, XIcon, Wallet, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

import {
  useGetSettingsStats,
  getGetSettingsStatsQueryKey,
  useResetTradeHistory,
  useResetOpenPositions,
  useResetAll,
  useResetPaperBalance,
  useGetApiKeyStatus,
  getGetApiKeyStatusQueryKey,
  useSaveApiKeys,
  useDeleteApiKeys,
} from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

type ConfirmTarget = "trades" | "positions" | "all" | "balance" | "deleteKeys" | null;

export default function SettingsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<ConfirmTarget>(null);

  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiSecretInput, setApiSecretInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const [liveBalanceInput, setLiveBalanceInput] = useState("");
  const [liveBalanceSaving, setLiveBalanceSaving] = useState(false);

  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseResult, setDiagnoseResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function runDiagnose() {
    setDiagnosing(true);
    setDiagnoseResult(null);
    try {
      const prep = await fetch(`${BASE}/api/settings/api-keys/diagnose-request`);
      if (!prep.ok) { setDiagnoseResult({ ok: false, text: "Server error preparing request" }); return; }
      const { walletRequest, accountInfoRequest, queryApiRequest } = await prep.json();

      const [walletResp, infoResp, queryApiResp] = await Promise.all([
        fetch(walletRequest.url, { method: walletRequest.method, headers: walletRequest.headers }),
        fetch(accountInfoRequest.url, { method: accountInfoRequest.method, headers: accountInfoRequest.headers }),
        fetch(queryApiRequest.url, { method: queryApiRequest.method, headers: queryApiRequest.headers }),
      ]);
      const [walletJson, infoJson, queryApiJson] = await Promise.all([
        walletResp.json(), infoResp.json(), queryApiResp.json(),
      ]);

      const lines: string[] = [];

      if (walletJson.retCode === 0) {
        const coins: Array<{ coin: string; walletBalance: string }> = walletJson.result?.list?.[0]?.coin ?? [];
        const usdt = coins.find(c => c.coin === "USDT");
        const accountType = walletJson.result?.list?.[0]?.accountType ?? "UNKNOWN";
        lines.push(`Account: ${accountType}`);
        lines.push(`USDT: $${usdt ? parseFloat(usdt.walletBalance).toFixed(2) : "0.00"}`);
      } else {
        lines.push(`Wallet ${walletJson.retCode}: ${walletJson.retMsg}`);
      }

      if (infoJson.retCode === 0) {
        const info = infoJson.result ?? {};
        lines.push(`Margin: ${info.marginMode ?? "?"}`);
        lines.push(`UTA status: ${info.unifiedMarginStatus ?? "?"}`);
      } else {
        lines.push(`Info error ${infoJson.retCode}: ${infoJson.retMsg}`);
      }

      if (queryApiJson.retCode === 0) {
        const r = queryApiJson.result ?? {};
        const perms: string[] = r.permissions ? Object.entries(r.permissions as Record<string, string[]>)
          .filter(([, v]) => v.length > 0)
          .map(([k, v]) => `${k}:[${v.join(",")}]`) : [];
        lines.push(`Key permissions: ${perms.length ? perms.join(" ") : "none"}`);
        lines.push(`Read-only: ${r.readOnly ?? "?"}`);
      } else {
        lines.push(`Key query ${queryApiJson.retCode}: ${queryApiJson.retMsg}`);
      }

      const hasError = walletJson.retCode !== 0 || infoJson.retCode !== 0 || queryApiJson.retCode !== 0;
      setDiagnoseResult({ ok: !hasError, text: lines.join("  |  ") });
    } catch (e: any) {
      setDiagnoseResult({ ok: false, text: e?.message ?? "Network error" });
    } finally {
      setDiagnosing(false);
    }
  }

  useEffect(() => {
    fetch(`${BASE}/api/settings/live-balance`)
      .then(r => r.json())
      .then(d => { if (d.liveInitialBalance > 0) setLiveBalanceInput(String(d.liveInitialBalance)); })
      .catch(() => {});
  }, []);

  const { data: stats, refetch: refetchStats } = useGetSettingsStats({
    query: { queryKey: getGetSettingsStatsQueryKey(), refetchInterval: 10_000 },
  });

  const { data: apiKeyStatus, refetch: refetchApiStatus } = useGetApiKeyStatus({
    query: { queryKey: getGetApiKeyStatusQueryKey(), refetchInterval: 15_000 },
  });

  const invalidateAll = () => queryClient.invalidateQueries();

  const resetTrades = useResetTradeHistory({
    mutation: {
      onSuccess: (data) => { toast({ title: "Trade history cleared", description: data.message }); setConfirm(null); invalidateAll(); refetchStats(); },
      onError: () => { toast({ title: "Error", description: "Failed to reset trade history", variant: "destructive" }); setConfirm(null); },
    },
  });

  const resetPositions = useResetOpenPositions({
    mutation: {
      onSuccess: (data) => { toast({ title: "Positions closed", description: data.message }); setConfirm(null); invalidateAll(); refetchStats(); },
      onError: () => { toast({ title: "Error", description: "Failed to close positions", variant: "destructive" }); setConfirm(null); },
    },
  });

  const resetAllData = useResetAll({
    mutation: {
      onSuccess: (data) => { toast({ title: "All data reset", description: data.message }); setConfirm(null); invalidateAll(); refetchStats(); },
      onError: () => { toast({ title: "Error", description: "Failed to reset all data", variant: "destructive" }); setConfirm(null); },
    },
  });

  const resetBalance = useResetPaperBalance({
    mutation: {
      onSuccess: (data) => { toast({ title: "Balance reset", description: data.message }); setConfirm(null); invalidateAll(); },
      onError: () => { toast({ title: "Error", description: "Failed to reset balance", variant: "destructive" }); setConfirm(null); },
    },
  });

  const saveKeys = useSaveApiKeys({
    mutation: {
      onSuccess: () => {
        toast({ title: "API keys saved", description: "Bybit API keys are now active" });
        setApiKeyInput("");
        setApiSecretInput("");
        refetchApiStatus();
        invalidateAll();
      },
      onError: () => toast({ title: "Error", description: "Failed to save API keys", variant: "destructive" }),
    },
  });

  const deleteKeys = useDeleteApiKeys({
    mutation: {
      onSuccess: () => {
        toast({ title: "API keys removed", description: "Bybit API keys have been deleted from the database" });
        setConfirm(null);
        refetchApiStatus();
        invalidateAll();
      },
      onError: () => { toast({ title: "Error", description: "Failed to remove API keys", variant: "destructive" }); setConfirm(null); },
    },
  });

  async function saveLiveBalance() {
    const val = parseFloat(liveBalanceInput);
    if (isNaN(val) || val < 0) { toast({ title: "Invalid amount", variant: "destructive" }); return; }
    setLiveBalanceSaving(true);
    try {
      const res = await fetch(`${BASE}/api/settings/live-balance`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ balance: val }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast({ title: "Balance saved", description: data.message });
      queryClient.invalidateQueries();
    } catch {
      toast({ title: "Error", description: "Failed to save balance", variant: "destructive" });
    } finally {
      setLiveBalanceSaving(false);
    }
  }

  const isBusy =
    resetTrades.isPending || resetPositions.isPending ||
    resetAllData.isPending || resetBalance.isPending ||
    saveKeys.isPending || deleteKeys.isPending;

  function handleConfirm() {
    if (confirm === "trades") resetTrades.mutate();
    else if (confirm === "positions") resetPositions.mutate();
    else if (confirm === "all") resetAllData.mutate();
    else if (confirm === "balance") resetBalance.mutate();
    else if (confirm === "deleteKeys") deleteKeys.mutate();
  }

  const confirmMessages: Record<NonNullable<ConfirmTarget>, { title: string; body: string; color: string }> = {
    trades: { title: "Reset Trade History", body: `This will permanently delete all ${stats?.tradeHistory ?? 0} trade records. This action cannot be undone.`, color: "text-destructive" },
    positions: { title: "Close All Open Positions", body: `This will force-close all ${stats?.openPositions ?? 0} open positions without recording a trade. This action cannot be undone.`, color: "text-destructive" },
    all: { title: "Reset Everything", body: `This will close all ${stats?.openPositions ?? 0} open positions AND delete all ${stats?.tradeHistory ?? 0} trade records. This action cannot be undone.`, color: "text-destructive" },
    balance: { title: "Reset Paper Balance", body: "This will reset your paper trading balance back to $10,000 USDT.", color: "text-yellow-400" },
    deleteKeys: { title: "Remove Bybit API Keys", body: "This will delete your stored API key and secret from the database. The bot will revert to paper trading mode.", color: "text-destructive" },
  };

  const keysConfigured = apiKeyStatus?.configured;
  const keysFromEnv = apiKeyStatus?.source === "env";

  return (
    <Layout>
      <div className="max-w-2xl space-y-8">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight">Settings</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage your trading data and configuration.</p>
        </div>

        {/* Bybit API Keys */}
        <section className="border border-border rounded-sm">
          <div className="px-5 py-3 border-b border-border bg-card/50">
            <h2 className="text-sm font-semibold tracking-widest uppercase text-muted-foreground flex items-center gap-2">
              <Key className="w-4 h-4" />
              Bybit API Keys
              {keysConfigured && (
                <span className={cn("ml-auto flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-sm border",
                  keysFromEnv
                    ? "border-chart-4/40 text-chart-4 bg-chart-4/5"
                    : "border-chart-1/40 text-chart-1 bg-chart-1/5"
                )}>
                  <CheckCircle className="w-3 h-3" />
                  {keysFromEnv ? "FROM ENV" : "ACTIVE"}
                </span>
              )}
            </h2>
          </div>

          <div className="p-5 space-y-4">
            {keysFromEnv ? (
              <div className="flex items-start gap-3 px-4 py-3 bg-chart-4/5 border border-chart-4/20 rounded-sm">
                <CheckCircle className="w-4 h-4 text-chart-4 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-chart-4">Keys loaded from environment</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    BYBIT_API_KEY and BYBIT_API_SECRET are set as environment variables. You cannot override them here — update them in Replit Secrets.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Enter your Bybit API key and secret to enable live trading. Keys are stored securely in the database and only used to connect to your Bybit account.
                </p>

                {keysConfigured && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between px-4 py-3 bg-chart-1/5 border border-chart-1/20 rounded-sm">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-3.5 h-3.5 text-chart-1" />
                        <span className="text-xs font-medium text-chart-1">API keys are currently active</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-[10px] gap-1 border-chart-4/40 text-chart-4 hover:bg-chart-4/10"
                          onClick={runDiagnose}
                          disabled={diagnosing || isBusy}
                        >
                          {diagnosing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />}
                          Check Account
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-[10px] gap-1 border-destructive/40 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                          onClick={() => setConfirm("deleteKeys")}
                          disabled={isBusy}
                        >
                          <XIcon className="w-3 h-3" />
                          Remove
                        </Button>
                      </div>
                    </div>
                    {diagnoseResult && (
                      <div className={cn(
                        "flex items-start gap-2 px-4 py-2.5 rounded-sm border text-xs font-mono",
                        diagnoseResult.ok
                          ? "bg-chart-1/5 border-chart-1/30 text-chart-1"
                          : "bg-destructive/5 border-destructive/30 text-destructive"
                      )}>
                        {diagnoseResult.ok
                          ? <CheckCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                          : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
                        <span>{diagnoseResult.text}</span>
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-3">
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1.5 block">API Key</Label>
                    <div className="relative">
                      <Input
                        className="h-8 text-xs font-mono pr-9"
                        type={showKey ? "text" : "password"}
                        placeholder="Enter your Bybit API key"
                        value={apiKeyInput}
                        onChange={e => setApiKeyInput(e.target.value)}
                        autoComplete="off"
                      />
                      <button
                        onClick={() => setShowKey(v => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1.5 block">API Secret</Label>
                    <div className="relative">
                      <Input
                        className="h-8 text-xs font-mono pr-9"
                        type={showSecret ? "text" : "password"}
                        placeholder="Enter your Bybit API secret"
                        value={apiSecretInput}
                        onChange={e => setApiSecretInput(e.target.value)}
                        autoComplete="off"
                      />
                      <button
                        onClick={() => setShowSecret(v => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <p className="text-[10px] text-muted-foreground">
                    Only use API keys with <span className="text-foreground font-mono">Read</span> + <span className="text-foreground font-mono">Trade</span> permissions. No withdrawal access needed.
                  </p>
                  <Button
                    size="sm"
                    className="h-7 text-xs bg-chart-1 hover:bg-chart-1/80 text-background font-mono rounded-sm gap-1.5 ml-3 flex-shrink-0"
                    disabled={!apiKeyInput.trim() || !apiSecretInput.trim() || isBusy}
                    onClick={() => saveKeys.mutate({ data: { apiKey: apiKeyInput, apiSecret: apiSecretInput } })}
                  >
                    {saveKeys.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Key className="w-3 h-3" />}
                    Save Keys
                  </Button>
                </div>
              </>
            )}
          </div>
        </section>

        {/* Live Trading Balance */}
        <section className="border border-border rounded-sm">
          <div className="px-5 py-3 border-b border-border bg-card/50">
            <h2 className="text-sm font-semibold tracking-widest uppercase text-muted-foreground flex items-center gap-2">
              <Wallet className="w-4 h-4" />
              Live Trading
            </h2>
          </div>
          <div className="p-5 space-y-4">
            <p className="text-xs text-muted-foreground">
              Set your current Bybit account balance (USDT). This is used for position sizing until the live balance feed receives its first update.
            </p>
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Label className="text-xs text-muted-foreground mb-1.5 block">Account Balance (USDT)</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-xs font-mono">$</span>
                  <Input
                    className="h-8 text-xs font-mono pl-6"
                    type="number"
                    min="0"
                    step="any"
                    placeholder="e.g. 500"
                    value={liveBalanceInput}
                    onChange={e => setLiveBalanceInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && saveLiveBalance()}
                  />
                </div>
              </div>
              <Button
                size="sm"
                className="h-8 text-xs bg-chart-1 hover:bg-chart-1/80 text-background font-mono rounded-sm gap-1.5 flex-shrink-0"
                disabled={!liveBalanceInput.trim() || liveBalanceSaving}
                onClick={saveLiveBalance}
              >
                {liveBalanceSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                Save
              </Button>
            </div>
          </div>
        </section>

        {/* Paper Trading */}
        <section className="border border-border rounded-sm">
          <div className="px-5 py-3 border-b border-border bg-card/50">
            <h2 className="text-sm font-semibold tracking-widest uppercase text-muted-foreground flex items-center gap-2">
              <DollarSign className="w-4 h-4" />
              Paper Trading
            </h2>
          </div>
          <div className="p-5 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Reset Paper Balance</p>
              <p className="text-xs text-muted-foreground mt-0.5">Restore your virtual starting capital to $10,000 USDT</p>
            </div>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setConfirm("balance")} disabled={isBusy}>
              <RefreshCw className="w-3.5 h-3.5" />
              Reset to $10,000
            </Button>
          </div>
        </section>

        {/* Danger Zone */}
        <section className="border border-destructive/40 rounded-sm">
          <div className="px-5 py-3 border-b border-destructive/40 bg-destructive/5">
            <h2 className="text-sm font-semibold tracking-widest uppercase text-destructive flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              Danger Zone
            </h2>
          </div>
          <div className="divide-y divide-border">
            <div className="p-5 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Reset Trade History</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Delete all <span className="font-mono text-foreground">{stats?.tradeHistory ?? "…"}</span> closed trade records permanently
                </p>
              </div>
              <Button variant="outline" size="sm" className="gap-2 border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground" onClick={() => setConfirm("trades")} disabled={isBusy}>
                <Trash2 className="w-3.5 h-3.5" />
                Clear Trades
              </Button>
            </div>
            <div className="p-5 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Close All Open Positions</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Force-close all <span className="font-mono text-foreground">{stats?.openPositions ?? "…"}</span> open positions without recording trades
                </p>
              </div>
              <Button variant="outline" size="sm" className="gap-2 border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground" onClick={() => setConfirm("positions")} disabled={isBusy}>
                <XCircle className="w-3.5 h-3.5" />
                Close All
              </Button>
            </div>
            <div className="p-5 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Reset Everything</p>
                <p className="text-xs text-muted-foreground mt-0.5">Close all positions + wipe all trade history in one action</p>
              </div>
              <Button variant="destructive" size="sm" className="gap-2" onClick={() => setConfirm("all")} disabled={isBusy}>
                <Trash2 className="w-3.5 h-3.5" />
                Reset All Data
              </Button>
            </div>
          </div>
        </section>
      </div>

      {/* Confirmation Modal */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-sm shadow-xl w-full max-w-md mx-4 p-6 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className={cn("w-5 h-5 mt-0.5 flex-shrink-0", confirmMessages[confirm].color)} />
              <div>
                <h3 className="font-semibold text-base">{confirmMessages[confirm].title}</h3>
                <p className="text-sm text-muted-foreground mt-1">{confirmMessages[confirm].body}</p>
              </div>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <Button variant="outline" size="sm" onClick={() => setConfirm(null)} disabled={isBusy}>Cancel</Button>
              <Button
                variant={confirm === "balance" ? "default" : "destructive"}
                size="sm"
                onClick={handleConfirm}
                disabled={isBusy}
                className="gap-2 min-w-[100px]"
              >
                {isBusy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Working…</> : "Confirm"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}

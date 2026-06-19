import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { Activity, BarChart2, Briefcase, Settings, Layers, SlidersHorizontal, Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGetBotStatus } from "@workspace/api-client-react";
import { useBalanceSync } from "@/hooks/useBalanceSync";
import { useLiveOrderRelay } from "@/hooks/useLiveOrderRelay";

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { data: status } = useGetBotStatus({ query: { refetchInterval: 5000, queryKey: ["getBotStatus"] } });
  useBalanceSync();
  useLiveOrderRelay();

  const navItems = [
    { href: "/", label: "Dashboard", icon: Activity },
    { href: "/positions", label: "Positions", icon: Briefcase },
    { href: "/trades", label: "Trades", icon: Layers },
    { href: "/analytics", label: "Analytics", icon: BarChart2 },
    { href: "/strategy", label: "Strategy", icon: Settings },
    { href: "/settings", label: "Settings", icon: SlidersHorizontal },
  ];

  const SidebarContent = ({ onNav }: { onNav?: () => void }) => (
    <>
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-primary text-primary-foreground flex items-center justify-center font-bold text-lg rounded-sm">
            C
          </div>
          <span className="font-bold text-xl tracking-tight">CryptoBot</span>
        </div>
        {onNav && (
          <button onClick={onNav} className="md:hidden text-muted-foreground hover:text-foreground p-1">
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      <div className="p-4 border-b border-border flex flex-col gap-2">
        <div className="flex justify-between items-center text-sm">
          <span className="text-muted-foreground">Status</span>
          <div className="flex items-center gap-2">
            <span className={cn("w-2 h-2 rounded-full", status?.running ? "bg-primary" : "bg-destructive animate-pulse")} />
            <span className="font-mono">{status?.running ? "RUNNING" : "STOPPED"}</span>
          </div>
        </div>
        <div className="flex justify-between items-center text-sm">
          <span className="text-muted-foreground">Mode</span>
          <span className="font-mono text-primary">{status?.mode?.toUpperCase() || "---"}</span>
        </div>
      </div>

      <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = location === item.href;
          return (
            <Link key={item.href} href={item.href}>
              <div
                onClick={onNav}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-sm transition-colors cursor-pointer",
                  isActive
                    ? "bg-primary/10 text-primary border-l-2 border-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground border-l-2 border-transparent"
                )}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </div>
            </Link>
          );
        })}
      </nav>
    </>
  );

  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="w-64 border-r border-border bg-sidebar flex-col hidden md:flex">
        <SidebarContent />
      </aside>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 bg-sidebar border-r border-border flex flex-col transition-transform duration-200 md:hidden",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <SidebarContent onNav={() => setMobileOpen(false)} />
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-14 border-b border-border flex items-center px-4 bg-background gap-3">
          <button
            className="md:hidden text-muted-foreground hover:text-foreground p-1 -ml-1"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="w-6 h-6" />
          </button>
          <span className="md:hidden font-bold text-lg">CryptoBot</span>
        </header>
        <div className="flex-1 overflow-auto p-4 md:p-6">
          {children}
        </div>
      </main>
    </div>
  );
}

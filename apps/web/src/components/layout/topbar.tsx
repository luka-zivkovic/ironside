import * as React from "react";
import { useTheme } from "next-themes";
import { NavLink, useLocation, useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useActiveProject } from "@/lib/projects";
import { getApiBaseUrl } from "@/lib/api";
import { useEnvironmentRegistry } from "@/lib/environment-registry";
import { environmentOptions, pathWithEnvironment, setEnvironmentSearchParam } from "@/lib/environment-filter";

export interface TopbarProps {
  crumbs: React.ReactNode[];
  right?: React.ReactNode;
}

export function Topbar({ crumbs, right }: TopbarProps) {
  const { theme, setTheme } = useTheme();
  const { project } = useActiveProject();
  const registry = useEnvironmentRegistry();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectBase = `/projects/${encodeURIComponent(project.id)}`;
  const selectedEnvironment = searchParams.get("environment");
  const options = environmentOptions(registry.environments, selectedEnvironment);

  return (
    <header className="sticky top-0 z-10 flex min-h-12 items-center gap-3.5 border-b border-rule bg-paper/95 px-5 backdrop-blur-sm sm:px-8 lg:px-7">
      <div className="mr-1 font-serif text-[15px] text-ink lg:hidden">
        <span className="text-signal">i</span>ronside
      </div>
      <nav className="flex items-center gap-1 lg:hidden" aria-label="Primary navigation">
        <MobileNavLink to={pathWithEnvironment(`${projectBase}/traces`, searchParams)} end>Traces</MobileNavLink>
        <MobileNavLink to={pathWithEnvironment(`${projectBase}/connections`, searchParams)}>Connect</MobileNavLink>
        <MobileNavLink to={pathWithEnvironment(`${projectBase}/settings`, searchParams)}>Settings</MobileNavLink>
      </nav>
      <div className="hidden items-center gap-2 font-mono text-[10.5px] text-ink-3 lg:flex">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 ? <span className="text-ink-mute">/</span> : null}
            <span className={i === crumbs.length - 1 ? "text-ink" : undefined}>{c}</span>
          </React.Fragment>
        ))}
      </div>
      <div className="flex-1" />
      <button
        type="button"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        className="cursor-pointer rounded-sm border border-rule-soft px-2 py-1 font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-3 hover:bg-paper-2 lg:hidden"
        aria-label="Toggle theme"
      >
        {theme === "dark" ? "Light" : "Dark"}
      </button>
      {right ?? (
        <div className="flex min-w-0 max-w-[52vw] items-center gap-2">
          <label className="flex min-w-0 items-center gap-1.5">
            <span className="hidden font-mono text-[9px] uppercase tracking-[0.08em] text-ink-4 sm:inline">Environment</span>
            <select
              value={selectedEnvironment ?? ""}
              onChange={(event) =>
                setSearchParams(
                  setEnvironmentSearchParam(searchParams, event.target.value || null)
                )
              }
              className="max-w-[180px] rounded-sm border border-rule-soft bg-paper px-2 py-1 text-[11px] text-ink"
              aria-label="Filter by environment"
              disabled={registry.loading}
            >
              <option value="">All environments</option>
              {options.map((option) => (
                <option key={option.name} value={option.name}>
                  {option.name}{option.suffix ? ` (${option.suffix})` : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="hidden min-w-0 items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.06em] text-ink-4 xl:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-ink-4" />
            <span className="truncate" title={`${project.name} · ${getApiBaseUrl()}`}>{project.name}</span>
          </div>
        </div>
      )}
    </header>
  );
}

function MobileNavLink({ to, end, children }: { to: string; end?: boolean; children: React.ReactNode }) {
  const location = useLocation();
  const toPath = to.split("?", 1)[0] ?? to;

  return (
    <NavLink
      to={to}
      {...(end ? { end: true } : {})}
      className={({ isActive }) =>
        cn(
          "rounded-sm px-2 py-1 text-[11px] text-ink-3 hover:bg-paper-2 hover:text-ink",
          (isActive || (toPath.endsWith("/traces") && location.pathname.startsWith(`${toPath}/`))) && "bg-card text-ink"
        )
      }
    >
      {children}
    </NavLink>
  );
}

export function TopbarPill({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-sm border border-rule bg-card px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-2">
      {children}
    </div>
  );
}

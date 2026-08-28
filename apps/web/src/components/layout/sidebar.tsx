import { Cable, Database, ListTree, Settings as SettingsIcon, ShieldCheck } from "lucide-react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { IronsideBrand } from "@/components/ironside-brand";
import { useActiveProject } from "@/lib/projects";
import { getApiBaseUrl } from "@/lib/api";
import { pathWithEnvironment } from "@/lib/environment-filter";

export function Sidebar() {
  const { theme, setTheme } = useTheme();
  const { project, projects } = useActiveProject();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const projectBase = `/projects/${encodeURIComponent(project.id)}`;
  const navItems = [{ to: pathWithEnvironment(`${projectBase}/traces`, searchParams), label: "Trace explorer", icon: ListTree, end: true }];
  const systemItems = [
    { to: pathWithEnvironment(`${projectBase}/connections`, searchParams), label: "Connections", icon: Cable },
    { to: pathWithEnvironment(`${projectBase}/settings`, searchParams), label: "Configuration", icon: SettingsIcon }
  ];

  return (
    <aside className="sticky top-0 hidden h-screen flex-col border-r border-rule bg-paper-2 pt-[18px] pb-3.5 lg:flex">
      <div className="flex items-center gap-2.5 border-b border-rule-soft px-[22px] pt-1 pb-[18px] mb-3.5">
        <IronsideBrand
          markClassName="size-5"
          nameClassName="font-serif text-[17px] font-medium tracking-[-0.02em] text-ink"
        />
        <div className="font-mono text-[9px] uppercase tracking-[0.13em] text-ink-4">Recorder</div>
      </div>

      <div className="mx-3.5 mb-4 rounded-sm border border-rule-soft bg-card p-3 shadow-[var(--shadow-card)]">
        <div className="flex items-center gap-2 text-ink-2">
          <Database className="h-3.5 w-3.5 text-signal" />
          <span className="text-[12px] font-medium">Active project</span>
        </div>
        <select
          value={project.id}
          onChange={(event) => navigate(`/projects/${encodeURIComponent(event.target.value)}/traces`)}
          className="mt-2 w-full rounded-sm border border-rule-soft bg-paper px-2 py-1.5 text-[12px] text-ink"
          aria-label="Switch active project"
        >
          {projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
        <div className="mt-2 flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-4">
          <ShieldCheck className="h-3 w-3 text-signal" />
          Owner session authorized
        </div>
        <div className="mt-1 truncate font-mono text-[9px] text-ink-4" title={project.id}>{project.id}</div>
      </div>

      <NavSection label="Record">
        {navItems.map((item) => (
          <NavItem key={item.to} to={item.to} icon={<item.icon className="h-3.5 w-3.5" />} label={item.label} end={item.end} />
        ))}
      </NavSection>

      <NavSection label="System">
        {systemItems.map((item) => (
          <NavItem key={item.to} to={item.to} icon={<item.icon className="h-3.5 w-3.5" />} label={item.label} />
        ))}
      </NavSection>

      <div className="mt-auto border-t border-rule-soft px-3.5 pt-3">
        <div className="mb-2 flex items-center gap-2 px-2 font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-4">
          <span className="h-1.5 w-1.5 rounded-full bg-ink-4" />
          <span className="truncate" title={getApiBaseUrl()}>{getApiBaseUrl()}</span>
        </div>
        <button
          type="button"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="w-full cursor-pointer border border-rule-soft bg-transparent px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3 hover:bg-paper-3 rounded-sm"
          aria-label="Toggle theme"
        >
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </div>
    </aside>
  );
}

function NavSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3.5 px-3.5">
      <div className="px-2 pb-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4">{label}</div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  end?: boolean;
}

function NavItem({ to, icon, label, end }: NavItemProps) {
  const location = useLocation();
  const toPath = to.split("?", 1)[0] ?? to;
  const includesTraceDetail = toPath.endsWith("/traces") && location.pathname.startsWith(`${toPath}/`);

  return (
    <NavLink to={to} {...(end ? { end: true } : {})} className="block">
      {({ isActive }) => {
        const current = isActive || includesTraceDetail;
        return (
          <div
            className={cn(
              "relative flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-[7px] text-[13px] text-ink-2 select-none",
              current ? "bg-card text-ink" : "hover:bg-paper-3"
            )}
          >
            {current ? <span className="absolute -left-3.5 top-1.5 bottom-1.5 w-[2px] bg-signal" /> : null}
            <span className={cn(current ? "text-signal" : "text-ink-3")}>{icon}</span>
            <span>{label}</span>
          </div>
        );
      }}
    </NavLink>
  );
}

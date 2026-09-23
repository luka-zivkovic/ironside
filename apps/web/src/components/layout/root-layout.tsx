import { useMemo } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { cn } from "@/lib/utils";
import { EnvironmentRegistryProvider } from "@/lib/environment-registry";

function crumbsFor(pathname: string): string[] {
  if (/\/projects\/[^/]+\/traces\//.test(pathname)) return ["Ironside", "Trace explorer", "Record"];
  if (/\/projects\/[^/]+\/traces$/.test(pathname)) return ["Ironside", "Trace explorer"];
  if (/\/projects\/[^/]+\/connections/.test(pathname)) return ["Ironside", "Connections"];
  if (/\/projects\/[^/]+\/settings/.test(pathname)) return ["Ironside", "Configuration"];
  return ["Ironside"];
}

export function RootLayout() {
  const location = useLocation();
  const crumbs = useMemo(() => crumbsFor(location.pathname), [location.pathname]);
  const isTraceRecord = /\/projects\/[^/]+\/traces\//.test(location.pathname);

  return (
    <EnvironmentRegistryProvider>
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[232px_minmax(0,1fr)]">
        <Sidebar />
        <main className="flex min-w-0 flex-col">
          <Topbar crumbs={crumbs} />
          <div
            className={cn(
              "min-w-0 w-full px-5 pt-7 sm:px-8 xl:px-12 xl:pt-9",
              // The trace record's panes are viewport-capped and sticky; the
              // bottom padding must match the cap's bottom margin (24px) so the
              // panes never scroll under the top bar at the page's end.
              isTraceRecord ? "max-w-none pb-6" : "max-w-[1440px] pb-20"
            )}
          >
            <Outlet />
          </div>
        </main>
      </div>
    </EnvironmentRegistryProvider>
  );
}

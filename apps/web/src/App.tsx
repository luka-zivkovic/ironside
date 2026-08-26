import { useEffect, useState, type ReactNode } from "react";
import {
  Link,
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams
} from "react-router-dom";
import { ThemeProvider } from "@/components/theme-provider";
import { RootLayout } from "@/components/layout/root-layout";
import { TracesScreen } from "@/screens/traces";
import { SettingsScreen } from "@/screens/settings";
import { ConnectionsScreen } from "@/screens/connections";
import {
  OwnerLoginScreen,
  OwnerRecoveryScreen,
  OwnerSetupScreen
} from "@/screens/owner-auth";
import { ApiUnavailableScreen, NotFoundScreen } from "@/screens/system";
import { ProjectBootstrapScreen } from "@/screens/project-bootstrap";
import { checkHealth, setUnauthorizedHandler } from "@/lib/api";
import { OwnerSessionProvider, useOwnerSession } from "@/lib/owner-session";
import { ActiveProjectProvider, ProjectsProvider, useActiveProject, useProjects } from "@/lib/projects";
import { getLastProjectId, selectInitialProject, setLastProjectId } from "@/lib/project-storage";
import { PayloadViewPreferenceProvider } from "@/lib/payload-view-preference";
import { safeNextPath } from "@/lib/owner-auth-input";

const router = createBrowserRouter([
  { path: "/setup", element: <OwnerSetupRoute /> },
  { path: "/login", element: <OwnerLoginRoute /> },
  { path: "/recover", element: <OwnerRecoveryRoute /> },
  { path: "/connect", element: <Navigate to="/" replace /> },
  {
    element: <AuthenticatedOwnerGate />,
    children: [
      { index: true, element: <ProjectRedirect suffix="traces" /> },
      { path: "connections", element: <ProjectRedirect suffix="connections" /> },
      { path: "settings", element: <ProjectRedirect suffix="settings" /> },
      { path: "traces/:id", element: <LegacyTraceRedirect /> },
      {
        path: "projects/:projectId",
        element: <ProjectScopeGate />,
        children: [
          {
            element: <RootLayout />,
            children: [
              { index: true, element: <Navigate to="traces" replace /> },
              { path: "traces", element: <ProjectTracesRoute /> },
              {
                path: "traces/:id",
                hydrateFallbackElement: <TraceRouteLoading />,
                errorElement: <TraceRouteError />,
                lazy: async () => {
                  const { TraceScreen } = await import("@/screens/trace");
                  return { Component: () => <ProjectTraceRoute TraceScreen={TraceScreen} /> };
                }
              },
              { path: "connections", element: <ProjectConnectionsRoute /> },
              { path: "settings", element: <ProjectSettingsRoute /> },
              { path: "*", element: <NotFoundScreen /> }
            ]
          }
        ]
      },
      { path: "*", element: <NotFoundScreen /> }
    ]
  }
]);

type ApiState = "checking" | "ok" | "unavailable";

export function App() {
  const [apiState, setApiState] = useState<ApiState>("checking");

  useEffect(() => {
    checkApi();
  }, []);

  function checkApi() {
    setApiState("checking");
    checkHealth()
      .then(() => setApiState("ok"))
      .catch(() => setApiState("unavailable"));
  }

  return (
    <ThemeProvider>
      {apiState === "checking" ? (
        <FullScreen title="Loading Ironside" description="Checking API connectivity." />
      ) : apiState === "unavailable" ? (
        <div className="min-h-screen grid place-items-center px-6">
          <ApiUnavailableScreen retry={checkApi} />
        </div>
      ) : (
        <OwnerSessionProvider>
          <RouterProvider router={router} />
        </OwnerSessionProvider>
      )}
    </ThemeProvider>
  );
}

function destinationAfterOwnerAuth(next: string | null): string {
  return safeNextPath(next) ?? "/";
}

function OwnerSetupRoute() {
  const { state, acceptSession } = useOwnerSession();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  if (state.status === "loading") return <FullScreen title="Loading owner setup" description="Checking deployment state." />;
  if (state.status === "error") return <AuthError message={state.message} />;
  if (state.status === "authenticated") return <Navigate to={destinationAfterOwnerAuth(search.get("next"))} replace />;
  if (state.status === "anonymous") return <Navigate to={withNext("/login", search.get("next"))} replace />;
  return (
    <OwnerSetupScreen
      onAuthenticated={(session) => {
        acceptSession(session);
        navigate(destinationAfterOwnerAuth(search.get("next")), { replace: true });
      }}
    />
  );
}

function OwnerLoginRoute() {
  const { state, acceptSession } = useOwnerSession();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  if (state.status === "loading") return <FullScreen title="Loading sign in" description="Checking owner session." />;
  if (state.status === "error") return <AuthError message={state.message} />;
  if (state.status === "setup") return <Navigate to={withNext("/setup", search.get("next"))} replace />;
  if (state.status === "authenticated") return <Navigate to={destinationAfterOwnerAuth(search.get("next"))} replace />;
  return (
    <OwnerLoginScreen
      organizationName={state.organizationName}
      username={state.username}
      onAuthenticated={(session) => {
        acceptSession(session);
        navigate(destinationAfterOwnerAuth(search.get("next")), { replace: true });
      }}
    />
  );
}

function OwnerRecoveryRoute() {
  const { state, refresh } = useOwnerSession();
  const navigate = useNavigate();
  if (state.status === "loading") return <FullScreen title="Loading recovery" description="Checking deployment state." />;
  if (state.status === "error") return <AuthError message={state.message} />;
  if (state.status === "setup") return <Navigate to="/setup" replace />;
  return (
    <OwnerRecoveryScreen
      onRecovered={() => {
        void refresh().then(() => navigate("/login?recovered=1", { replace: true }));
      }}
    />
  );
}

function AuthenticatedOwnerGate() {
  const { state, refresh } = useOwnerSession();
  const location = useLocation();
  const next = `${location.pathname}${location.search}`;

  useEffect(() => {
    if (state.status !== "authenticated") return;
    setUnauthorizedHandler(() => {
      const current = router.state.location;
      const returnTo = `${current.pathname}${current.search}`;
      void refresh().finally(() => {
        void router.navigate(withNext("/login", returnTo), { replace: true });
      });
    });
    return () => setUnauthorizedHandler(null);
  }, [refresh, state.status]);

  if (state.status === "loading") return <FullScreen title="Loading Ironside" description="Checking owner session." />;
  if (state.status === "error") return <AuthError message={state.message} />;
  if (state.status === "setup") return <Navigate to={withNext("/setup", next)} replace />;
  if (state.status === "anonymous") return <Navigate to={withNext("/login", next)} replace />;
  return (
    <PayloadViewPreferenceProvider key={state.session.principalId} principalId={state.session.principalId}>
      <ProjectsProvider>
        <Outlet />
      </ProjectsProvider>
    </PayloadViewPreferenceProvider>
  );
}

function ProjectRedirect({ suffix }: { suffix: string }) {
  const { state } = useProjects();
  if (state.status === "loading") return <FullScreen title="Loading projects" description="Resolving project access." />;
  if (state.status === "error") return <AuthError message={state.message} />;
  const project = selectInitialProject(state.projects, getLastProjectId());
  if (!project) return <ProjectBootstrapScreen />;
  return <Navigate to={`/projects/${encodeURIComponent(project.id)}/${suffix}`} replace />;
}

function LegacyTraceRedirect() {
  const { id } = useParams<{ id: string }>();
  return <ProjectRedirect suffix={`traces/${encodeURIComponent(id ?? "")}`} />;
}

function ProjectScopeGate() {
  const { projectId } = useParams<{ projectId: string }>();
  const { state } = useProjects();
  const project = state.status === "ready" ? state.projects.find((candidate) => candidate.id === projectId) ?? null : null;

  useEffect(() => {
    if (project) setLastProjectId(project.id);
  }, [project]);

  if (state.status === "loading") return <FullScreen title="Loading project" description="Checking project access." />;
  if (state.status === "error") return <AuthError message={state.message} />;
  if (!project) {
    return (
      <FullScreen title="Project not found" description="This project does not exist or is not available to this owner.">
        <Link className="mt-4 inline-flex text-[12px] font-medium text-signal hover:underline" to="/">
          Open an available project
        </Link>
      </FullScreen>
    );
  }
  return (
    <ActiveProjectProvider project={project} projects={state.projects}>
      <Outlet />
    </ActiveProjectProvider>
  );
}

function ProjectSettingsRoute() {
  const { project } = useActiveProject();
  return <SettingsScreen key={project.id} />;
}

function ProjectConnectionsRoute() {
  const { project } = useActiveProject();
  return <ConnectionsScreen key={project.id} />;
}

function ProjectTracesRoute() {
  const { project } = useActiveProject();
  return <TracesScreen key={project.id} />;
}

function ProjectTraceRoute({ TraceScreen }: { TraceScreen: typeof import("@/screens/trace").TraceScreen }) {
  const { project } = useActiveProject();
  return <TraceScreen key={project.id} />;
}

function TraceRouteLoading() {
  return (
    <div className="grid min-h-48 place-items-center px-6 text-[12px] text-ink-3" role="status">
      Loading trace detail…
    </div>
  );
}

function TraceRouteError() {
  return (
    <div className="grid min-h-64 place-items-center px-6" role="alert">
      <div className="max-w-md text-center">
        <div className="type-h2">Trace viewer could not load</div>
        <p className="mt-2 text-[12px] leading-5 text-ink-3">
          The application may have been updated while this page was open. Reload to fetch the current viewer.
        </p>
        <button
          type="button"
          className="mt-4 min-h-8 cursor-pointer rounded-sm border border-rule bg-card px-3 text-[12px] font-medium text-ink hover:bg-paper-3"
          onClick={() => globalThis.location.reload()}
        >
          Reload Ironside
        </button>
      </div>
    </div>
  );
}

function withNext(path: string, next: string | null): string {
  const safe = safeNextPath(next);
  return safe ? `${path}?next=${encodeURIComponent(safe)}` : path;
}

function AuthError({ message }: { message: string }) {
  return <FullScreen title="Owner access unavailable" description={message} />;
}

function FullScreen({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className="min-h-screen grid place-items-center px-6">
      <div className="text-center">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-3">Ironside</div>
        <div className="type-h2 mt-2">{title}</div>
        <div className="mt-2 text-[13px] text-ink-3 max-w-md">{description}</div>
        {children}
      </div>
    </div>
  );
}

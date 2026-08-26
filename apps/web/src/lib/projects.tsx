import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Project } from "@ironside/shared/browser";
import { ApiError, fetchProjects } from "./api.js";

type ProjectsState =
  | { status: "loading" }
  | { status: "ready"; projects: Project[] }
  | { status: "error"; message: string };

interface ProjectsContextValue {
  state: ProjectsState;
  refresh: () => Promise<Project[]>;
}

interface ActiveProjectContextValue {
  project: Project;
  projects: Project[];
}

const ProjectsContext = createContext<ProjectsContextValue | null>(null);
const ActiveProjectContext = createContext<ActiveProjectContextValue | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ProjectsState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const response = await fetchProjects();
      setState({ status: "ready", projects: response.projects });
      return response.projects;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Could not load projects";
      setState({ status: "error", message });
      throw error;
    }
  }, []);

  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  const value = useMemo(() => ({ state, refresh }), [state, refresh]);
  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}

export function ActiveProjectProvider({
  project,
  projects,
  children
}: ActiveProjectContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ project, projects }), [project, projects]);
  return <ActiveProjectContext.Provider value={value}>{children}</ActiveProjectContext.Provider>;
}

export function useProjects(): ProjectsContextValue {
  const value = useContext(ProjectsContext);
  if (!value) throw new Error("useProjects must be used within ProjectsProvider");
  return value;
}

export function useActiveProject(): ActiveProjectContextValue {
  const value = useContext(ActiveProjectContext);
  if (!value) throw new Error("useActiveProject must be used within ActiveProjectProvider");
  return value;
}

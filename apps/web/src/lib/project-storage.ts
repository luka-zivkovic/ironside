import type { Project } from "@ironside/shared/browser";

const LAST_PROJECT_STORAGE_KEY = "ironside.lastProjectId";

export function selectInitialProject(projects: Project[], storedProjectId: string | null): Project | null {
  return projects.find((project) => project.id === storedProjectId) ?? projects[0] ?? null;
}

export function getLastProjectId(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): string | null {
  try {
    return storage?.getItem(LAST_PROJECT_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setLastProjectId(
  projectId: string,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage
): void {
  try {
    storage?.setItem(LAST_PROJECT_STORAGE_KEY, projectId);
  } catch {
    // This hint is non-secret and optional; the first project is the fallback.
  }
}

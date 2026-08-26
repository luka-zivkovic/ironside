import type { ProjectEnvironment } from "@ironside/shared/browser";

export interface EnvironmentOption {
  name: string;
  suffix: "hidden" | "unlisted" | null;
}

export function environmentOptions(
  environments: ProjectEnvironment[],
  selected: string | null
): EnvironmentOption[] {
  const options = environments
    .filter((environment) => !environment.hidden)
    .map((environment) => ({ name: environment.name, suffix: null }) satisfies EnvironmentOption);
  if (!selected || options.some((option) => option.name === selected)) return options;
  const known = environments.find((environment) => environment.name === selected);
  return [
    { name: selected, suffix: known?.hidden ? "hidden" : "unlisted" },
    ...options
  ];
}

export function setEnvironmentSearchParam(
  current: URLSearchParams,
  environment: string | null
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (environment) next.set("environment", environment);
  else next.delete("environment");
  return next;
}

export function pathWithEnvironment(
  pathname: string,
  current: URLSearchParams
): string {
  const environment = current.get("environment");
  if (!environment) return pathname;
  const next = new URLSearchParams();
  next.set("environment", environment);
  return `${pathname}?${next.toString()}`;
}


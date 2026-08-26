import type { ReactNode } from "react";

interface PageHeaderProps {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <div className="fadeUp flex flex-col gap-4 border-b border-rule pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="type-h1 mt-1.5 text-ink">{title}</h1>
        {description ? <p className="mt-1.5 max-w-[680px] text-[12.5px] leading-5 text-ink-3">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

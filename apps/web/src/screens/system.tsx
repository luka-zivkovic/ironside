import { Button } from "@/components/ui/button";

export function NotFoundScreen() {
  return (
    <div className="flex flex-col items-center gap-2 py-24 text-center">
      <div className="font-mono text-[13px] text-ink-4">404</div>
      <div className="font-serif text-[20px] font-medium">Page not found</div>
    </div>
  );
}

export function ApiUnavailableScreen({ retry }: { retry: () => void }) {
  return (
    <div className="text-center">
      <div className="font-mono text-[13px] uppercase tracking-[0.12em] text-ink-3">Ironside</div>
      <div className="type-h2 mt-2">API unreachable</div>
      <div className="mt-2 text-[13px] text-ink-3 max-w-md">
        Could not reach the Ironside API. Make sure it's running and reachable from this browser.
      </div>
      <Button variant="primary" size="sm" className="mt-4" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}

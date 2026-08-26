import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { ApiError } from "@/lib/api";
import { loginOwner, recoverOwner, setupOwner } from "@/lib/owner-auth-api";
import { extractOwnerCapability } from "@/lib/owner-auth-input";
import type { OwnerSessionResponse } from "@ironside/shared/browser";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const SETUP_COMMAND = "docker compose exec api node apps/api/dist/src/scripts/owner-setup.js";
const RECOVERY_COMMAND = "docker compose exec api node apps/api/dist/src/scripts/owner-recovery.js";

function AuthShell({ eyebrow, title, description, children }: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen px-5 py-12 sm:px-8 lg:grid lg:place-items-center lg:py-16">
      <div className="grid w-full max-w-[920px] gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-center lg:gap-16">
        <section>
          <div className="font-serif text-[18px] font-medium text-ink"><span className="text-signal">i</span>ronside</div>
          <div className="eyebrow mt-12">Owner control plane</div>
          <h1 className="mt-2 max-w-[420px] font-serif text-[38px] leading-[1.04] tracking-[-0.035em] text-ink sm:text-[46px]">
            Human access, separate from machine traffic.
          </h1>
          <div className="mt-7 flex flex-col gap-3 text-[12.5px] text-ink-3">
            <Promise icon={<ShieldCheck />} text="One deployment owner in v1" />
            <Promise icon={<LockKeyhole />} text="HttpOnly, expiring browser sessions" />
            <Promise icon={<KeyRound />} text="Project keys remain machine credentials" />
          </div>
        </section>
        <Card className="shadow-[var(--shadow-elev)]">
          <CardHeader className="flex-col items-start gap-1 border-b border-rule-soft">
            <div className="eyebrow">{eyebrow}</div>
            <CardTitle className="mt-1 text-[20px]">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent className="pt-5">{children}</CardContent>
        </Card>
      </div>
    </div>
  );
}

function Promise({ icon, text }: { icon: ReactNode; text: string }) {
  return <div className="flex items-center gap-2.5">{icon}<span>{text}</span></div>;
}

function PasswordFields({ password, confirmation, onPassword, onConfirmation, disabled }: {
  password: string;
  confirmation: string;
  onPassword: (value: string) => void;
  onConfirmation: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <>
      <Field label="Password">
        <Input type="password" autoComplete="new-password" value={password} onChange={(e) => onPassword(e.target.value)} disabled={disabled} />
      </Field>
      <Field label="Confirm password">
        <Input type="password" autoComplete="new-password" value={confirmation} onChange={(e) => onConfirmation(e.target.value)} disabled={disabled} />
      </Field>
      <div className="font-mono text-[10px] text-ink-4">Use at least 12 characters.</div>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex flex-col gap-1.5"><span className="eyebrow">{label}</span>{children}</label>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function OwnerSetupScreen({ onAuthenticated }: {
  onAuthenticated: (session: OwnerSessionResponse) => void;
}) {
  const [tokenInput, setTokenInput] = useState("");
  const [username, setUsername] = useState("owner");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const token = extractOwnerCapability(tokenInput, "setup");
    if (!token) return setError("Paste a complete ironside_setup_… capability.");
    if (password !== confirmation) return setError("The passwords do not match.");
    setSubmitting(true);
    setError(null);
    try {
      onAuthenticated(await setupOwner({ token, username, password }));
    } catch (err) {
      setError(errorMessage(err, "Owner setup failed."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell eyebrow="Initial setup" title="Create the deployment owner" description="Create the first owner for this deployment.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Setup capability"><Input type="password" autoFocus value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} disabled={submitting} placeholder="ironside_setup_..." /></Field>
        <Field label="Username"><Input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={submitting} /></Field>
        <PasswordFields password={password} confirmation={confirmation} onPassword={setPassword} onConfirmation={setConfirmation} disabled={submitting} />
        {error ? <div className="text-[12px] text-error">{error}</div> : null}
        <Button type="submit" variant="primary" className="mt-1 h-10" disabled={submitting}>{submitting ? "Creating owner…" : "Create owner"}<ArrowRight /></Button>
      </form>
      <CommandHelp title="Generate the setup capability on the host" command={SETUP_COMMAND} />
    </AuthShell>
  );
}

export function OwnerLoginScreen({ organizationName, username, onAuthenticated }: {
  organizationName: string;
  username: string;
  onAuthenticated: (session: OwnerSessionResponse) => void;
}) {
  const [loginUsername, setLoginUsername] = useState(username);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      onAuthenticated(await loginOwner({ username: loginUsername, password }));
    } catch (err) {
      setError(errorMessage(err, "Sign in failed."));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <AuthShell eyebrow={organizationName} title="Sign in as owner" description="Continue with the human owner account, then choose an authorized project from its explicit URL context.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Username"><Input autoFocus autoComplete="username" value={loginUsername} onChange={(e) => setLoginUsername(e.target.value)} disabled={submitting} /></Field>
        <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={submitting} /></Field>
        {error ? <div className="text-[12px] text-error">{error}</div> : null}
        <Button type="submit" variant="primary" className="mt-1 h-10" disabled={submitting}>{submitting ? "Signing in…" : "Sign in"}<ArrowRight /></Button>
      </form>
      <div className="mt-5 text-[11.5px] text-ink-3">Lost access? <Link to="/recover" className="text-signal hover:underline">Recover from the host</Link>.</div>
    </AuthShell>
  );
}

export function OwnerRecoveryScreen({ onRecovered }: { onRecovered: () => void }) {
  const [tokenInput, setTokenInput] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const token = extractOwnerCapability(tokenInput, "recovery");
    if (!token) return setError("Paste a complete ironside_recovery_… capability.");
    if (password !== confirmation) return setError("The passwords do not match.");
    setSubmitting(true);
    setError(null);
    try {
      await recoverOwner({ token, password });
      onRecovered();
    } catch (err) {
      setError(errorMessage(err, "Recovery failed."));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <AuthShell eyebrow="Host-local recovery" title="Reset the existing owner" description="Recovery changes the current owner's password and revokes every active owner session. It never creates another owner.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Recovery capability"><Input type="password" autoFocus value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} disabled={submitting} placeholder="ironside_recovery_..." /></Field>
        <PasswordFields password={password} confirmation={confirmation} onPassword={setPassword} onConfirmation={setConfirmation} disabled={submitting} />
        {error ? <div className="text-[12px] text-error">{error}</div> : null}
        <Button type="submit" variant="primary" className="mt-1 h-10" disabled={submitting}>{submitting ? "Resetting…" : "Reset owner password"}<ArrowRight /></Button>
      </form>
      <CommandHelp title="Generate a one-time recovery capability on the host" command={RECOVERY_COMMAND} />
    </AuthShell>
  );
}

function CommandHelp({ title, command }: { title: string; command: string }) {
  return <div className="mt-7 border-t border-rule pt-5"><div className="font-serif text-[14.5px] font-medium text-ink-2">{title}</div><pre className="mt-3 overflow-x-auto rounded-sm border border-rule-soft bg-paper-2 p-3 font-mono text-[10.5px] leading-5 text-ink-2"><code>{command}</code></pre><p className="mt-2 text-[11.5px] leading-5 text-ink-3">The capability expires quickly, is stored only as a hash, and can be used once.</p></div>;
}

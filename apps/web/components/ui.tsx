/**
 * Small shared pieces: the panel frame, account-kind marks, buttons.
 */
import type { ReactNode } from "react";
import type { AccountKind } from "../lib/contract";

export function Panel({
  title,
  meta,
  actions,
  children,
  className = "",
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex min-w-0 flex-col rounded-md border border-line bg-surface ${className}`}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wide text-ink uppercase">{title}</h2>
        {meta && <div className="text-xs text-ink-2">{meta}</div>}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </header>
      <div className="relative min-h-0 min-w-0 flex-1">{children}</div>
    </section>
  );
}

const KIND_DOT: Record<AccountKind, string> = {
  noise: "bg-kind-noise",
  arb: "bg-kind-arb",
  sandwich: "bg-kind-sandwich",
  user: "bg-kind-user",
};

/** A colored dot for the kind. Always shown next to text that names the account or kind. */
export function KindDot({ kind }: { kind: AccountKind }) {
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${KIND_DOT[kind]}`} />;
}

/** "● sandwich-1": the id already says the kind; the dot makes the bots easy to spot. */
export function Account({ id, kind }: { id: string; kind: AccountKind }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono whitespace-nowrap" title={`${kind} account`}>
      <KindDot kind={kind} />
      {id}
    </span>
  );
}

export function KindLabel({ kind }: { kind: AccountKind }) {
  const names: Record<AccountKind, string> = { noise: "noise traders", arb: "arbitrage bot", sandwich: "sandwich bot", user: "users" };
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <KindDot kind={kind} />
      {names[kind]}
    </span>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  primary,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  title?: string;
}) {
  const look = primary ? "border-transparent bg-ink text-surface hover:opacity-90" : "border-line bg-surface text-ink hover:bg-raised";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded border px-2.5 py-1 text-xs font-medium ${look} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amm disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

/** Executed / failed, with an icon and words so color is never the only signal. */
export function TxStatusLabel({ status, errorCode }: { status: "executed" | "failed"; errorCode: string | null }) {
  return status === "executed" ? (
    <span className="whitespace-nowrap">
      <span aria-hidden className="text-good">
        ✓
      </span>{" "}
      ok
    </span>
  ) : (
    <span className="whitespace-nowrap">
      <span aria-hidden className="text-critical">
        ✕
      </span>{" "}
      {errorCode ?? "failed"}
    </span>
  );
}

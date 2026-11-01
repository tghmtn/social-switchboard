import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { SquareIcon, type SquareIconName } from './components/SquareIcons';

// Small building blocks on top of the theme's component classes (.btn, .card, .chip, .input...).

export function Wordmark({ className = 'text-[22px]' }: { className?: string }) {
  return (
    <span className={`wordmark ${className}`}>
      social <span>switchboard</span>
    </span>
  );
}

type FieldShell = { label: string; hint?: string; error?: string; className?: string };

function Shell({
  id,
  label,
  hint,
  error,
  className = '',
  children,
}: FieldShell & { id: string; children: ReactNode }) {
  return (
    <div className={`grid gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-sm font-bold">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[13px] font-bold text-danger">{error}</p>
      ) : hint ? (
        <p className="text-[13px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  className,
  id,
  ...input
}: FieldShell & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Shell id={inputId} label={label} hint={hint} error={error} className={className}>
      <input id={inputId} className="input" aria-invalid={error ? true : undefined} {...input} />
    </Shell>
  );
}

export function TextArea({
  label,
  hint,
  error,
  className,
  id,
  ...input
}: FieldShell & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Shell id={inputId} label={label} hint={hint} error={error} className={className}>
      <textarea id={inputId} className="input" aria-invalid={error ? true : undefined} {...input} />
    </Shell>
  );
}

export function Select({
  label,
  hint,
  error,
  className,
  id,
  children,
  ...input
}: FieldShell & SelectHTMLAttributes<HTMLSelectElement>) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Shell id={inputId} label={label} hint={hint} error={error} className={className}>
      <select id={inputId} className="input" {...input}>
        {children}
      </select>
    </Shell>
  );
}

export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="border-2 border-danger bg-danger-soft px-3 py-2 text-sm font-bold text-danger"
    >
      {message}
    </p>
  );
}

export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <Wordmark className="mb-8 block text-[26px]" />
        <div className="card p-6 sm:p-8">
          <h1 className="font-display text-display-sm font-bold">{title}</h1>
          <p className="mt-1 text-[15px] text-muted">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </main>
  );
}

export function PageHeader({
  eyebrow,
  title,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="grid gap-1.5">
        {eyebrow && <span className="text-label uppercase text-muted">{eyebrow}</span>}
        <h1 className="font-display text-display-lg font-extrabold">{title}</h1>
      </div>
      {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
    </div>
  );
}

export function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="card grid content-start gap-1.5">
      <span className="text-label uppercase text-muted">{label}</span>
      <span className="font-display text-[40px] font-extrabold leading-none tabular-nums">
        {value}
      </span>
      {detail && <span className="text-[13px] text-muted">{detail}</span>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: SquareIconName;
  title: string;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="card card-flat grid justify-items-center gap-3 px-6 py-12 text-center">
      <SquareIcon name={icon} size={40} />
      <p className="text-lg font-bold">{title}</p>
      <div className="max-w-md text-[15px] text-muted">{body}</div>
      {action}
    </div>
  );
}

export function Toggle({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="tog disabled:cursor-not-allowed disabled:opacity-50"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}

/** A square modal built on <dialog>, which handles focus trapping and Escape for us. */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(640px,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] border-2 border-edge bg-surface p-0 text-ink shadow-hard-xl backdrop:bg-black/60"
    >
      <div className="flex items-center justify-between gap-4 border-b-2 border-edge px-5 py-4">
        <h2 className="font-display text-display-sm font-bold">{title}</h2>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  );
}

/** Their picture, or two-letter initials, in a circle: the theme's one rounded element. */
export function Avatar({ name, size = 38, src }: { name: string; size?: number; src?: string }) {
  const [broken, setBroken] = useState(false);
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('') || '?';
  const box = 'inline-flex shrink-0 items-center justify-center rounded-full border-2 border-edge';
  if (src && !broken)
    return (
      <img
        src={src}
        alt=""
        className={`${box} bg-surface-2 object-cover`}
        style={{ width: size, height: size }}
        onError={() => setBroken(true)}
      />
    );
  return (
    <span
      className={`${box} bg-surface-2 text-[13px] font-bold`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export function Logo({ className = 'size-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" className="fill-orange-600" />
      <g className="fill-white">
        <circle cx="9" cy="10" r="3" />
        <circle cx="23" cy="10" r="3" />
        <circle cx="9" cy="22" r="3" />
        <circle cx="23" cy="22" r="3" />
      </g>
      <path
        d="M9 10 C16 10 16 22 23 22"
        className="stroke-white"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
};

export function Field({ label, hint, error, id, ...input }: FieldProps) {
  const inputId = id ?? input.name;
  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        className="block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm shadow-xs outline-none transition placeholder:text-stone-400 focus:border-orange-500 focus:ring-3 focus:ring-orange-500/20 aria-invalid:border-red-500 dark:border-stone-700 dark:bg-stone-900"
        {...input}
      />
      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : hint ? (
        <p className="text-sm text-stone-500">{hint}</p>
      ) : null}
    </div>
  );
}

export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow-xs transition hover:bg-orange-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600 disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
      {...props}
    />
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
        <div className="mb-8 flex items-center gap-3">
          <Logo className="size-10" />
          <span className="text-lg font-semibold tracking-tight">Social Switchboard</span>
        </div>
        <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8 dark:border-stone-800 dark:bg-stone-900">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </main>
  );
}

export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300"
    >
      {message}
    </p>
  );
}

export function PhaseBadge({ phase }: { phase: number }) {
  return (
    <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-500 dark:bg-stone-800 dark:text-stone-400">
      Phase {phase}
    </span>
  );
}

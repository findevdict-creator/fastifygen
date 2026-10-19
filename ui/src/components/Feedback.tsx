import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** A problem worth reading, with the server's list of issues when there is one. */
export function ErrorNotice({ message, issues = [] }: { message: string; issues?: string[] }) {
  return (
    <div className="notice bad" role="alert">
      <strong>{message}</strong>
      {issues.length > 0 && (
        <ul>
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

/** A button that shows a spinner while its action runs. */
export function ActionButton({
  busy,
  children,
  variant = 'default',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; variant?: 'default' | 'primary' | 'ghost'; children: ReactNode }) {
  return (
    <button type="button" {...props} className={`btn ${variant === 'default' ? '' : variant}`} disabled={busy || props.disabled}>
      {busy && <Spinner />}
      {children}
    </button>
  );
}

import type { ReactNode } from 'react';
import type { OverflowItem } from '../lib/types';

export function SectionHeading({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      {detail ? <span>{detail}</span> : null}
      {action}
    </div>
  );
}

export function EmptyState({
  symbol,
  title,
  body,
  action,
  compact,
  success,
}: {
  symbol: string;
  title: string;
  body: string;
  action?: ReactNode;
  compact?: boolean;
  success?: boolean;
}) {
  return (
    <div className={`empty-state${compact ? ' compact-empty' : ''}`}>
      <div className={`empty-symbol${success ? ' success' : ''}`}>{symbol}</div>
      <strong>{title}</strong>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function InlineEmpty({
  symbol,
  title,
  detail,
}: {
  symbol: string;
  title: string;
  detail: string;
}) {
  return (
    <div className="inline-empty">
      <span>{symbol}</span>
      <strong>{title}</strong>
      <small>{detail}</small>
    </div>
  );
}

export function Toggle({
  checked,
  disabled,
  onChange,
  title,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
}) {
  return (
    <label className="toggle" title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span />
    </label>
  );
}

export function OverflowMenu({
  menuKey,
  open,
  busy,
  items,
  onToggle,
  onClose,
}: {
  menuKey: string;
  open: boolean;
  busy?: boolean;
  items: OverflowItem[];
  onToggle: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="overflow-anchor">
      <button
        type="button"
        className="overflow-trigger"
        aria-label="More actions"
        title="More actions"
        disabled={busy}
        onClick={() => onToggle(menuKey)}
      >
        ⋯
      </button>
      {open ? (
        <div className="overflow-popover" role="menu">
          {items.length ? (
            items.map((item) => (
              <button
                key={item.label}
                type="button"
                className={`overflow-item${item.danger ? ' danger' : ''}`}
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  item.onClick();
                  onClose();
                }}
              >
                {item.label}
              </button>
            ))
          ) : (
            <div className="picker-empty">
              <strong>No actions</strong>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function Field({
  label,
  name,
  value,
  placeholder = '',
  type = 'text',
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  placeholder?: string;
  type?: string;
  onChange: (name: string, value: string) => void;
}) {
  const id = `field-${name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(name, event.target.value)}
      />
    </div>
  );
}

export function UsageMeter({
  client,
  usage,
}: {
  client: string;
  usage?: Array<{
    client: string;
    windows: Array<{ remainingPercent: number; label?: string }>;
  }>;
}) {
  const item = (usage ?? []).find((entry) => entry.client === client);
  const window = item?.windows?.[0];
  if (!window) return null;
  const value = Math.max(0, Math.min(100, Number(window.remainingPercent) || 0));
  return (
    <div className="quota-summary usage-meter" title={window.label || 'Usage'}>
      <span>Usage · {value}% left</span>
      <div className="bar">
        <span style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

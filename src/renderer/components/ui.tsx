import React from 'react'

/**
 * Small presentational primitives shared by every page.
 *
 * These carry no behaviour: they only put the design tokens in styles.css to work
 * so a heading, a card and an empty state look the same on every tab.
 */

export function PageHeader({
  title, accent, purpose, help, actions,
}: {
  title: string
  accent?: string
  purpose?: React.ReactNode
  help?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="g-page-head">
      <div className="g-page-head-main">
        <h1 className="g-title">
          {title}
          {accent && <span className="g-title-accent"> — {accent}</span>}
        </h1>
        {purpose && <p className="g-purpose">{purpose}</p>}
        {help && (
          <details className="g-help">
            <summary>How this works</summary>
            <div className="g-help-body">{help}</div>
          </details>
        )}
      </div>
      {actions && <div className="g-page-actions">{actions}</div>}
    </div>
  )
}

export function Card({
  title, sub, actions, children, footer, tone,
}: {
  title?: React.ReactNode
  sub?: React.ReactNode
  actions?: React.ReactNode
  children?: React.ReactNode
  footer?: React.ReactNode
  tone?: 'accent' | 'risk'
}) {
  const cls = ['g-card', tone === 'accent' ? 'g-card--accent' : '', tone === 'risk' ? 'g-card--risk' : '']
    .filter(Boolean).join(' ')
  return (
    <section className={cls}>
      {(title || actions) && (
        <header className="g-card-head">
          <div>
            {title && <h2 className="g-card-title">{title}</h2>}
            {sub && <div className="g-card-sub">{sub}</div>}
          </div>
          {actions && <div className="g-card-actions">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className="g-card-body">{children}</div>}
      {footer && <div className="g-card-foot">{footer}</div>}
    </section>
  )
}

export function Field({
  label, hint, children, className,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <label className={['g-field', className].filter(Boolean).join(' ')}>
      <span className="g-label">{label}</span>
      {children}
      {hint && <span className="g-hint">{hint}</span>}
    </label>
  )
}

export function EmptyState({
  icon, title, body, action,
}: {
  icon?: string
  title: string
  body?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="g-empty">
      {icon && <div className="g-empty-icon">{icon}</div>}
      <div className="g-empty-title">{title}</div>
      {body && <div className="g-empty-body">{body}</div>}
      {action && <div className="g-empty-action">{action}</div>}
    </div>
  )
}

export function Alert({ kind, children }: { kind: 'error' | 'ok' | 'info'; children: React.ReactNode }) {
  return (
    <div
      className={`g-alert g-alert--${kind}`}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  )
}

export function Chip({ tone, children }: { tone?: 'ok' | 'warn' | 'bad' | 'accent'; children: React.ReactNode }) {
  return <span className={['g-chip', tone ? `g-chip--${tone}` : ''].filter(Boolean).join(' ')}>{children}</span>
}

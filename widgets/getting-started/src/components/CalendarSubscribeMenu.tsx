import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { cn } from '../lib/utils'

const CALENDAR_ID = 'c_7ef3423551d9e032513a800fef9bcf21fe8e4d2d59a51081192c9c53f1bb1901@group.calendar.google.com'

const GOOGLE_CID =
  'Y183ZWYzNDIzNTUxZDllMDMyNTEzYTgwMGZlZjliY2YyMWZlOGU0ZDJkNTlhNTEwODExOTJjOWM1M2YxYmIxOTAxQGdyb3VwLmNhbGVuZGFyLmdvb2dsZS5jb20'

const OPTIONS = [
  {
    label: 'Google Calendar',
    hint: 'Opens Google Calendar to add the community calendar.',
    href: `https://calendar.google.com/calendar/u/0?cid=${GOOGLE_CID}`,
  },
  {
    label: 'Apple Calendar',
    hint: 'Subscribes on iPhone, iPad and Mac.',
    href: `webcal://calendar.google.com/calendar/ical/${CALENDAR_ID}/public/basic.ics`,
  },
  {
    label: 'Outlook / Other',
    hint: 'Subscribes via an .ics feed in any calendar app.',
    href: `https://calendar.google.com/calendar/ical/${CALENDAR_ID}/public/basic.ics`,
  },
]

export function CalendarSubscribeMenu() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="group inline-flex w-fit cursor-pointer items-center gap-2 rounded-full bg-primary px-6 py-3 text-[13px] font-semibold uppercase tracking-brand text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Add WLTH WLKS Community Calendar
        <ChevronDown
          className={cn(
            'h-4 w-4 transition-transform',
            open ? 'rotate-180' : 'group-hover:translate-y-0.5',
          )}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-2xl border border-border/80 bg-background p-1.5 shadow-xl shadow-black/10"
        >
          {OPTIONS.map((option) => (
            <a
              key={option.label}
              role="menuitem"
              href={option.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-primary/10"
            >
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold uppercase tracking-brand text-foreground">
                  {option.label}
                </p>
                <p className="mt-0.5 text-xs font-light leading-relaxed text-muted-foreground">
                  {option.hint}
                </p>
              </div>
              <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

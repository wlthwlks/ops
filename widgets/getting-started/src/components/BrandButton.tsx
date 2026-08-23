import type { ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { cn } from '../lib/utils'

type BrandButtonProps = {
  href?: string
  children: ReactNode
  variant?: 'solid' | 'outline'
  className?: string
}

export function BrandButton({
  href = '#',
  children,
  variant = 'solid',
  className,
}: BrandButtonProps) {
  return (
    <a
      href={href}
      className={cn(
        'group inline-flex w-fit items-center gap-2 rounded-full px-6 py-3 text-[13px] font-semibold uppercase tracking-brand transition-colors',
        variant === 'solid'
          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border border-border bg-transparent text-foreground hover:border-primary/60 hover:text-primary',
        className,
      )}
    >
      {children}
      <ArrowUpRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
    </a>
  )
}

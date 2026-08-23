const FOOTER_LOGO =
  'https://cdn.prod.website-files.com/67d62dc17cb7c0a57f321eeb/68049da7dc4ee14f99e1702f_WW-logo-1.png'

export function SiteFooter() {
  return (
    <footer className="mt-6 border-t border-border/70">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-5 py-16 sm:px-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={FOOTER_LOGO}
          alt="WLTH WLKS"
          className="h-20 w-auto opacity-90 sm:h-24"
        />
        <p className="text-xs font-light uppercase tracking-brand text-muted-foreground">
          Walk with vision
        </p>
      </div>
    </footer>
  )
}

const FOOTER_LOGO =
  "https://cdn.prod.website-files.com/67d62dc17cb7c0a57f321eeb/68049da7dc4ee14f99e1702f_WW-logo-1.png";

export function SiteFooter() {
  return (
    <footer className="gs-footer">
      <div className="gs-footer__inner">
        <img src={FOOTER_LOGO} alt="WLTH WLKS" />
        <p>Walk with vision</p>
      </div>
    </footer>
  );
}

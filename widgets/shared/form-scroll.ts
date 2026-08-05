/** Scroll widget root into view so loaders / step tops are visible. */
export function scrollWidgetToTop(rootId?: string) {
  try {
    const root =
      (rootId ? document.getElementById(rootId) : null) ||
      document.getElementById("wlth-signup-root") ||
      document.getElementById("wlth-update-details-root") ||
      document.querySelector(".wlth-widget");
    if (root) {
      root.scrollIntoView({ behavior: "smooth", block: "start" });
      const rect = root.getBoundingClientRect();
      const y = window.scrollY + rect.top - 12;
      window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  } catch {
    try {
      window.scrollTo(0, 0);
    } catch {
      /* ignore */
    }
  }
}

function isElementInViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const visibleHeight = Math.min(rect.bottom, vh) - Math.max(rect.top, 0);
  const visibleWidth = Math.min(rect.right, vw) - Math.max(rect.left, 0);
  return visibleHeight > 40 && visibleWidth > 40;
}

/**
 * Focus and scroll to the first invalid field when it is not already on screen.
 * Prefer aria-invalid, then .wlth-error with text, then [name] from RHF error keys.
 */
export function scrollToFirstFormError(
  formEl?: HTMLFormElement | null,
  errorFields?: string[]
) {
  try {
    const scope =
      formEl ||
      document.querySelector(".wlth-widget form") ||
      document.querySelector(".wlth-widget");
    if (!scope) return;

    const candidates: Element[] = [];

    scope.querySelectorAll("[aria-invalid='true']").forEach((el) => candidates.push(el));

    if (errorFields?.length) {
      for (const name of errorFields) {
        const byName =
          scope.querySelector(`[name="${CSS.escape(name)}"]`) ||
          scope.querySelector(`#${CSS.escape(name)}`) ||
          scope.querySelector(`[id$="-${CSS.escape(name)}"]`);
        if (byName) candidates.push(byName);
      }
    }

    scope.querySelectorAll(".wlth-error").forEach((errEl) => {
      const text = (errEl.textContent || "").replace(/\u00a0/g, "").trim();
      if (!text) return;
      const field = errEl.closest(".wlth-field");
      const control =
        field?.querySelector("input, select, textarea, button.wlth-ms__trigger") ||
        errEl.previousElementSibling;
      if (control) candidates.push(control);
    });

    const target = candidates[0];
    if (!target) return;

    if (!isElementInViewport(target)) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (target instanceof HTMLElement) {
      try {
        target.focus({ preventScroll: true });
      } catch {
        try {
          target.focus();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

/** RHF invalid submit: scroll first errored field into view if needed. */
export function onInvalidScrollToError(
  errors: Record<string, unknown>,
  formEl?: HTMLFormElement | null
) {
  const keys = Object.keys(errors || {});
  // Defer so RHF can paint aria-invalid / error text first
  requestAnimationFrame(() => {
    requestAnimationFrame(() => scrollToFirstFormError(formEl, keys));
  });
}

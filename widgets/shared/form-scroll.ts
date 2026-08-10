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
 * When multiple errors exist, picks the topmost visible error by viewport order.
 * Prefer aria-invalid, then .wlth-error with text, then [name] from RHF error keys.
 */
export function scrollToFirstFormError(
  formEl?: HTMLFormElement | null,
  errorFields?: string[],
  extraCandidates?: Element[]
) {
  try {
    const scope =
      formEl ||
      document.querySelector(".wlth-widget form") ||
      document.querySelector(".wlth-widget");
    if (!scope) return;

    const candidates: Array<{ el: Element; top: number }> = [];

    const add = (el: Element) => {
      const top = el.getBoundingClientRect().top;
      candidates.push({ el, top: Number.isFinite(top) ? top : Infinity });
    };

    scope.querySelectorAll("[aria-invalid='true']").forEach((el) => add(el));

    if (errorFields?.length) {
      for (const name of errorFields) {
        const byName =
          scope.querySelector(`[name="${CSS.escape(name)}"]`) ||
          scope.querySelector(`#${CSS.escape(name)}`) ||
          scope.querySelector(`[id$="-${CSS.escape(name)}"]`);
        if (byName) add(byName);
      }
    }

    scope.querySelectorAll(".wlth-error").forEach((errEl) => {
      const text = (errEl.textContent || "").replace(/\u00a0/g, "").trim();
      if (!text) return;
      const field = errEl.closest(".wlth-field");
      const control =
        field?.querySelector("input, select, textarea, button.wlth-ms__trigger") ||
        errEl.previousElementSibling;
      if (control) add(control);
    });

    // Extra candidates from client-side validation (e.g. social links outside RHF)
    if (extraCandidates?.length) {
      for (const el of extraCandidates) {
        if (el && el instanceof Element) add(el);
      }
    }

    // Sort by viewport top — scroll to the highest error first
    candidates.sort((a, b) => a.top - b.top);
    const target = candidates[0]?.el;
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
  formEl?: HTMLFormElement | null,
  extraCandidates?: Element[]
) {
  const keys = Object.keys(errors || {});
  // Defer so RHF can paint aria-invalid / error text first
  requestAnimationFrame(() => {
    requestAnimationFrame(() =>
      scrollToFirstFormError(formEl, keys, extraCandidates)
    );
  });
}

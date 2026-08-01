/** Tiny DOM helper: el("div.card", { onclick }, children...) */
export function el<K extends keyof HTMLElementTagNameMap>(
  spec: `${K}` | `${K}.${string}` | string,
  attrs?: Record<string, unknown> | null,
  ...children: (Node | string | null | undefined)[]
): HTMLElement {
  const [tag, ...classes] = spec.split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2), v as EventListener);
      } else if (k === "text") {
        node.textContent = String(v);
      } else if (k === "html") {
        node.innerHTML = String(v);
      } else if (k === "dataset") {
        Object.assign(node.dataset, v);
      } else if (k in node && k !== "style" && k !== "class") {
        (node as unknown as Record<string, unknown>)[k] = v;
      } else {
        node.setAttribute(k === "class" ? "class" : k, String(v));
      }
    }
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return node;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { flush: () => void; cancel: () => void } {
  let t: ReturnType<typeof setTimeout> | null = null;
  let last: A | null = null;
  const wrapped = (...args: A) => {
    last = args;
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      if (last) fn(...last);
      last = null;
    }, ms);
  };
  wrapped.flush = () => {
    if (t) clearTimeout(t);
    t = null;
    if (last) fn(...last);
    last = null;
  };
  wrapped.cancel = () => {
    if (t) clearTimeout(t);
    t = null;
    last = null;
  };
  return wrapped;
}

export function fmtDate(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function uid(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  );
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Simple non-crypto hash for palette selection. */
export function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

// ---- toasts ------------------------------------------------------------

let toastRoot: HTMLElement | null = null;

export function toast(message: string, kind: "info" | "error" = "info"): void {
  if (!toastRoot) {
    toastRoot = el("div.toast-root");
    document.body.append(toastRoot);
  }
  const t = el(`div.toast.toast-${kind}`, null, message);
  toastRoot.append(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, kind === "error" ? 5200 : 2800);
}

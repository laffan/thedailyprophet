import { el } from "./util";

/** Prompt-style modal (window.prompt is unavailable in wry webviews). */
export function promptModal(opts: {
  title: string;
  label?: string;
  value?: string;
  confirmText?: string;
  placeholder?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const input = el("input.modal-input", {
      type: "text",
      value: opts.value ?? "",
      placeholder: opts.placeholder ?? "",
      spellcheck: false,
    }) as HTMLInputElement;

    const done = (v: string | null) => {
      overlay.remove();
      resolve(v);
    };

    const overlay = el(
      "div.modal-overlay",
      { onclick: (e: MouseEvent) => e.target === overlay && done(null) },
      el(
        "div.modal",
        null,
        el("h3.modal-title", null, opts.title),
        opts.label ? el("p.modal-label", null, opts.label) : null,
        input,
        el(
          "div.modal-actions",
          null,
          el("button.btn.btn-ghost", { onclick: () => done(null) }, "Cancel"),
          el(
            "button.btn.btn-primary",
            { onclick: () => done(input.value.trim() || null) },
            opts.confirmText ?? "Save",
          ),
        ),
      ),
    );
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(input.value.trim() || null);
      if (e.key === "Escape") done(null);
    });
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

export function confirmModal(opts: {
  title: string;
  body?: string;
  confirmText?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      overlay.remove();
      resolve(v);
    };
    const overlay = el(
      "div.modal-overlay",
      { onclick: (e: MouseEvent) => e.target === overlay && done(false) },
      el(
        "div.modal",
        null,
        el("h3.modal-title", null, opts.title),
        opts.body ? el("p.modal-label", null, opts.body) : null,
        el(
          "div.modal-actions",
          null,
          el("button.btn.btn-ghost", { onclick: () => done(false) }, "Cancel"),
          el(
            `button.btn.${opts.danger ? "btn-danger" : "btn-primary"}`,
            { onclick: () => done(true) },
            opts.confirmText ?? "Confirm",
          ),
        ),
      ),
    );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        window.removeEventListener("keydown", onKey);
        done(false);
      }
    };
    window.addEventListener("keydown", onKey);
    document.body.append(overlay);
  });
}

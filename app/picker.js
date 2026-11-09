// Full-screen list with search, for long option lists (models, loras, samplers…).
import { closeOnBack, h, splitPath } from "./api.js";

const SHOWN = 1000; // the search still goes through all of them

/** describe(option) -> { name, folder }: the main line and the small one under it (default: file paths).
 * typeAhead: long lists put the cursor in the search field (opening the keyboard).
 * thumb(option) -> image URL shown before the name, or null for none. */
export function pick(title, options, current, describe = splitPath, typeAhead = true, thumb = null) {
  return new Promise((resolve) => {
    const search = h("input", { type: "search", placeholder: "Search…", className: "picker-search", "aria-label": `Search ${title}` });
    const list = h("ul", { className: "picker-list", role: "listbox", "aria-label": title });
    const close = (value, viaBack = false) => {
      if (!viaBack) release();
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const release = closeOnBack(() => close(undefined, true));
    const onKey = (e) => e.key === "Escape" && close(undefined);

    const render = () => {
      const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = options.filter((o) => {
        const { name, folder } = describe(o);
        const text = `${folder ?? ""} ${name}`.toLowerCase();
        return terms.every((t) => text.includes(t));
      });
      // Only the first ones: tens of thousands make every keystroke slow (and ~125,000 overflow replaceChildren).
      list.replaceChildren(...matches.slice(0, SHOWN).map((o) => {
        const { name, folder } = describe(o);
        return h("li", {},
          h("button", { className: `picker-option${thumb ? " with-thumb" : ""}`, role: "option", "aria-selected": String(o === current), onclick: () => close(o) },
            thumb ? h("img", { className: "picker-thumb", src: thumb(o), alt: "", loading: "lazy",
              onerror: (e) => (e.target.style.visibility = "hidden") }) : null, // no preview possible: an empty square
            h("span", { className: "picker-name", textContent: name }),
            folder ? h("span", { className: "picker-folder", textContent: folder }) : null));
      }));
      if (!matches.length) list.append(h("li", { className: "empty", textContent: "No matches" }));
      if (matches.length > SHOWN) {
        list.append(h("li", { className: "empty", textContent: `${(matches.length - SHOWN).toLocaleString("en")} more: type to narrow them down` }));
      }
    };
    search.addEventListener("input", render);

    const overlay = h("div", { className: "picker", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { className: "picker-head" },
        h("button", { className: "icon-btn", "aria-label": "Close", textContent: "✕", onclick: () => close(undefined) }),
        h("strong", { textContent: title })),
      search, list);
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    render();
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "center" });
    if (typeAhead && options.length > 12) search.focus();
  });
}

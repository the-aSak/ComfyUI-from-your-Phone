// The Prompts tab (prompts and snippets) and the ☰ menu on text fields that saves and uses them.
import { $, closeOnBack, h, isoDateTime, setSetting, setting, toast } from "./api.js";
import { addEntry, deleteEntry, editEntry, onLibraryChange, reorder, syncLibrary, syncState, visible } from "./library.js";
import { pick } from "./picker.js";
import { enableDrag, moveItem } from "./reorder.js";

let kind = "prompt"; // the list shown: "prompt" or "snippet"
let open = null; // id of the expanded entry
let editing = null; // id being edited, "new", or null
// What the open editor holds, kept as it is typed: a redraw (typing a search, tapping another entry) builds the
// editor again from this, not from the saved entry. key: the id being edited, or "new".
let draft = null; // { key, entry, kind, name, text }

// Cut by characters, never inside an emoji (whose half the PC can't store).
const firstWords = (text) => [...text.trim().split(/\s+/).slice(0, 6).join(" ")].slice(0, 60).join("");
const nameOf = (e) => e.name || firstWords(e.text) || "(empty)";

// ---------- the tab ----------
/** Stores the draft (a new entry or the edited one) and closes the editor. */
function storeDraft() {
  const { entry, kind: type, text } = draft;
  const name = type === "prompt" ? draft.name.trim() : "";
  if (entry) editEntry(entry.id, { kind: type, name, text });
  else addEntry(type, text, name);
  kind = type;
  editing = draft = null;
}

// Keeps what the open editor holds when it goes another way than Save or Cancel (another tab, say, after a
// stray swipe), so no typing is lost. A new one without a name is named by its first words, as on Save.
function keepDraft() {
  const d = draft?.key === editing ? draft : null;
  if (!d?.text.trim() || (d.entry && d.text === d.entry.text && d.name.trim() === d.entry.name && d.kind === d.entry.kind)) {
    draft = null; // closed already, nothing typed, or nothing changed
    return;
  }
  storeDraft();
  toast(d.entry ? "Your changes were saved" : `Draft saved to ${d.kind === "prompt" ? "Prompts" : "Snippets"}`, "ok");
}

function editor(entry) {
  const key = entry?.id ?? "new";
  if (draft?.key !== key) draft = { key, entry, kind: entry?.kind ?? kind, name: entry?.name ?? "", text: entry?.text ?? "" };
  const d = draft;
  const nameInput = h("input", { type: "text", value: d.name, placeholder: "Name (optional)", maxLength: 200,
    oninput: () => (d.name = nameInput.value) });
  const text = h("textarea", { rows: 5, maxLength: 50000, value: d.text, placeholder: kind === "prompt" ? "Prompt" : "Snippet",
    oninput: () => (d.text = text.value) });
  const segs = ["prompt", "snippet"].map((k) => h("button", { className: "seg", textContent: k === "prompt" ? "Prompt" : "Snippet",
    "aria-pressed": String(k === d.kind), onclick: () => {
      d.kind = k;
      segs.forEach((s, i) => s.setAttribute("aria-pressed", String(["prompt", "snippet"][i] === d.kind)));
      nameInput.hidden = d.kind === "snippet"; // a snippet's text is its name
    } }));
  nameInput.hidden = d.kind === "snippet";
  const save = () => {
    if (!d.text.trim()) return toast("The text is empty", "bad");
    storeDraft();
    render();
  };
  return h("div", { className: "prompt-edit" }, nameInput, text,
    h("div", { className: "prompt-actions" },
      h("div", { className: "segmented", role: "group", "aria-label": "Type" }, ...segs),
      h("span", { className: "spacer" }),
      h("button", { className: "chip", textContent: "Cancel", onclick: () => { editing = draft = null; render(); } }),
      h("button", { className: "chip primary-chip", textContent: "Save", onclick: save })));
}

function item(e) {
  const li = h("li", { className: `prompt-item${open === e.id ? " open" : ""}` });
  li.dataset.id = e.id;
  if (editing === e.id) {
    li.append(editor(e));
    return li;
  }
  const body = kind === "prompt"
    ? [h("span", { className: "item-title", textContent: nameOf(e) }),
      h("span", { className: "item-meta", textContent: isoDateTime(e.created) }),
      h("span", { className: "prompt-text", textContent: e.text })]
    : [h("span", { className: "prompt-text", textContent: e.text })];
  li.append(
    h("span", { className: "drag", "aria-hidden": "true", textContent: "⠿" }),
    h("button", { className: "prompt-main", "aria-expanded": String(open === e.id), onclick: () => { open = open === e.id ? null : e.id; render(); } }, ...body),
    h("span", { className: "order-btns" },
      h("button", { className: "icon-btn up", "aria-label": "Move up", textContent: "↑", onclick: () => moveItem(li, -1, saveOrder) }),
      h("button", { className: "icon-btn down", "aria-label": "Move down", textContent: "↓", onclick: () => moveItem(li, 1, saveOrder) })));
  if (open === e.id) {
    li.append(h("div", { className: "prompt-actions" },
      h("button", { className: "chip", textContent: "Edit", onclick: () => { keepDraft(); editing = e.id; render(); } }),
      h("button", { className: "chip danger", textContent: "Delete", onclick: () => {
        if (!confirm(`Delete this ${e.kind}? It is removed from all your devices.`)) return;
        deleteEntry(e.id);
        render();
      } })));
  }
  return li;
}

const saveOrder = () => reorder([...$("#prompt-list").children].map((li) => li.dataset.id).filter(Boolean));

function render() {
  if ($("#view-prompts").hidden) return;
  for (const b of $("#prompt-kind").children) b.setAttribute("aria-pressed", String(b.dataset.kind === kind));
  const terms = $("#prompt-search").value.toLowerCase().split(/\s+/).filter(Boolean);
  const all = visible(kind);
  const shown = all.filter((e) => terms.every((t) => `${e.name} ${e.text}`.toLowerCase().includes(t)));
  const list = $("#prompt-list");
  list.replaceChildren(...(editing === "new" ? [h("li", { className: "prompt-item" }, editor(null))] : []), ...shown.map(item));
  $("#prompt-reorder").hidden = all.length < 2 || terms.length > 0;
  $("#prompt-empty").hidden = shown.length > 0 || editing === "new";
  $("#prompt-empty").textContent = all.length ? "No matches."
    : kind === "prompt" ? "No prompts yet. Tap + New, or save one from a text field (☰)."
      : "No snippets yet. Tap + New, or save one from a text field (☰).";
  const s = syncState();
  $("#prompt-sync").textContent = s.ok === false
    ? `Not synced with the PC (${s.error}). Everything is kept on this phone.`
    : s.at ? `Synced with the PC · ${isoDateTime(s.at)}` : "Not synced with the PC yet.";
}

export function showPrompts() {
  render();
  syncLibrary();
}

export function leavePrompts() {
  keepDraft();
  editing = null;
  $("#prompt-list").classList.remove("reordering");
  $("#prompt-reorder").textContent = "Reorder";
}

export function initPrompts() {
  onLibraryChange(() => editing === null && render()); // an edit in progress isn't thrown away
  enableDrag($("#prompt-list"), saveOrder);
  $("#prompt-kind").addEventListener("click", (e) => {
    const k = e.target.closest(".seg")?.dataset.kind;
    if (!k || k === kind) return;
    keepDraft();
    kind = k;
    open = editing = null;
    $("#prompt-search").value = "";
    render();
  });
  $("#prompt-search").addEventListener("input", render);
  $("#prompt-new").addEventListener("click", () => {
    keepDraft();
    editing = "new";
    render();
    $("#prompt-list textarea")?.focus();
  });
  $("#prompt-reorder").addEventListener("click", () => {
    const on = $("#prompt-list").classList.toggle("reordering");
    $("#prompt-reorder").textContent = on ? "Done" : "Reorder";
  });
}

// ---------- the ☰ menu on a text field ----------
function openMenu(anchor, items, onClose) {
  const close = () => {
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("hashchange", close); // Back or another tab: the menu goes too
    onClose();
  };
  window.addEventListener("hashchange", close);
  const outside = (e) => !menu.contains(e.target) && e.target !== anchor && close();
  const menu = h("div", { className: "menu", role: "menu" }, ...items.map((it) =>
    h("button", { className: "menu-item", role: "menuitem", onclick: () => { close(); it.run(); } },
      h("span", { textContent: it.label }), it.hint ? h("small", { textContent: it.hint }) : "")));
  // Keeps the text field's keyboard and selection while the menu is used.
  menu.addEventListener("pointerdown", (e) => e.preventDefault());
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  menu.style.right = `${document.documentElement.clientWidth - r.right}px`;
  document.body.append(menu);
  document.addEventListener("pointerdown", outside, true);
  return close;
}

const describePrompt = (e) => ({ name: nameOf(e), folder: e.text.replace(/\s+/g, " ").slice(0, 140) });

/** Snippets to tick in the order they should go in (numbered, with a live preview). Resolves with the
 * text to insert, joined by the separator when there are several, or undefined when closed. */
function pickSnippets(list) {
  return new Promise((resolve) => {
    const order = []; // ids, in the order they were tapped
    let sep = setting("snippetSeparator", ", ");
    const joined = () => order.map((id) => list.find((e) => e.id === id).text).join(sep.replace(/\\n/g, "\n"));
    const search = h("input", { type: "search", placeholder: "Search…", className: "picker-search", "aria-label": "Search snippets" });
    const sepInput = h("input", { type: "text", value: sep, "aria-label": "Separator", className: "sep-input" });
    const preview = h("p", { className: "snippet-preview", "aria-live": "polite" });
    const ul = h("ul", { className: "picker-list" });
    const insert = h("button", { className: "primary insert-btn" });
    const close = (value, viaBack = false) => {
      if (!viaBack) release();
      overlay.remove();
      resolve(value);
    };
    const release = closeOnBack(() => close(undefined, true));
    const render = () => {
      const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      ul.replaceChildren(...list.filter((e) => terms.every((t) => e.text.toLowerCase().includes(t))).map((e) => {
        const n = order.indexOf(e.id) + 1;
        return h("li", {}, h("button", { className: "picker-option snippet-option", "aria-pressed": String(n > 0),
          onclick: () => {
            if (n) order.splice(n - 1, 1); // untick: the ones after move up a number
            else order.push(e.id);
            render();
          } },
        h("span", { className: "order-badge", textContent: n || "" }),
        h("span", { className: "picker-name", textContent: e.text.replace(/\s+/g, " ") })));
      }));
      if (!ul.children.length) ul.append(h("li", { className: "empty", textContent: "No matches" }));
      preview.textContent = order.length ? joined() : "Tap snippets in the order they should go in.";
      preview.classList.toggle("empty", !order.length);
      insert.disabled = !order.length;
      insert.textContent = order.length > 1 ? `Insert ${order.length} snippets` : "Insert snippet";
    };
    search.addEventListener("input", render);
    sepInput.addEventListener("input", () => {
      sep = sepInput.value;
      setSetting("snippetSeparator", sep);
      render();
    });
    insert.addEventListener("click", () => close(joined())); // one snippet: no separator
    const overlay = h("div", { className: "picker", role: "dialog", "aria-modal": "true", "aria-label": "Insert snippets" },
      h("div", { className: "picker-head" },
        h("button", { className: "icon-btn", "aria-label": "Close", textContent: "✕", onclick: () => close(undefined) }),
        h("strong", { textContent: "Insert snippets" })),
      search,
      h("label", { className: "sep-row" }, h("span", { textContent: "Separator" }), sepInput,
        h("small", { className: "item-meta", textContent: "\\n = new line" })),
      preview, ul, h("div", { className: "picker-foot" }, insert));
    document.body.append(overlay);
    render();
  });
}

/** Puts text into the field the way typing would (saved with the workflow). */
function setText(field, value, caret) {
  field.value = value;
  if (caret !== undefined) field.setSelectionRange(caret, caret);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The ☰ button for a text field (a textarea or a one-line input). */
/** Asks for a name and keeps the text as a prompt (from a field, or what a text node showed). */
export function saveAsPrompt(text) {
  const name = prompt("Name of the prompt", firstWords(text));
  if (name === null) return;
  addEntry("prompt", text, name.trim());
  toast("Saved to Prompts", "ok");
}

export function fieldMenu(field, label) {
  const btn = h("button", { className: "icon-btn field-menu", "aria-label": `Prompts for ${label}`, "aria-haspopup": "menu", textContent: "☰" });
  btn.addEventListener("pointerdown", (e) => e.preventDefault()); // the field keeps its focus and selection
  let close = null; // set while the menu is open
  btn.addEventListener("click", () => {
    if (close) return close();
    close = openMenu(btn, [
      { label: "Save as prompt", run: () => {
        if (!field.value.trim()) return toast("Nothing to save: the field is empty", "bad");
        saveAsPrompt(field.value);
      } },
      { label: "Save as snippet", hint: "the marked text, or all of it", run: () => {
        // Exactly as marked, spaces included: a snippet is inserted as it was saved.
        const marked = field.value.slice(field.selectionStart, field.selectionEnd);
        const text = marked || field.value;
        if (!text.trim()) return toast("Nothing to save: the field is empty", "bad");
        addEntry("snippet", text);
        toast("Saved to Snippets", "ok");
      } },
      { label: "Load prompt…", hint: "replaces the text in this field", run: async () => {
        const list = visible("prompt");
        if (!list.length) return toast("No prompts saved yet", "bad");
        field.blur(); // closes the keyboard, which would push the top of the list out of sight
        const chosen = await pick("Load prompt", list, null, describePrompt, false); // keyboard only when tapping search
        if (!chosen) return;
        if (field.value.trim() && field.value !== chosen.text && !confirm("Replace the text in this field with the prompt?")) return;
        setText(field, chosen.text);
      } },
      { label: "Insert snippet…", hint: "at the cursor", run: async () => {
        const list = visible("snippet");
        if (!list.length) return toast("No snippets saved yet", "bad");
        const start = field.selectionStart ?? field.value.length;
        const end = field.selectionEnd ?? start;
        field.blur(); // closes the keyboard (the cursor position is kept above)
        const text = await pickSnippets(list);
        if (text === undefined) return;
        const before = field.value.slice(0, start);
        const after = field.value.slice(end);
        setText(field, before + text + after, before.length + text.length); // exactly as saved, nothing added
      } },
    ], () => (close = null));
  });
  return btn;
}

// "Share to phone": picks the settings of the open workflow that the phone app may change.
import { app } from "../../scripts/app.js";

const API = "/phone/api";
const LORA_LOADER = "Power Lora Loader (rgthree)";
const IMAGE_LOADERS = new Set(["LoadImage", "TrixLoadImageAIO"]);
const SKIP_INPUTS = new Set(["PowerLoraLoaderHeaderWidget", "➕ Add Lora"]);

// The id the PC gives a share (workflows.py slugify): the same name means the same workflow on the phone.
function slugify(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
  if (slug) return slug;
  let code = 0x811c9dc5; // no a-z or 0-9 in the name: FNV-1a over its UTF-8, as on the PC
  for (const byte of new TextEncoder().encode(name)) code = Math.imul(code ^ byte, 0x01000193) >>> 0;
  return `workflow-${code.toString(16).padStart(8, "0")}`;
}

/** Whether share s on the phone comes from the open workflow, decided as on the PC (workflows.same_workflow):
 * the same saved file, else ComfyUI's id of the workflow (every unsaved one is called "Unsaved Workflow").
 * Another saved file is another workflow ("Save As" keeps the id), unless the old file is gone (moved or
 * renamed). A copy made on the phone never is. Returns "file", "id" or false. */
function sameWorkflow(s, path, graphId) {
  if (!s.source) return false;
  if (path && s.source_path) {
    if (s.source_path === path) return "file";
    if (!s.pc_missing) return false;
  }
  return !!graphId && s.graph_id === graphId && "id";
}

const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number";
const keyOf = (f) => `${f.node}\u0000${f.input}`;
const SWITCH_ONLY = "#bypass"; // input name of a card that only has the bypass switch

function kindOf(spec, classType, input, value) {
  if (spec) {
    const [type, opts = {}] = spec;
    if (input === "image" && (opts.image_upload || IMAGE_LOADERS.has(classType))) return "image";
    if (Array.isArray(type) || type === "COMBO") return "combo";
    if (type === "INT") return /seed/i.test(input) ? "seed" : "int";
    if (type === "FLOAT") return "float";
    if (type === "BOOLEAN") return "bool";
    if (type === "STRING") return opts.multiline ? "text" : "string";
    return null; // everything else is a socket type, not a setting
  }
  // Sub-options of dynamic combos ("sampling_mode.temperature") aren't in object_info; go by value.
  if (!input.includes(".")) return null;
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "string";
  return null;
}

function isSuggested(classType, input, kind) {
  if (kind === "seed" || kind === "loras" || kind === "image") return true;
  if (classType.startsWith("Primitive")) return true;
  if (classType.startsWith("CLIPTextEncode") && input === "text") return true;
  if (classType === "ResolutionSelector" && (input === "aspect_ratio" || input === "megapixels")) return true;
  if (/Latent/.test(classType) && (input === "width" || input === "height")) return true;
  return input === "unet_name" || input === "ckpt_name";
}

// A widget exposed on a subgraph reaches the inner node through a link from the subgraph's inputs.
// Returns { group: subgraph title, name: exposed name } for such an input of node "outer:inner", else null.
function exposedAs(id, input) {
  try {
    const path = id.split(":").map(Number);
    if (path.length < 2) return null;
    let graph = app.graph;
    let outer = null;
    for (const part of path.slice(0, -1)) {
      outer = graph.getNodeById(part);
      graph = outer?.subgraph;
      if (!graph) return null;
    }
    const slot = graph.getNodeById(path.at(-1))?.inputs?.find((i) => i.name === input);
    const link = slot?.link != null ? graph.links?.get?.(slot.link) ?? graph.links?.[slot.link] : null;
    if (!link || Number(link.origin_id) !== -10) return null; // -10 (sometimes as text): the subgraph's input node
    const exposed = graph.inputs?.[link.origin_slot];
    return { group: outer.title || graph.name, name: exposed?.label || exposed?.name || input };
  } catch {
    return null; // frontend internals changed: fall back to the inner node's title
  }
}

/** The canvas node behind a prompt id ("12", or "75:190" inside a subgraph). */
function graphNode(id) {
  try {
    let graph = app.graph;
    let node = null;
    for (const part of id.split(":").map(Number)) {
      if (node) graph = node.subgraph;
      node = graph?.getNodeById(part) ?? null;
    }
    return node;
  } catch {
    return null;
  }
}

const BYPASS_MODE = 4; // LiteGraph's mode of a bypassed node; 0 = runs

/** Nodes bypassed on the canvas, also inside subgraphs. Not a bypassed subgraph itself: the phone has no single
 * node to switch for it. */
function bypassedNodes(graph, found = []) {
  for (const node of graph?._nodes ?? []) {
    if (node.subgraph) {
      if (node.mode === 0) bypassedNodes(node.subgraph, found);
    } else if (node.mode === BYPASS_MODE) {
      found.push(node);
    }
  }
  return found;
}

/** ComfyUI's export with these bypassed nodes switched on for the moment. */
async function exportWith(nodes) {
  try {
    nodes.forEach((n) => (n.mode = 0));
    return await app.graphToPrompt();
  } finally {
    nodes.forEach((n) => (n.mode = BYPASS_MODE));
  }
}

/** base: the workflow as ComfyUI sends it. ComfyUI's export leaves out nodes bypassed on the PC; full has them
 * too, only to list them (pcOff: their prompt ids). A bypassed node ComfyUI doesn't know stays out: off, it
 * doesn't stop the workflow from running. */
async function exportWorkflow(defs) {
  const base = await app.graphToPrompt();
  const off = bypassedNodes(app.graph).filter((n) => defs[n.comfyClass ?? n.type]);
  const full = off.length ? await exportWith(off) : base;
  return { base, full, pcOff: new Set(Object.keys(full.output).filter((id) => !(id in base.output))) };
}

// Nodes that show text or a value (Preview as Text, Show Text, Display Any, Display Int…): the phone shows
// what they show. "int" only as a word, or every "Preview Point Cloud" would count.
const TEXT_NODE = /(preview|show|display).*(text|any|string|(?<![a-z])int|float|number|bool|value|json)|(text|string).*(preview|show|display)/i;

/** The workflow's text nodes, top to bottom on the canvas (the default order on the phone). */
function collectTextNodes(output, defs) {
  return Object.entries(output)
    .filter(([, n]) => defs[n.class_type]?.output_node
      && (TEXT_NODE.test(n.class_type) || TEXT_NODE.test(defs[n.class_type].display_name ?? "")))
    .map(([id, n]) => ({ id, title: n._meta?.title || n.class_type, pos: graphNode(id)?.pos ?? [Infinity, Infinity] }))
    .sort((a, b) => a.pos[1] - b.pos[1] || a.pos[0] - b.pos[0]);
}

const NOTE_TYPES = new Set(["Note", "MarkdownNote"]);

// Notes live only on the canvas (they never go to ComfyUI), so they are read from the graph, subgraphs too.
function collectNotes() {
  const notes = [];
  const walk = (graph, prefix) => {
    for (const node of graph?._nodes ?? graph?.nodes ?? []) {
      if (NOTE_TYPES.has(node.type)) {
        const text = String(node.widgets?.[0]?.value ?? node.widgets_values?.[0] ?? "").slice(0, 20000); // the PC's limit
        const label = node.title || "Note";
        notes.push({ node: `note:${prefix}${node.id}`, input: "text", kind: "note", label, shown: label, value: text, text });
      }
      if (node.subgraph) walk(node.subgraph, `${prefix}${node.id}:`);
    }
  };
  try {
    walk(app.graph, "");
  } catch {
    // frontend internals changed: share without notes
  }
  return notes;
}

// Text inputs with ComfyUI's dynamic prompts ({a|b}, comments): what was typed. Turning the graph into a
// prompt already rolled them once; the PC rolls them again for every image from the phone.
function dynamicTemplates(output, defs) {
  const templates = {};
  for (const [id, node] of Object.entries(output)) {
    const def = defs[node.class_type]?.input ?? {};
    for (const [input, value] of Object.entries(node.inputs)) {
      const spec = def.required?.[input] ?? def.optional?.[input];
      if (typeof value !== "string" || !spec?.[1]?.dynamicPrompts) continue;
      // shortcut: a widget exposed on a subgraph keeps its text on the outer node; its rolled text is used as is
      const typed = exposedAs(id, input) ? null : graphNode(id)?.widgets?.find((w) => w.name === input)?.value;
      templates[`${id}/${input}`] = typeof typed === "string" ? typed : value;
    }
  }
  return templates;
}

// The name the node shows for a setting: one the user gave it on the canvas, else the node's display name.
function displayName(id, input, spec) {
  const widget = graphNode(id)?.widgets?.find((w) => w.name === input);
  return widget?.label || spec?.[1]?.display_name || input;
}

const fits = (a, b) => {
  const types = (t) => String(t ?? "").toUpperCase().split(",");
  return a === b || a === "*" || b === "*" || types(a).some((t) => types(b).includes(t));
};

// What each output of a bypassed node hands through, by ComfyUI's rule: the input in the same slot if its
// type fits, else the first input of the output's type. null = nothing fits, the link is dropped.
// shortcut: ComfyUI also weighs the type of the input on the other end; this goes by the output type only.
function passthrough(id) {
  const node = graphNode(id);
  const inputs = node?.inputs ?? [];
  return (node?.outputs ?? []).map((out, i) => {
    const same = inputs[i] && fits(inputs[i].type, out.type) ? inputs[i] : null;
    const match = same ?? inputs.find((inp) => inp.type === out.type) ?? inputs.find((inp) => fits(inp.type, out.type));
    return match?.name ?? null;
  });
}

function preview(field) {
  if (field.kind === "loras") return field.value;
  const text = typeof field.value === "string" ? field.value.replace(/\s+/g, " ").trim() : JSON.stringify(field.value);
  if (text === "") return "(empty)";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

// Turns the API-format prompt into groups of settings, one group per node.
function collectNodes(output, defs) {
  const nodes = [];
  for (const [id, node] of Object.entries(output)) {
    const def = defs[node.class_type]?.input ?? {};
    const fields = [];
    if (node.class_type === LORA_LOADER) {
      const loras = Object.entries(node.inputs).filter(([k]) => /^lora_\d+$/.test(k)).map(([, v]) => v);
      fields.push({ node: id, input: "loras", kind: "loras", value: `${loras.filter((l) => l?.on).length} of ${loras.length} on` });
    }
    for (const [input, value] of Object.entries(node.inputs)) {
      if (isLink(value) || SKIP_INPUTS.has(input) || (value !== null && typeof value === "object")) continue;
      const spec = def.required?.[input] ?? def.optional?.[input];
      const kind = kindOf(spec, node.class_type, input, value);
      if (kind) fields.push({ node: id, input, kind, value, name: displayName(id, input, spec) });
    }
    // Nodes without settings (an upscaler, say) are listed too: they can still get a bypass switch.
    let title = node._meta?.title || node.class_type;
    const titleOnly = fields.length === 1 || node.class_type.startsWith("Primitive");
    for (const f of fields) {
      const exposed = exposedAs(id, f.input);
      const name = f.name ?? f.input;
      f.label = exposed ? `${exposed.group} › ${exposed.name}` : titleOnly ? title : `${title} › ${name}`;
      f.shown = exposed?.name ?? name;
      f.suggested = !!exposed || isSuggested(node.class_type, f.input, f.kind); // exposed on purpose by the user
      if (exposed) title = exposed.group; // what the user sees on the canvas
    }
    nodes.push({ id, title, classType: node.class_type, fields });
  }
  return nodes;
}

function injectStyles() {
  if (document.getElementById("phone-share-styles")) return;
  const style = document.createElement("style");
  style.id = "phone-share-styles";
  style.textContent = `
    .phone-share-overlay { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center;
      background: rgba(0,0,0,.55); }
    .phone-share { width: min(680px, 94vw); max-height: 86vh; display: flex; flex-direction: column;
      background: var(--comfy-menu-bg, #222); color: var(--fg-color, #ddd); border: 1px solid var(--border-color, #444);
      border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,.5); font-size: 14px; }
    .phone-share header, .phone-share footer { padding: 14px 18px; display: flex; gap: 10px; align-items: center; }
    .phone-share header { flex-direction: column; align-items: stretch; border-bottom: 1px solid var(--border-color, #444); }
    .phone-share h2 { margin: 0; font-size: 17px; }
    .phone-share .hint { margin: 0; color: var(--descrip-text, #999); }
    .phone-share label.name { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
    .phone-share input[type=text] { flex: 1 1 220px; min-width: 0; padding: 6px 8px; border-radius: 6px; font: inherit;
      background: var(--comfy-input-bg, #111); color: inherit; border: 1px solid var(--border-color, #444); }
    .phone-share .list { overflow: auto; overflow-x: hidden; padding: 8px 18px; flex: 1; }
    .phone-share details { border-bottom: 1px solid var(--border-color, #333); padding: 6px 0; }
    .phone-share summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: baseline; }
    .phone-share summary small, .phone-share .kind, .phone-share .preview { color: var(--descrip-text, #999); }
    .phone-share .count { margin-left: auto; font-size: 12px; color: var(--descrip-text, #999); }
    .phone-share .row { display: grid; grid-template-columns: auto minmax(0, max-content) auto minmax(0, 1fr); gap: 8px;
      align-items: center; padding: 3px 0 3px 18px; cursor: pointer; }
    .phone-share .row > span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .phone-share .internal { margin-left: 6px; font-size: 11px; color: var(--descrip-text, #999); }
    .phone-share .kind { font-size: 11px; border: 1px solid var(--border-color, #444); border-radius: 4px; padding: 0 4px; }
    .phone-share .preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .phone-share .more > summary { font-weight: 600; padding: 6px 0; }
    .phone-share .row.bypass > span:nth-child(2) { font-style: italic; }
    .phone-share footer { border-top: 1px solid var(--border-color, #444); }
    .phone-share footer .spacer { flex: 1; }
    .phone-share .error { color: #f87171; }
    .phone-share button { font: inherit; padding: 6px 14px; border-radius: 6px; cursor: pointer;
      border: 1px solid var(--border-color, #444); background: var(--comfy-input-bg, #111); color: inherit; }
    .phone-share button.primary { background: #6d5dfc; border-color: #6d5dfc; color: #fff; }
    .phone-share button.danger { color: #f87171; }
    .phone-share button:disabled { opacity: .5; cursor: default; }
  `;
  document.head.append(style);
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function nodeGroup(node, checked, bypassable, open) {
  const boxes = node.fields.map((f) => el("input", { type: "checkbox", checked: checked.has(keyOf(f)), _field: f }));
  const bypassBox = el("input", { type: "checkbox", checked: bypassable.has(node.id) });
  const count = el("span", { className: "count" });
  const bypassHint = el("span", { className: "preview" });
  // The user's own tick, back when no setting forces it. Forced last time says nothing about it: then off.
  let ownBypass = bypassBox.checked && !(node.pcOff && boxes.some((b) => b.checked));
  const update = () => {
    // Bypassed on the PC with a setting on the phone: always with its switch, or it would suddenly run there.
    const forced = !!node.pcOff && boxes.some((b) => b.checked);
    bypassBox.checked = forced || ownBypass;
    bypassBox.disabled = forced;
    bypassHint.textContent = forced ? "ticked because the node is bypassed on the PC: with a setting shared, it always gets its switch"
      : node.fields.length ? "a switch on the phone turns this node off (alone: a card with just the switch)"
        : "a card with a switch on the phone turns this node off";
    const n = boxes.filter((b) => b.checked).length;
    count.textContent = [n && `${n} selected`, bypassBox.checked && "bypass"].filter(Boolean).join(" · ");
  };
  bypassBox.addEventListener("change", () => (ownBypass = bypassBox.checked));
  [...boxes, bypassBox].forEach((b) => b.addEventListener("change", update));
  update();
  const rows = node.fields.map((f, i) =>
    // The internal name too, when it differs: it tells similar-sounding settings apart.
    el("label", { className: "row" }, boxes[i],
      el("span", {}, f.shown, f.shown !== f.input ? el("small", { className: "internal", textContent: f.input }) : ""),
      el("span", { className: "kind", textContent: f.kind }), el("span", { className: "preview", textContent: preview(f) })));
  const bypassRow = el("label", { className: "row bypass" }, bypassBox, el("span", { textContent: "Bypass on phone" }),
    el("span", { className: "kind", textContent: "switch" }), bypassHint);
  const summary = el("summary", {}, el("span", { textContent: node.title }),
    el("small", { textContent: `${node.classType} · #${node.id}${node.pcOff ? " · bypassed on the PC: on the phone with a switch, off at first" : ""}` }), count);
  return { element: el("details", { open }, summary, ...rows, bypassRow), boxes, bypassBox, node };
}

async function openShareDialog() {
  injectStyles();
  // toast.add returns nothing, so no "?? alert": that showed every message twice.
  const toast = (severity, summary, detail) => {
    const toasts = app.extensionManager?.toast;
    if (toasts) toasts.add({ severity, summary, detail, life: 4000 });
    else alert(`${summary}\n${detail ?? ""}`);
  };

  let base, full, pcOff, defs, shares;
  try {
    [defs, shares] = await Promise.all([
      fetch("/api/object_info").then((r) => r.json()),
      fetch(`${API}/workflows`).then((r) => r.json()),
    ]);
    ({ base, full, pcOff } = await exportWorkflow(defs));
  } catch (err) {
    toast("error", "Share to phone failed", String(err));
    return;
  }
  // A node ComfyUI doesn't know (not installed, or newer than this ComfyUI) couldn't run anyway.
  const unknown = Object.entries(full.output).filter(([, n]) => !defs[n.class_type])
    .map(([id, n]) => n.class_type ?? graphNode(id)?.type ?? `#${id}`);
  if (unknown.length) {
    toast("error", "Can't share this workflow", `ComfyUI doesn't know these nodes: ${[...new Set(unknown)].join(", ")}. `
      + "Install or update them first.");
    return;
  }

  const active = app.extensionManager?.workflow?.activeWorkflow;
  const source = active?.filename ?? "";
  // The saved file ("workflows/x.json"), so the phone can tell when it changed; none for an unsaved one.
  const path = active && !active.isTemporary && active.path?.startsWith("workflows/") ? active.path : null;
  const graphId = /[^0-]/.test(base.workflow?.id ?? "0") ? base.workflow.id : null;
  const previous = shares.find((s) => sameWorkflow(s, path, graphId));
  const byId = previous && sameWorkflow(previous, path, graphId) === "id";
  let checked;
  let bypassable = new Set();
  let record = null;
  if (previous) {
    record = await fetch(`${API}/workflows/${previous.id}`).then((r) => r.json());
    checked = new Set(record.fields.map(keyOf));
    bypassable = new Set(Object.keys(record.bypass ?? {}));
  }

  const nodes = collectNodes(full.output, defs);
  nodes.forEach((n) => (n.pcOff = pcOff.has(n.id)));
  // Suggestions are ticked only on nodes that run on the PC; bypassed ones are listed, never ticked by themselves.
  if (!checked) checked = new Set(nodes.filter((n) => !n.pcOff).flatMap((n) => n.fields.filter((f) => f.suggested).map(keyOf)));

  const nameInput = el("input", { type: "text", value: previous?.name ?? source ?? "Workflow", maxLength: 120 });
  // Renamed on the phone: that name stays; changing the name here makes it a new workflow on the phone.
  const phoneName = previous?.phone_name
    ? el("p", { className: "hint", textContent: `Renamed on the phone to "${previous.phone_name}"; that name stays.` }) : null;
  // Found by the id alone (unsaved, from the same template or image, or a moved file): say so, and how to keep both.
  const foundBy = byId
    ? el("p", { className: "hint", textContent: "Recognised by its workflow id. To share it as another workflow, give it a new name." })
    : null;
  const error = el("p", { className: "error", hidden: true });
  const list = el("div", { className: "list" });
  const allBoxes = [];
  const groups = [];
  // Suggestions stay visible when updating a share, but only what was shared before is ticked.
  const picked = nodes.filter((n) => bypassable.has(n.id) || n.fields.some((f) => checked.has(keyOf(f)) || f.suggested));
  const rest = nodes.filter((n) => !picked.includes(n));
  for (const n of picked) {
    const g = nodeGroup(n, checked, bypassable, true);
    allBoxes.push(...g.boxes);
    groups.push(g);
    list.append(g.element);
  }
  if (rest.length) {
    const more = el("details", { className: "more" }, el("summary", { textContent: `More nodes (${rest.length})` }));
    for (const n of rest) {
      const g = nodeGroup(n, checked, bypassable, false);
      allBoxes.push(...g.boxes);
      groups.push(g);
      more.append(g.element);
    }
    list.append(more);
  }
  // Notes: shown (and editable) on the phone below the settings, never applied to the workflow.
  const notes = collectNotes();
  if (notes.length) {
    const noteBoxes = notes.map((f) => el("input", { type: "checkbox", checked: checked.has(keyOf(f)), _field: f }));
    allBoxes.push(...noteBoxes);
    list.append(el("details", { open: noteBoxes.some((b) => b.checked) },
      el("summary", {}, el("span", { textContent: `Notes (${notes.length})` }),
        el("small", { textContent: "text to read on the phone; not part of the workflow" })),
      ...notes.map((f, i) => el("label", { className: "row" }, noteBoxes[i], el("span", { textContent: f.shown }),
        el("span", { className: "kind", textContent: "note" }), el("span", { className: "preview", textContent: preview(f) })))));
  }

  // Texts on the phone, in the order they are ticked. New or older shares: all of them, top to bottom;
  // a text node added since the last share is ticked too, at the end.
  const textNodes = collectTextNodes(full.output, defs);
  const choice = record?.text_choice;
  const isNew = (id) => !pcOff.has(id) && (!choice || (!choice.order.includes(id) && !choice.hidden.includes(id)));
  let textOrder = [...(choice?.order ?? []).filter((id) => textNodes.some((t) => t.id === id)),
    ...textNodes.filter((t) => isNew(t.id)).map((t) => t.id)];
  if (textNodes.length) {
    const places = new Map();
    const paint = () => textNodes.forEach((t) => {
      const i = textOrder.indexOf(t.id);
      places.get(t.id).textContent = i < 0 ? "not shown" : `shown as #${i + 1}`;
    });
    const rows = textNodes.map((t) => {
      const box = el("input", { type: "checkbox", checked: textOrder.includes(t.id) });
      box.addEventListener("change", () => {
        textOrder = textOrder.filter((id) => id !== t.id);
        if (box.checked) textOrder.push(t.id);
        paint();
      });
      places.set(t.id, el("span", { className: "preview" }));
      return el("label", { className: "row" }, box,
        el("span", { textContent: pcOff.has(t.id) ? `${t.title} (bypassed on the PC: shown only with Bypass on phone)` : t.title }),
        el("span", { className: "kind", textContent: "text" }), places.get(t.id));
    });
    paint();
    list.append(el("details", { open: true },
      el("summary", {}, el("span", { textContent: `Texts on phone (${textNodes.length})` }),
        el("small", { textContent: "what these nodes show, in the order you tick them" })), ...rows));
  }

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };

  const shareBtn = el("button", { className: "primary", textContent: previous ? "Update on phone" : "Share" });
  const cancelBtn = el("button", { textContent: "Cancel", onclick: close });
  const footer = el("footer", {}, error, el("span", { className: "spacer" }));
  if (previous) {
    footer.append(el("button", {
      className: "danger",
      textContent: "Remove from phone",
      onclick: async () => {
        if (!confirm(`Remove "${previous.name}" from the phone?`)) return;
        const res = await fetch(`${API}/workflows/${previous.id}`, { method: "DELETE" });
        if (res.ok) {
          toast("info", "Removed from phone", previous.name);
          close();
        } else {
          error.textContent = `Remove failed (HTTP ${res.status})`;
          error.hidden = false;
        }
      },
    }));
  }
  footer.append(cancelBtn, shareBtn);

  shareBtn.onclick = async () => {
    const name = nameInput.value.trim();
    const fields = allBoxes.filter((b) => b.checked)
      .map(({ _field: f }) => ({ node: f.node, input: f.input, kind: f.kind, label: f.label, ...(f.kind === "note" && { text: f.text }) }));
    const switched = groups.filter((g) => g.bypassBox.checked); // ticked by itself where a setting forces it (nodeGroup)
    const bypass = Object.fromEntries(switched.map((g) => [g.node.id, passthrough(g.node.id)]));
    // Bypass without a shared setting: the phone gets a card with just the switch.
    for (const g of switched) {
      if (!g.boxes.some((b) => b.checked)) fields.push({ node: g.node.id, input: SWITCH_ONLY, kind: "bypass", label: g.node.title });
    }
    error.hidden = true;
    if (!name) {
      error.textContent = "Please enter a name.";
      error.hidden = false;
      return;
    }
    // The phone knows a workflow by its name. Another file under the same name would replace it.
    const taken = shares.find((s) => s.id === slugify(name) && s.id !== previous?.id);
    if (taken && !confirm(`"${taken.phone_name || taken.name}" is already on the phone, shared from `
      + `"${taken.source || "another workflow"}".\n\nReplace it with this workflow? Its settings on the phone start fresh.`)) {
      error.textContent = "Choose another name to keep both.";
      error.hidden = false;
      nameInput.focus();
      return;
    }
    shareBtn.disabled = true;
    try {
      // Only the bypassed nodes that come to the phone are switched on for the export. ComfyUI bypasses all others
      // itself, as on the PC: the dialog's passthrough is only a close guess of ComfyUI's rule.
      const coming = switched.map((g) => g.node.id).filter((id) => pcOff.has(id));
      const prompt = coming.length ? await exportWith(coming.map(graphNode).filter(Boolean)) : base;
      const texts = textOrder.filter((id) => id in prompt.output);
      const res = await fetch(`${API}/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, source, path, prompt: prompt.output, workflow: base.workflow, fields, bypass,
          pc_bypassed: Object.fromEntries(coming.map((id) => [id, passthrough(id)])),
          dynamic: dynamicTemplates(prompt.output, defs),
          texts: { order: texts, hidden: textNodes.map((t) => t.id).filter((id) => id in prompt.output && !texts.includes(id)) } }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      // A new name gave a new workflow on the phone (its settings start fresh). The old one goes only if wanted;
      // closing the question keeps both.
      const renamed = previous && body.id !== previous.id;
      const was = previous?.phone_name || previous?.name;
      if (renamed && confirm(`Shared as "${name}". Also remove "${was}" from the phone? What was set there goes with it.`
        + "\n\nCancel keeps both.")) {
        await fetch(`${API}/workflows/${previous.id}`, { method: "DELETE" });
      }
      const settings = fields.filter((f) => f.kind !== "bypass" && f.kind !== "note").length;
      const noteCount = fields.filter((f) => f.kind === "note").length;
      const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      const what = [count(settings, "setting", "settings"),
        ...(switched.length ? [count(switched.length, "on/off switch", "on/off switches")] : []),
        ...(noteCount ? [count(noteCount, "note", "notes")] : []),
        ...(texts.length ? [count(texts.length, "text", "texts")] : [])];
      toast("success", previous && !renamed ? "Updated on phone" : "Shared to phone", `${name}: ${what.join(", ")}`);
      close();
    } catch (err) {
      error.textContent = `Share failed: ${err.message}`;
      error.hidden = false;
      shareBtn.disabled = false;
    }
  };

  const titleId = "phone-share-title";
  const dialog = el("div", { className: "phone-share" },
    el("header", {},
      el("h2", { id: titleId, textContent: previous ? "Update on phone" : "Share to phone" }),
      el("p", { className: "hint", textContent: "Tick the settings you want to change on your phone. \"Bypass on phone\" adds an on/off switch for the whole node. The order can be changed in the app." }),
      el("label", { className: "name" }, el("span", { textContent: "Name on phone" }), nameInput),
      ...(phoneName ? [phoneName] : []), ...(foundBy ? [foundBy] : [])),
    list, footer);
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", titleId);
  const overlay = el("div", { className: "phone-share-overlay" }, dialog);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  nameInput.focus();
}

app.registerExtension({
  name: "ComfyUI-from-your-Phone.share",
  commands: [{ id: "phone.share", label: "Share to phone", icon: "pi pi-mobile", function: openShareDialog }],
  menuCommands: [{ path: ["File"], commands: ["phone.share"] }],
});

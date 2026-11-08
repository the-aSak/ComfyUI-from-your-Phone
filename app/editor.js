// Workflow editor: one control per shared field, autosave, reorder and Generate.
import { $, api, h, keyboardOpen, splitPath, thumbUrl, toast } from "./api.js";
import { paintMask } from "./mask.js";
import { pick } from "./picker.js";
import { fieldMenu } from "./prompts.js";
import { enableDrag, moveItem } from "./reorder.js";
import { showTasks } from "./tasks.js";

const keyOf = (f) => `${f.node}/${f.input}`;
const BYPASS = "#bypass"; // in values: ids of the nodes switched off on the phone
const specCache = new Map(); // class_type -> object_info inputs
// values: what the controls show; touched: fields changed on the phone. Only touched fields are
// saved, so fields left alone keep following the PC when the workflow is shared again.
// edited: fields changed since opening. Saving sends only these, so a copy opened offline, older than
// what the PC has, never takes back the fields it didn't change.
let state = null; // { wf, values, touched, edited, count, saveTimer, dirty, uploading }

const changedValues = () => Object.fromEntries([...state.touched].map((k) => [k, state.values[k]]));

async function loadSpecs(classes) {
  await Promise.all([...new Set(classes)].filter((c) => !specCache.has(c)).map(async (c) => {
    try {
      const info = await api(`/api/object_info/${encodeURIComponent(c)}`);
      specCache.set(c, info[c]?.input ?? {});
    } catch {
      specCache.set(c, {}); // controls fall back to plain inputs
    }
  }));
}

function specOf(classType, input) {
  const d = specCache.get(classType) ?? {};
  return d.required?.[input] ?? d.optional?.[input] ?? null;
}

function comboOptions(spec) {
  if (!spec) return [];
  const [type, opts = {}] = spec;
  return Array.isArray(type) ? type : opts.options ?? [];
}

function defaultValue(field, inputs) {
  if (field.kind === "loras") {
    return Object.entries(inputs)
      .filter(([k]) => /^lora_\d+$/.test(k))
      .map(([, l]) => ({ on: !!l?.on, lora: l?.lora ?? "", strength: l?.strength ?? 1 }));
  }
  if (field.kind === "seed") {
    const v = inputs[field.input];
    return { mode: "random", value: Number.isInteger(v) && v >= 0 ? v : 0 };
  }
  if (field.kind === "image") return { image: inputs[field.input], mask: inputs.mask_data ?? null };
  if (field.kind === "note") return field.text ?? ""; // a note on the PC's canvas, not in the workflow
  return inputs[field.input];
}

// ---------- saving ----------

function setStatus(text, bad = false) {
  const el = $("#save-status");
  el.textContent = text;
  el.classList.toggle("bad", bad);
}

function set(key, value) {
  state.values[key] = value;
  state.touched.add(key);
  state.edited.add(key);
  state.dirty = true;
  setStatus("Saving…");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 600);
}

// Values changed while the PC was away, per workflow id: { name, values }, only the fields changed. Only
// their latest state is kept, so reconnecting sends at most one request per workflow.
const PENDING = "pendingValues";
const KEPT = "Saved on this phone – goes to the PC when it's back.";
function readPending() {
  try {
    return JSON.parse(localStorage.getItem(PENDING)) ?? {};
  } catch {
    return {};
  }
}
/** False when the phone can't keep it (storage full, or none in private mode). */
function writePending(pending) {
  try {
    if (Object.keys(pending).length) localStorage.setItem(PENDING, JSON.stringify(pending));
    else localStorage.removeItem(PENDING);
    return true;
  } catch {
    return false;
  }
}
/** With values: only if nothing newer was kept meanwhile (typed while the request was on its way). */
function dropPending(id, values) {
  const pending = readPending();
  if (!(id in pending)) return;
  if (values && JSON.stringify(pending[id].values) !== JSON.stringify(values)) return;
  delete pending[id];
  writePending(pending);
}
const offline = () => document.body.classList.contains("offline");
const pcAway = (err) => err instanceof TypeError || [502, 503, 504].includes(err.status);
// The PC keeps what it has for the fields not sent, and answers with all values it keeps now.
const putValues = (id, values) => api(`api/workflows/${encodeURIComponent(id)}/values`, { method: "PUT", body: { values } });

// sw.js keeps the PC's last answer for each workflow, to show it offline. Saving updates that copy, so
// offline the phone shows what it saved last, not what it showed when the workflow was opened last.
let copying = Promise.resolve(); // one after another: each update builds on the one before
const copyUrl = (id) => new URL(`api/workflows/${encodeURIComponent(id)}`, location.href).href;
function keepCopy(id, changes) {
  copying = copying.then(async () => {
    const cache = await caches.open("data-v1"); // DATA in sw.js
    const url = copyUrl(id);
    const kept = await cache.match(url);
    if (kept && !Object.values(changes).includes(undefined)) await cache.put(url, Response.json({ ...(await kept.json()), ...changes }));
  }).catch(() => {}); // no copy kept, or no room: offline shows the older copy
}
// Deleted is deleted: no copy of its values stays on the phone either.
const dropCopy = (id) => (copying = copying.then(() => caches.open("data-v1")).then((cache) => cache.delete(copyUrl(id))).catch(() => {}));

export async function saveNow() {
  if (!state?.dirty) return;
  clearTimeout(state.saveTimer);
  const { wf } = state;
  // What changed since opening, plus what was kept from before (changed offline, not sent yet).
  const values = { ...readPending()[wf.id]?.values, ...Object.fromEntries([...state.edited].map((k) => [k, state.values[k]])) };
  state.dirty = false;
  // Kept on the phone first (synchronously), so neither the app closing nor a request cut off by the
  // PC going away loses the change. Dropped again once the PC has it.
  const kept = writePending({ ...readPending(), [wf.id]: { name: wf.phone_name || wf.name, values } });
  if (offline()) {
    if (kept) return setStatus(KEPT);
    state.dirty = true;
    return setStatus("Not saved: no room on this phone", true);
  }
  try {
    const saved = await putValues(wf.id, values);
    dropPending(wf.id, values);
    keepCopy(wf.id, { values: saved.values });
    if (state?.wf === wf) setStatus("Saved");
  } catch (err) {
    if (pcAway(err) && kept) {
      if (state?.wf === wf) setStatus(KEPT);
      return;
    }
    if (state?.wf === wf) {
      state.dirty = true;
      setStatus(`Not saved (${err.message})`, true);
    }
  }
}

/** Sends the values kept on the phone, one workflow after another; stops when the PC goes away again. */
let flushing = false;
export async function flushPending() {
  if (flushing) return;
  flushing = true;
  try {
    for (const [id, { name, values }] of Object.entries(readPending())) {
      if (offline()) break;
      if (state?.wf.id === id && document.body.classList.contains("editing")) { // the open workflow sends what its controls show now
        state.dirty = true;
        await saveNow();
        continue;
      }
      try {
        const saved = await putValues(id, values);
        dropPending(id);
        keepCopy(id, { values: saved.values });
      } catch (err) {
        // Gone or no longer valid on the PC: retrying wouldn't help. Anything else is tried again later.
        if (err.status === 404) toast(`"${name}" is no longer on the PC; its changes from this phone were dropped`, "bad");
        else if (err.status === 400) toast(`Changes to "${name}" not saved: ${err.message}`, "bad");
        else continue;
        dropPending(id);
      }
    }
  } finally {
    flushing = false;
  }
}

// ---------- controls ----------

function numberInput(spec, value, kind, onChange) {
  const opts = spec?.[1] ?? {};
  const input = h("input", {
    type: "number",
    inputMode: kind === "int" ? "numeric" : "decimal",
    step: opts.step ?? (kind === "int" ? 1 : "any"),
    value: value ?? "",
  });
  if (opts.min !== undefined) input.min = opts.min;
  if (opts.max !== undefined) input.max = opts.max;
  input.addEventListener("change", () => {
    let n = Number(input.value);
    if (input.value.trim() === "" || !Number.isFinite(n)) {
      input.value = value ?? "";
      return;
    }
    if (kind === "int") n = Math.round(n);
    if (opts.min !== undefined) n = Math.max(opts.min, n);
    if (opts.max !== undefined) n = Math.min(opts.max, n);
    input.value = value = n;
    onChange(n);
  });
  return input;
}

function toggle(checked, label, onChange) {
  const btn = h("button", { className: "switch", role: "switch", "aria-checked": String(checked), "aria-label": label });
  btn.addEventListener("click", () => {
    checked = !checked;
    btn.setAttribute("aria-checked", String(checked));
    onChange(checked);
  });
  return btn;
}

function pickerButton(title, options, value, onChange) {
  const label = (v) => {
    const { name, folder } = splitPath(v);
    return [h("span", { className: "picker-name", textContent: name || "(none)" }),
      folder ? h("span", { className: "picker-folder", textContent: folder }) : ""];
  };
  const btn = h("button", { className: "select-btn" }, ...label(value));
  btn.addEventListener("click", async () => {
    const chosen = await pick(title, options, value);
    if (chosen === undefined) return;
    value = chosen;
    btn.replaceChildren(...label(value));
    onChange(value);
  });
  return btn;
}

function comboControl(field, spec, value, onChange) {
  const options = comboOptions(spec);
  if (!options.length) {
    const input = h("input", { type: "text", value: value ?? "" });
    input.addEventListener("input", () => onChange(input.value));
    return input;
  }
  if (options.length > 12) return pickerButton(field.label, options, value, onChange);
  const select = h("select", {}, ...options.map((o) => h("option", { value: o, textContent: o, selected: o === value })));
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function seedControl(field, spec, value, onChange) {
  let { mode, value: seed } = value;
  const max = Math.min(spec?.[1]?.max ?? Infinity, 2 ** 50 - 1); // the node's own limit; the PC rolls within it too (jobs.seed_range)
  const input = h("input", { type: "number", inputMode: "numeric", value: seed, min: 0, max, step: 1, "aria-label": `${field.label} value` });
  const buttons = ["random", "fixed"].map((m) => h("button", { className: "seg", textContent: m === "random" ? "Random" : "Fixed" }));
  const sync = () => {
    buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(["random", "fixed"][i] === mode)));
    input.disabled = mode === "random";
  };
  buttons.forEach((b, i) => b.addEventListener("click", () => {
    mode = ["random", "fixed"][i];
    sync();
    onChange({ mode, value: seed });
  }));
  input.addEventListener("change", () => {
    const n = Math.round(Number(input.value));
    if (!Number.isFinite(n) || n < 0) {
      input.value = seed;
      return;
    }
    input.value = seed = Math.min(n, max);
    onChange({ mode, value: seed });
  });
  sync();
  return h("div", { className: "seed" }, h("div", { className: "segmented", role: "group", "aria-label": "Seed mode" }, ...buttons), input);
}

function lorasControl(loras, loraOptions, onChange) {
  // Inactive LoRAs are folded away; a row switched off stays visible until the list is redrawn.
  const items = loras.map((l) => ({ ...l, visible: l.on }));
  let showInactive = false;
  const box = h("div", { className: "loras" });
  const emit = () => onChange(items.map(({ on, lora, strength }) => ({ on, lora, strength })));

  const row = (l) => {
    const strength = numberInput([null, { step: 0.05 }], l.strength, "float", (n) => {
      l.strength = n;
      emit();
    });
    strength.classList.add("strength");
    strength.setAttribute("aria-label", `Strength of ${splitPath(l.lora).name}`);
    const el = h("div", { className: `lora${l.on ? "" : " off"}` },
      toggle(l.on, `Enable ${splitPath(l.lora).name}`, (on) => {
        l.on = on;
        el.classList.toggle("off", !on);
        emit();
      }),
      pickerButton("LoRA", loraOptions, l.lora, (v) => {
        l.lora = v;
        emit();
      }),
      strength,
      h("button", { className: "icon-btn", "aria-label": `Remove ${splitPath(l.lora).name}`, textContent: "✕", onclick: () => {
        items.splice(items.indexOf(l), 1);
        emit();
        render();
      } }));
    return el;
  };

  const render = () => {
    const shown = items.filter((l) => l.on || l.visible || showInactive);
    shown.forEach((l) => (l.visible = true));
    const hidden = items.length - shown.length;
    box.replaceChildren(
      ...(shown.length ? shown.map(row) : [h("p", { className: "muted", textContent: "No active LoRAs" })]),
      h("div", { className: "lora-actions" },
        h("button", { className: "link-btn", textContent: "+ Add LoRA", onclick: async () => {
          const chosen = await pick("Add LoRA", loraOptions, null);
          if (chosen === undefined) return;
          items.push({ on: true, lora: chosen, strength: 1, visible: true });
          emit();
          render();
        } }),
        hidden || showInactive ? h("button", { className: "link-btn", textContent: showInactive ? "Hide inactive" : `Show ${hidden} inactive`, onclick: () => {
          showInactive = !showInactive;
          if (!showInactive) items.forEach((l) => (l.visible = l.on));
          render();
          // Folding a long list away would leave the page far below it: back to this card.
          const card = box.closest(".field");
          if (!showInactive && card && card.getBoundingClientRect().top < $(".topbar").offsetHeight) {
            card.scrollIntoView({ block: "start" });
          }
        } }) : null));
  };
  render();
  return box;
}

function control(field, value, prompt, loraOptions) {
  const classType = prompt[field.node]?.class_type;
  const spec = specOf(classType, field.input);
  const onChange = (v) => set(keyOf(field), v);
  switch (field.kind) {
    case "note": // edits are kept with the workflow but change nothing in it
    case "text": {
      const ta = h("textarea", { rows: 3, value: value ?? "" });
      const grow = () => {
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight + 2, window.innerHeight * 0.4)}px`;
      };
      ta.addEventListener("input", () => {
        grow();
        onChange(ta.value);
      });
      requestAnimationFrame(grow);
      return ta;
    }
    case "string": {
      // One line to type in (Enter does nothing), but it keeps line breaks that come with a loaded
      // prompt or a paste, where a plain input would silently drop them.
      const ta = h("textarea", { rows: 1, className: "one-line", value: value ?? "" });
      const grow = () => {
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight + 2, window.innerHeight * 0.4)}px`;
      };
      ta.addEventListener("keydown", (e) => e.key === "Enter" && e.preventDefault());
      ta.addEventListener("input", () => {
        grow();
        onChange(ta.value);
      });
      requestAnimationFrame(grow);
      return ta;
    }
    case "int":
    case "float":
      return numberInput(spec, value, field.kind, onChange);
    case "bool":
      return toggle(!!value, field.label, onChange);
    case "combo":
      return comboControl(field, spec, value, onChange);
    case "seed":
      return seedControl(field, spec, value, onChange);
    case "loras":
      return lorasControl(value ?? [], loraOptions, onChange);
    case "image":
      return imageControl(field, value, prompt, onChange);
    case "bypass":
      return null; // a card with just the node's switch
    default:
      return h("p", { className: "muted", textContent: String(value) });
  }
}

// ---------- image + mask ----------

/** "phone/a.jpg" -> the input-folder thumbnail, turned like the loader turns it. */
function inputThumb(name, size) {
  const parts = name.split("/");
  return thumbUrl({ filename: parts.pop(), subfolder: parts.join("/"), type: "input" }, size);
}

async function upload(file) {
  const ext = (/\.\w+$/.exec(file.name)?.[0] ?? ".jpg").toLowerCase();
  const form = new FormData();
  form.append("image", file, `phone-${Date.now()}${ext}`);
  form.append("subfolder", "phone");
  form.append("type", "input");
  const res = await fetch("/api/upload/image", { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload failed (HTTP ${res.status})`);
  const data = await res.json();
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

function imageControl(field, value, prompt, onChange) {
  // value: { image, mask }; mask null = the PC's mask, "" = none
  let current = typeof value === "string" ? { image: value, mask: null } : { ...value };
  const node = prompt[field.node] ?? { inputs: {} };
  const trix = "mask_data" in node.inputs;
  // Load Image keeps its mask in the picture's transparency (the server makes a copy with the painted
  // mask); offered only when the workflow uses its MASK output.
  const maskUsed = Object.values(prompt).some((n) => Object.values(n.inputs).some((v) => Array.isArray(v) && v[0] === field.node && v[1] === 1));
  const hasMask = trix || (node.class_type === "LoadImage" && maskUsed);
  const box = h("div", { className: "image-field" });
  const fileInput = h("input", { type: "file", accept: "image/*", hidden: true });

  const update = (next) => {
    current = next;
    onChange({ ...current });
    render();
  };

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    state.uploading = true;
    caption.textContent = "Uploading…";
    try {
      // A new photo starts without a mask; an old mask wouldn't fit it.
      update({ image: await upload(file), mask: hasMask ? "" : null });
    } catch (err) {
      toast(`Couldn't upload the photo (${err.message})`, "bad");
      render();
    } finally {
      state.uploading = false;
    }
  });

  const caption = h("p", { className: "item-meta" });
  function render() {
    const mask = current.mask ?? (trix ? node.inputs.mask_data : "");
    const pcMask = !trix && current.mask === null; // a Load Image mask painted on the PC isn't shown here
    caption.textContent = `${current.image.split("/").pop()}${hasMask ? (mask ? " · mask painted" : pcMask ? " · mask as on the PC" : " · no mask yet") : ""}`;
    box.replaceChildren(
      h("button", { className: "image-preview", "aria-label": hasMask ? "Paint mask" : "Choose photo",
        onclick: () => (hasMask ? openPainter(mask) : fileInput.click()) },
        h("img", { src: inputThumb(current.image, 1600), alt: "" }),
        mask ? h("img", { className: "mask-overlay", src: mask, alt: "" }) : null),
      caption,
      h("div", { className: "image-actions" },
        h("button", { className: "chip", textContent: "Choose photo", onclick: () => fileInput.click() }),
        hasMask ? h("button", { className: "chip", textContent: "Paint mask", onclick: () => openPainter(mask) }) : null,
        hasMask && mask ? h("button", { className: "chip", textContent: "Clear mask", onclick: () => update({ ...current, mask: "" }) }) : null),
      fileInput);
  }

  async function openPainter(mask) {
    const result = await paintMask(inputThumb(current.image, 1600), mask);
    if (result !== undefined) update({ ...current, mask: result });
  }

  render();
  return box;
}

// ---------- reorder ----------

async function saveOrder() {
  const keys = [...$("#field-list").children].map((li) => li.dataset.key);
  const byKey = new Map(state.wf.fields.map((f) => [keyOf(f), f]));
  const { wf } = state;
  wf.fields = keys.map((k) => byKey.get(k));
  try {
    await api(`api/workflows/${encodeURIComponent(wf.id)}/order`, { method: "PUT", body: { keys } });
    keepCopy(wf.id, { fields: wf.fields });
  } catch (err) {
    toast(`Order not saved: ${err.message}`, "bad");
  }
}

// ---------- bypass ----------

function setBypassed(node, off) {
  const nodes = new Set(state.values[BYPASS]);
  if (off) nodes.add(node);
  else nodes.delete(node);
  set(BYPASS, [...nodes]);
  // A node with several settings shows its switch on each of them.
  for (const li of $("#field-list").children) {
    if (li.dataset.node !== node) continue;
    li.classList.toggle("bypassed", off);
    li.querySelector(".node-switch")?.setAttribute("aria-checked", String(!off));
  }
}

// ---------- page ----------

function renderFields(loraOptions) {
  const { wf, values } = state;
  const list = $("#field-list");
  list.replaceChildren(...wf.fields.map((f) => {
    const id = `f-${keyOf(f).replace(/[^a-z0-9]/gi, "_")}`;
    const ctl = control(f, values[keyOf(f)], wf.prompt, loraOptions);
    if (["INPUT", "TEXTAREA", "SELECT"].includes(ctl?.tagName)) ctl.id = id;
    const off = values[BYPASS].includes(f.node);
    let nodeSwitch = null;
    if (wf.bypass?.[f.node]) {
      nodeSwitch = toggle(!off, `${f.label}: node on`, (on) => setBypassed(f.node, !on));
      nodeSwitch.classList.add("node-switch");
    }
    const li = h("li", { className: `field${off ? " bypassed" : ""}` },
      h("div", { className: "field-head" },
        h("span", { className: "drag", "aria-hidden": "true", textContent: "⠿" }),
        h("label", { className: "field-label", for: id, textContent: f.label }),
        nodeSwitch,
        f.kind === "text" || f.kind === "string" ? fieldMenu(ctl, f.label) : null, // prompts and snippets
        h("span", { className: "order-btns" },
          h("button", { className: "icon-btn up", "aria-label": `Move ${f.label} up`, textContent: "↑", onclick: () => moveItem(li, -1, saveOrder) }),
          h("button", { className: "icon-btn down", "aria-label": `Move ${f.label} down`, textContent: "↓", onclick: () => moveItem(li, 1, saveOrder) }))),
      ctl && h("div", { className: "field-body" }, ctl));
    li.dataset.key = keyOf(f);
    li.dataset.node = f.node;
    return li;
  }));
}

// Counts openings: an answer arriving after another workflow was opened (or the editor left) is dropped.
let opening = 0;

export function leaveEditor() {
  opening++;
  saveNow();
  document.body.classList.remove("editing");
}

export async function showWorkflow(id) {
  const me = ++opening;
  if (state?.dirty) await saveNow();
  document.body.classList.add("editing");
  const title = $("#h-workflow");
  const list = $("#field-list");
  title.textContent = "Loading…";
  $("#rename-btn").hidden = true;
  list.replaceChildren();
  $("#field-list").classList.remove("reordering");
  $("#reorder-btn").textContent = "Reorder";
  setStatus("");
  try {
    const wf = await api(`api/workflows/${encodeURIComponent(id)}`);
    const pending = readPending()[wf.id];
    if (pending) wf.values = { ...wf.values, ...pending.values }; // changed offline: newer than what came
    const classes = wf.fields.map((f) => wf.prompt[f.node]?.class_type).filter(Boolean);
    const needLoras = wf.fields.some((f) => f.kind === "loras");
    await loadSpecs(needLoras ? [...classes, "LoraLoader"] : classes);
    if (me !== opening) return;
    const loraOptions = needLoras ? comboOptions(specOf("LoraLoader", "lora_name")) : [];
    const values = {};
    for (const f of wf.fields) {
      const stored = wf.values?.[keyOf(f)];
      values[keyOf(f)] = stored !== undefined ? stored : defaultValue(f, wf.prompt[f.node]?.inputs ?? {});
    }
    values[BYPASS] = wf.values?.[BYPASS] ?? [];
    state = { wf, values, touched: new Set(Object.keys(wf.values ?? {})), edited: new Set(),
      count: state?.wf?.id === wf.id ? state.count : 1, saveTimer: null, dirty: false };
    title.textContent = wf.phone_name || wf.name;
    $("#rename-btn").hidden = false;
    $("#count").value = state.count;
    renderFields(loraOptions);
    if (pending) {
      state.dirty = true;
      saveNow(); // offline it stays kept on the phone (and says so), online it goes to the PC now
    }
  } catch (err) {
    if (me !== opening) return;
    state = null;
    title.textContent = "Workflow";
    list.replaceChildren(h("li", { className: "bad", textContent: `Couldn't load this workflow (${err.message}).` }));
  }
}

async function generate() {
  if (!state) return;
  if (state.uploading) return toast("Wait until the photo is uploaded", "bad");
  const btn = $("#generate-btn");
  if (btn.disabled) return;
  btn.disabled = true;
  const started = Date.now();
  // The field being typed in keeps its focus (and keyboard): take over what it holds, as leaving it would.
  if (document.activeElement?.matches("#view-workflow input, #view-workflow select")) {
    document.activeElement.dispatchEvent(new Event("change", { bubbles: true }));
  }
  try {
    clearTimeout(state.saveTimer);
    state.dirty = false;
    const values = changedValues();
    const res = await api("api/jobs", { method: "POST", body: { workflow_id: state.wf.id, values, count: state.count } });
    dropPending(state.wf.id, values); // generating saved the values too
    keepCopy(state.wf.id, { values });
    setStatus("Saved");
    // Stays here, so the next variation is one tap away; Tasks shows the queue.
    toast(`Queued ${res.count} image${res.count === 1 ? "" : "s"} · see Tasks`, "ok");
    showTasks(); // poll now (and fast while it runs), as opening Tasks used to
  } catch (err) {
    state.dirty = true;
    toast(`Not queued: ${err.message}`, "bad");
  } finally {
    // Greyed out for at least half a second, so a second tap doesn't queue the same thing twice.
    setTimeout(() => (btn.disabled = document.body.classList.contains("offline")), Math.max(0, 500 - (Date.now() - started)));
  }
}

export function initEditor() {
  enableDrag($("#field-list"), saveOrder);
  $("#reorder-btn").addEventListener("click", () => {
    const on = $("#field-list").classList.toggle("reordering");
    $("#reorder-btn").textContent = on ? "Done" : "Reorder";
  });
  $("#reset-btn").addEventListener("click", async () => {
    if (!state || !confirm("Reset the name and all values to the ones shared from the PC?")) return;
    clearTimeout(state.saveTimer);
    state.dirty = false;
    try {
      await api(`api/workflows/${encodeURIComponent(state.wf.id)}/values`, { method: "DELETE" });
      dropPending(state.wf.id);
      await showWorkflow(state.wf.id);
      toast("Reset to PC values");
    } catch (err) {
      toast(`Reset failed: ${err.message}`, "bad");
    }
  });
  $("#rename-btn").addEventListener("click", async () => {
    if (!state) return;
    const { wf } = state;
    const name = prompt(`Name on the phone (empty = the PC's name "${wf.name}")`, wf.phone_name || wf.name);
    if (name === null || state?.wf !== wf) return;
    try {
      await api(`api/workflows/${encodeURIComponent(wf.id)}/name`, { method: "PUT", body: { name: name.trim() || null } });
      wf.phone_name = name.trim() && name.trim() !== wf.name ? name.trim() : null;
      keepCopy(wf.id, { phone_name: wf.phone_name });
      $("#h-workflow").textContent = wf.phone_name || wf.name;
      toast("Renamed");
    } catch (err) {
      toast(`Rename failed: ${err.message}`, "bad");
    }
  });
  $("#delete-btn").addEventListener("click", async () => {
    if (!state) return;
    const { wf } = state;
    const name = wf.phone_name || wf.name;
    if (!confirm(`Delete "${name}" from the phone? Queued tasks and gallery images stay. Share it again from the PC to get it back.`)) return;
    clearTimeout(state.saveTimer);
    state.dirty = false; // nothing left to save to
    try {
      await api(`api/workflows/${encodeURIComponent(wf.id)}`, { method: "DELETE" });
      dropPending(wf.id);
      dropCopy(wf.id);
      state = null;
      toast(`Deleted "${name}"`);
      location.hash = "#workflows";
    } catch (err) {
      toast(`Delete failed: ${err.message}`, "bad");
    }
  });
  const count = $("#count");
  const setCount = (n) => {
    n = Math.max(1, Math.min(100, Math.round(Number(n)) || 1));
    count.value = n;
    if (state) state.count = n;
  };
  count.addEventListener("change", () => setCount(count.value));
  // −/+ and Generate don't take the focus while the keyboard is open: the text field keeps it, so the buttons
  // don't jump away under the finger. With the keyboard closed, Android still leaves the field focused, and
  // keeping that focus would bring the keyboard back: let go of it instead.
  $(".generate-bar").addEventListener("pointerdown", (e) => {
    if (!e.target.closest("button")) return;
    if (keyboardOpen()) e.preventDefault();
    else if (document.activeElement?.matches("input, textarea")) document.activeElement.blur();
  });
  $("#count-minus").addEventListener("click", () => setCount(Number(count.value) - 1));
  $("#count-plus").addEventListener("click", () => setCount(Number(count.value) + 1));
  $("#generate-btn").addEventListener("click", generate);
  window.addEventListener("pagehide", saveNow);
  // Android often skips pagehide when the app is swiped away; hiding it comes first and reliably.
  document.addEventListener("visibilitychange", () => document.hidden && saveNow());
}

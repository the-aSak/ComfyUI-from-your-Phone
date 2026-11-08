export const $ = (sel, el = document) => el.querySelector(sel);

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Small DOM builder: h("button", { className: "x", onclick }, "text", child). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("aria-") || k === "role" || k === "for") el.setAttribute(k, v);
    else el[k] = v;
  }
  el.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

/**
 * Lets Android's Back button close an overlay instead of leaving the page. onBack runs when Back is
 * pressed; call the returned function when the overlay closes another way.
 */
export function closeOnBack(onBack) {
  history.pushState({ overlay: true }, "");
  let open = true;
  const onPop = () => {
    if (!open) return;
    open = false;
    removeEventListener("popstate", onPop);
    onBack();
  };
  addEventListener("popstate", onPop);
  return () => {
    if (!open) return;
    open = false;
    removeEventListener("popstate", onPop);
    history.back();
  };
}

/** Tells the connection indicator whether the PC answered (true) or couldn't be reached (false). */
const reportConnection = (ok) => dispatchEvent(new CustomEvent("phone-connection", { detail: ok }));

/** JSON request; throws Error with the server's message on failure. */
export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    reportConnection(false);
    throw err;
  }
  // 502-504: Tailscale is there, ComfyUI isn't. X-Phone-Copy: the copy kept on the phone (sw.js), PC away.
  reportConnection((res.status < 502 || res.status > 504) && !res.headers.get("X-Phone-Copy"));
  let data = null;
  try {
    data = await res.json();
  } catch {
    // empty or non-JSON body
  }
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

// ISO 8601 (2026-11-05), so day and month are never mixed up. Local time: toISOString() would be UTC.
const pad = (n) => String(n).padStart(2, "0");
export const isoDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const isoDateTime = (ms) => `${isoDate(ms)} ${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;

/** A setting kept on this phone. Without storage (private mode) settings last until the app closes. */
const memory = new Map();
export function setting(key, fallback = null) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return memory.get(key) ?? fallback;
  }
}
export function setSetting(key, value) {
  memory.set(key, value);
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* kept in memory */ }
}

let toastTimer;
// Keeps the message at the top of what's visible: Chrome moves the page up for the keyboard and back down
// when it closes. The browser reports both, so there's nothing to check in between.
// The on-screen keyboard: the page shrinks for it (interactive-widget=resizes-content in index.html), so
// bars fixed to the bottom, like Generate, stay above it. It shows as a window lower than the tallest one
// seen at this width, while a field has the focus (a split screen is lower too, with nothing to type in);
// body.keyboard hides the tab bar meanwhile, leaving room for what is typed.
let fullSize = { width: 0, height: 0 };
function trackKeyboard() {
  if (innerWidth !== fullSize.width) fullSize = { width: innerWidth, height: innerHeight }; // turned: start over
  fullSize.height = Math.max(fullSize.height, innerHeight);
  const typing = document.activeElement?.matches("input, textarea, select, [contenteditable]");
  document.body.classList.toggle("keyboard", fullSize.height - innerHeight > 150 && !!typing);
}
addEventListener("resize", trackKeyboard);
window.visualViewport?.addEventListener("resize", trackKeyboard); // in case a browser only reports this one
addEventListener("focusin", trackKeyboard);
addEventListener("focusout", () => setTimeout(trackKeyboard)); // once the focus has gone wherever it goes
trackKeyboard();
export const keyboardOpen = () => document.body.classList.contains("keyboard");

const placeToast = () => $("#toast")?.style.setProperty("--shift", `${Math.round(window.visualViewport?.offsetTop ?? 0)}px`);
window.visualViewport?.addEventListener("resize", placeToast);
window.visualViewport?.addEventListener("scroll", placeToast);

export function toast(text, kind = "") {
  let el = $("#toast");
  if (!el) {
    el = h("div", { id: "toast", role: "status", "aria-live": "polite" });
    document.body.append(el);
  }
  el.textContent = text;
  placeToast();
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), 3500);
}

/** "Krea 2\\foo.safetensors" -> { name: "foo", folder: "Krea 2" } */
export function splitPath(path) {
  const parts = String(path).split(/[\\/]/);
  const name = parts.pop().replace(/\.(safetensors|ckpt|pt|pth|gguf|bin)$/i, "");
  return { name, folder: parts.join("/") };
}

// v: the job an output belongs to. ComfyUI starts reusing file names once its output folder is emptied;
// the job id keeps every picture's address unique.
const version = (img) => (img.v ? `&v=${encodeURIComponent(img.v)}` : "");

export const thumbUrl = (img, size = 512) =>
  `api/thumb?size=${size}&type=${img.type === "input" ? "input" : "output"}&filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder ?? "")}${version(img)}`;

export const isVideo = (img) => /\.(mp4|webm|mov|mkv)$/i.test(img.filename);
export const isAudio = (img) => /\.(mp3|wav|flac|ogg|opus|m4a)$/i.test(img.filename);

// Audio has no picture: every clip gets this one (a note on a plain tile) as its preview.
export const AUDIO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#2a2d3a"/>`
  + `<g fill="#c9cbe0"><rect x="247" y="126" width="26" height="205"/><path d="M273 126c44 12 80 44 86 100-24-30-54-44-86-46z"/>`
  + `<ellipse cx="213" cy="338" rx="62" ry="46" transform="rotate(-20 213 338)"/></g></svg>`; // centred; stem flush with the head
export const audioThumb = `data:image/svg+xml,${encodeURIComponent(AUDIO_SVG)}`;

export const originalUrl = (img) =>
  `api/original?type=output&filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder ?? "")}${version(img)}`;

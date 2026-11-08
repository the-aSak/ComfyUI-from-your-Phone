// Settings page (the gear in the top bar). Settings are kept on this phone only.
import { $, api, setSetting, setting, toast } from "./api.js";
import { deleteAllImages, galleryInfo } from "./gallery.js";
import { deleteAllOf, libraryReady, onLibraryChange, visible } from "./library.js";

const prefersLight = matchMedia("(prefers-color-scheme: light)");

/** "system" follows the phone; "light" / "dark" override it. */
export function applyTheme() {
  const theme = setting("theme", "system");
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const light = theme === "light" || (theme === "system" && prefersLight.matches);
  $('meta[name="theme-color"]').content = light ? "#f5f5f8" : "#16171f"; // Android's status bar
}

// ---------- notifications (Web Push without content; the service worker asks the PC what finished) ----------
const canNotify = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const keyBytes = (b64url) => Uint8Array.from(atob(b64url.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** The service worker that receives the pushes; it runs once the app has been opened over https. */
async function registration() {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) throw new Error("the app's offline part isn't running yet; reopen the app and try again");
  return reg;
}
const subscription = async () => (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription() ?? null;

async function notifyOn() {
  if (await Notification.requestPermission() !== "granted") {
    throw new Error("notifications are blocked for this app (Android settings → Apps → Chrome → Notifications)");
  }
  const { key } = await api("api/push");
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  const subKey = sub?.options.applicationServerKey;
  if (sub && subKey && !sameBytes(new Uint8Array(subKey), keyBytes(key))) { // made with another PC's key
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  try {
    await api("api/push/subscription", { method: "PUT", body: { endpoint: sub.endpoint } });
  } catch (err) {
    await sub.unsubscribe();
    throw err;
  }
}

async function notifyOff() {
  const sub = await subscription();
  if (!sub) return;
  // Unsubscribing here is enough: the PC forgets the address the next time the push service turns it down.
  await api("api/push/subscription", { method: "DELETE", body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

async function showNotify() {
  const sw = $("#notify");
  const state = $("#notify-state");
  if (!canNotify) {
    sw.disabled = true;
    state.textContent = "This browser can't show notifications from the app.";
    state.hidden = false;
    return;
  }
  const on = Notification.permission === "granted" && !!(await subscription());
  sw.setAttribute("aria-checked", String(on));
  $("#notify-test").hidden = !on;
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;

export async function showSettings() {
  const theme = setting("theme", "system");
  for (const b of $("#theme-choice").children) b.setAttribute("aria-pressed", String(b.dataset.value === theme));
  $("#auto-copy").setAttribute("aria-checked", String(setting("copyImages") !== "off"));
  showNotify();
  await showDeleteCounts();
}

// ---------- deleting: tick what goes, then one button ----------
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function deletable() {
  await libraryReady;
  const { count, bytes } = await galleryInfo();
  return { images: { count, info: count ? `${count} · ${mb(bytes)}` : "none" },
    prompts: { count: visible("prompt").length }, snippets: { count: visible("snippet").length } };
}

async function showDeleteCounts() {
  const counts = await deletable();
  for (const [kind, { count, info }] of Object.entries(counts)) {
    const box = $(`#del-${kind}`);
    box.disabled = !count;
    if (!count) box.checked = false;
    $(`#del-${kind}-info`).textContent = info ?? (count ? String(count) : "none");
  }
  $("#delete-selected-data").disabled = !["images", "prompts", "snippets"].some((k) => $(`#del-${k}`).checked);
}

async function deleteSelected() {
  const counts = await deletable();
  const chosen = ["images", "prompts", "snippets"].filter((k) => $(`#del-${k}`).checked && counts[k].count);
  if (!chosen.length) return;
  // "23 images, 12 prompts and 5 snippets": the last comma becomes "and"
  const what = chosen.map((k) => plural(counts[k].count, k.slice(0, -1))).join(", ").replace(/, ([^,]*)$/, " and $1");
  const notes = [
    ...(chosen.includes("images") ? ["Images: the files on the PC stay."] : []),
    ...(chosen.some((k) => k !== "images") ? ["Prompts and snippets: deleted on all your devices."] : []),
  ];
  if (!confirm(`Delete ${what}?\n\n${notes.join("\n")}\n\nThis can't be undone.`)) return;
  try {
    if (chosen.includes("images")) await deleteAllImages();
    const kinds = chosen.filter((k) => k !== "images").map((k) => k.slice(0, -1)); // "prompts" -> "prompt"
    if (kinds.length) await deleteAllOf(kinds);
    toast(`Deleted ${what}`, "ok");
  } catch (err) {
    toast(`Couldn't delete everything: ${err.message}`, "bad");
  }
  for (const k of chosen) $(`#del-${k}`).checked = false;
  showDeleteCounts();
}

export function initSettings() {
  applyTheme();
  prefersLight.addEventListener("change", applyTheme);
  $("#theme-choice").addEventListener("click", (e) => {
    const value = e.target.closest(".seg")?.dataset.value;
    if (!value) return;
    setSetting("theme", value === "system" ? null : value);
    applyTheme();
    showSettings();
  });
  $("#auto-copy").addEventListener("click", () => {
    // Turned on again: only images finished from now on, so the gallery isn't flooded with the ones skipped.
    setSetting("copyImages", setting("copyImages") === "off" ? String(Date.now()) : "off");
    showSettings();
  });
  $("#notify").addEventListener("click", async (e) => {
    const sw = e.currentTarget;
    const turnOn = sw.getAttribute("aria-checked") !== "true";
    sw.disabled = true;
    try {
      await (turnOn ? notifyOn() : notifyOff());
      if (turnOn) toast("Notifications on", "ok");
    } catch (err) {
      toast(`Couldn't turn notifications ${turnOn ? "on" : "off"}: ${err.message}`, "bad");
    } finally {
      sw.disabled = false;
      showNotify();
    }
  });
  $("#notify-test").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      (await registration()).active?.postMessage("push-test"); // shown even though the app is open
      await api("api/push/test", { method: "POST" });
      toast("Test sent: it should arrive in a few seconds", "ok");
    } catch (err) {
      toast(`Test failed: ${err.message}`, "bad");
    } finally {
      btn.disabled = false;
    }
  });
  for (const k of ["images", "prompts", "snippets"]) $(`#del-${k}`).addEventListener("change", showDeleteCounts);
  $("#delete-selected-data").addEventListener("click", deleteSelected);
  onLibraryChange(() => !$("#view-settings").hidden && showDeleteCounts()); // e.g. a sync brought new ones
}

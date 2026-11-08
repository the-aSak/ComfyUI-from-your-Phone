import { $, api, esc, isoDate, toast } from "./api.js";
import { flushPending, initEditor, leaveEditor, showWorkflow } from "./editor.js";
import { initGallery, leaveGallery, showGallery } from "./gallery.js";
import { syncLibrary } from "./library.js";
import { initPrompts, leavePrompts, showPrompts } from "./prompts.js";
import { enableDrag, moveItem } from "./reorder.js";
import { initSettings, showSettings } from "./settings.js";
import { initTasks, showTasks, stopTasks } from "./tasks.js";

const TABS = ["workflows", "prompts", "tasks", "gallery"]; // in the order of the tab bar
let offlineState = "checking…";
let currentView = null;
let workflowsReturn = "#workflows";
let beforeSettings = "#workflows"; // the gear tapped again in Settings returns there

// Routes: #workflows, #tasks, #gallery, #workflow/<id>, #settings (no tab of its own)
function route() {
  const [view, arg] = location.hash.slice(1).split("/");
  const isEditor = view === "workflow" && !!arg;
  const isSettings = view === "settings";
  const tab = isEditor ? "workflows" : TABS.includes(view) ? view : isSettings ? null : "workflows";
  const next = isEditor ? "editor" : isSettings ? "settings" : tab;

  if (currentView === "editor" && next !== "editor") leaveEditor();
  if (currentView === "gallery" && next !== "gallery") leaveGallery();
  if (currentView === "prompts" && next !== "prompts") leavePrompts();
  if (currentView === "workflows" && next !== "workflows") setReordering(false);
  currentView = next;

  // From another tab, Workflows leads back to the open workflow; inside Workflows it leads to the list.
  if (tab === "workflows") workflowsReturn = isEditor ? location.hash : "#workflows";
  TABS.forEach((t, i) => {
    $(`#view-${t}`).hidden = next !== t;
    const link = $(".tabbar").children[i];
    if (t === "workflows") link.href = tab === "workflows" ? "#workflows" : workflowsReturn;
    if (t === tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  $("#view-workflow").hidden = !isEditor;
  $("#view-settings").hidden = !isSettings;
  if (isSettings) $("#settings-link").setAttribute("aria-current", "page");
  else {
    $("#settings-link").removeAttribute("aria-current");
    beforeSettings = location.hash || "#workflows";
  }
  window.scrollTo(0, 0);

  if (isEditor) showWorkflow(decodeURIComponent(arg));
  else if (isSettings) showSettings();
  else if (tab === "workflows") loadWorkflows();
  else if (tab === "prompts") showPrompts();
  else if (tab === "tasks") showTasks();
  else if (tab === "gallery") showGallery();
}

async function loadWorkflows() {
  const list = $("#workflow-list");
  try {
    const items = await api("api/workflows");
    if (list.classList.contains("reordering")) return; // don't undo a move in progress
    list.innerHTML = items.map(({ phone_name, ...w }) => ({ ...w, name: phone_name || w.name })).map((w) => `
      <li class="wf-row" data-id="${esc(w.id)}">
        <span class="drag" aria-hidden="true">⠿</span>
        <a class="item" href="#workflow/${encodeURIComponent(w.id)}">
          <span class="item-title">${esc(w.name)}</span>
          <span class="item-meta">${w.field_count} settings · shared ${isoDate(w.shared_at * 1000)}${
            w.pc_changed ? ` · changed ${isoDate(w.pc_changed * 1000)}` // only the PC can change it
              : w.pc_missing ? " · no longer saved on PC" : ""}</span>
        </a>
        <span class="order-btns">
          <button class="icon-btn up" aria-label="Move ${esc(w.name)} up">↑</button>
          <button class="icon-btn down" aria-label="Move ${esc(w.name)} down">↓</button>
        </span>
      </li>`).join("");
    $("#workflow-empty").hidden = items.length > 0;
    $("#workflow-reorder").hidden = items.length < 2;
  } catch (err) {
    list.innerHTML = `<li class="bad">Couldn't load workflows (${esc(err.message)}).</li>`;
  }
}

// Live requests keep the indicator honest between checks (PC asleep, phone offline).
addEventListener("phone-connection", (e) => {
  const text = $("#conn .conn-text").textContent;
  if (!e.detail && text !== "Offline") setConn(false, "Offline");
  else if (e.detail && text === "Offline") {
    setConn(false, "Connecting…"); // checkConnection's own requests must not start another check
    checkConnection();
  }
});

async function saveWorkflowOrder() {
  const ids = [...$("#workflow-list").children].map((li) => li.dataset.id);
  try {
    await api("api/workflow-order", { method: "PUT", body: { ids } });
  } catch (err) {
    toast(`Order not saved: ${err.message}`, "bad");
  }
}

function setReordering(on) {
  $("#workflow-list").classList.toggle("reordering", on);
  $("#workflow-reorder").textContent = on ? "Done" : "Reorder";
}

function setConn(ok, text) {
  const conn = $("#conn");
  conn.classList.toggle("ok", ok);
  conn.classList.toggle("bad", !ok);
  $(".conn-text", conn).textContent = text;
  // Offline, workflows are the copies kept on the phone: only their values can be changed (kept on the
  // phone until the PC is back); order, name, reset, delete and Generate need the PC.
  const offline = text === "Offline";
  document.body.classList.toggle("offline", offline);
  for (const el of [$(".editor-actions"), $("#rename-btn"), $("#workflow-reorder")]) el.inert = offline;
  $("#generate-btn").disabled = offline;
  if (offline) {
    setReordering(false);
    $("#field-list").classList.remove("reordering");
    $("#reorder-btn").textContent = "Reorder";
  }
  if (ok) flushPending();
}

async function checkConnection() {
  const card = $("#status-card");
  try {
    const status = await api("api/status");
    // A POST also has to pass ComfyUI's origin check, which a proxy can trip.
    const ping = await fetch("api/ping", { method: "POST" });
    const writeOk = ping.ok;
    setConn(writeOk, writeOk ? "Connected" : "Read-only");
    card.innerHTML = `
      <dl>
        <dt>ComfyUI</dt><dd>${esc(status.comfyui_version)}</dd>
        <dt>Queue</dt><dd>${status.queue_remaining} remaining</dd>
        <dt>Write check</dt><dd class="${writeOk ? "" : "bad"}">${writeOk ? "OK" : `Blocked (HTTP ${ping.status})`}</dd>
        <dt>Offline mode</dt><dd id="offline-state">${offlineState}</dd>
        <dt>Address</dt><dd>${esc(location.origin)}</dd>
      </dl>`;
  } catch (err) {
    setConn(false, "Offline");
    const why = /HTTP 50[234]/.test(err.message)
      ? "The PC answers, but ComfyUI isn't running (or is still starting)."
      : "Is the PC on and Tailscale connected?";
    card.innerHTML = `<p class="bad">Can't reach ComfyUI (${esc(err.message)}). ${why} The gallery works without it.</p>`;
  }
}

function setOfflineState(text) {
  offlineState = text;
  const el = $("#offline-state");
  if (el) el.textContent = text;
}

initSettings();
initPrompts();
initEditor();
initTasks();
initGallery();
enableDrag($("#workflow-list"), saveWorkflowOrder);
$("#workflow-list").addEventListener("click", (e) => {
  const btn = e.target.closest(".up, .down");
  if (btn) moveItem(btn.closest("li"), btn.classList.contains("up") ? -1 : 1, saveWorkflowOrder);
});
$("#workflow-reorder").addEventListener("click", () => setReordering(!$("#workflow-list").classList.contains("reordering")));
window.addEventListener("hashchange", route);

// Swiping sideways on a tab's page goes to the neighbouring tab (finger to the left: the next one), as in
// many phone apps. Not in the editor (nor in a prompt being edited), on fields, while
// reordering, or at the screen's edges (Android's back gesture). The whole screen counts, also the empty part below a short page; viewers, pickers, menus and
// dialogs are added straight to <body>, so a swipe on them is left alone.
let swipe = null;
document.addEventListener("touchstart", (e) => {
  const t = e.touches[0];
  const tab = TABS.indexOf(currentView);
  const onPage = e.target === document.body || e.target === document.documentElement || e.target.closest("main, .topbar, .tabbar");
  swipe = e.touches.length === 1 && tab >= 0 && onPage && t.clientX > 24 && t.clientX < innerWidth - 24
    && !e.target.closest("input, textarea, select, [contenteditable], .reordering, .prompt-edit")
    ? { x: t.clientX, y: t.clientY, at: e.timeStamp, tab } : null;
}, { passive: true });
document.addEventListener("touchcancel", () => (swipe = null), { passive: true });
document.addEventListener("touchend", (e) => {
  if (!swipe) return;
  const { x, y, at, tab } = swipe;
  swipe = null;
  const t = e.changedTouches[0];
  const dx = t.clientX - x;
  // Sideways enough (within ~27°), far enough (about a fifth of the screen), quick enough: scrolling and slow
  // drags stay what they are.
  if (Math.abs(dx) < 80 || Math.abs(t.clientY - y) > 0.5 * Math.abs(dx) || e.timeStamp - at > 800) return;
  const next = tab + (dx < 0 ? 1 : -1);
  if (next >= 0 && next < TABS.length) location.hash = $(".tabbar").children[next].getAttribute("href"); // as its tab would
}, { passive: true });
$("#settings-link").addEventListener("click", (e) => {
  if (location.hash !== "#settings") return;
  e.preventDefault();
  location.hash = beforeSettings;
});
window.addEventListener("online", checkConnection);
// The job list is polled in every view while the app is open, so new images get copied to the gallery.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return stopTasks();
  checkConnection();
  showTasks();
  syncLibrary(); // prompts changed on another device, or here while the PC was away
  if (currentView === "workflows") loadWorkflows();
});

route();
checkConnection();
if (currentView !== "tasks") showTasks();
if (currentView !== "prompts") syncLibrary();

if ("serviceWorker" in navigator) {
  // A tapped notification brings the open app to Tasks.
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.open) location.hash = e.data.open;
  });
  navigator.serviceWorker.register("sw.js")
    .then(() => setOfflineState("ready"))
    .catch((err) => {
      console.warn("Service worker failed:", err);
      setOfflineState("unavailable");
    });
} else {
  setOfflineState("unavailable");
}

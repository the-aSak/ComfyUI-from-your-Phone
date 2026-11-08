// Keeps the app shell available offline. Network first, so updates show up on the next reload.
const CACHE = "shell-v70";
const SHELL = ["./", "app.js", "api.js", "editor.js", "gallery.js", "mask.js", "picker.js", "reorder.js", "settings.js", "library.js", "prompts.js", "tasks.js", "style.css",
  "vendor/photoswipe.esm.min.js", "vendor/photoswipe.css", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
const shellPaths = () => SHELL.map((p) => new URL(p, self.registration.scope).pathname);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

// The last workflow list, workflows and node descriptions from the PC, so they can be looked at while it's
// away. Text only: pictures never go into a cache (the gallery keeps the phone's copies).
const DATA = "data-v1"; // editor.js keepCopy updates it too
const DATA_PATHS = [/\/phone\/api\/workflows$/, /\/phone\/api\/workflows\/[^/]+$/, /\/api\/object_info\/[^/]+$/];

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ---------- notifications ----------
// The PC's push message is empty; what finished comes from the PC itself, over Tailscale.
let testUntil = 0; // the Test button in Settings: show it even though the app is open
self.addEventListener("message", (event) => {
  if (event.data === "push-test") testUntil = Date.now() + 60_000;
});

const FINISHED = ["done", "error", "cancelled"];
const VIDEO = /\.(mp4|webm|mov|mkv)$/i;

function describe(job) {
  const ok = job.runs.filter((r) => r.status === "done").length;
  const failed = job.runs.filter((r) => r.status === "error").length;
  const video = job.runs.some((r) => r.outputs.some((o) => VIDEO.test(o.filename)));
  const what = (n) => `${n} ${video ? "video" : "image"}${n === 1 ? "" : "s"}`;
  if (!failed) return `${what(ok)} ready`;
  return ok ? `${what(ok)} ready, ${failed} failed` : `Failed: ${job.runs.find((r) => r.error)?.error ?? "error"}`;
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const test = Date.now() < testUntil;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!test && windows.some((w) => w.visibilityState === "visible")) return; // the app is open: Tasks shows it
    let title = "Comfy Phone";
    let body = test ? "Notifications work." : "Your images are ready.";
    let tag = "phone";
    if (!test) {
      try {
        const res = await fetch(new URL("api/jobs", self.registration.scope), { cache: "no-store" });
        const latest = (await res.json())
          .filter((j) => !j.cancelled && j.runs.every((r) => FINISHED.includes(r.status)))
          .map((j) => ({ job: j, at: Math.max(...j.runs.map((r) => r.finished ?? 0)) }))
          .sort((a, b) => b.at - a.at)[0];
        if (latest && Date.now() / 1000 - latest.at < 600) { // finished in the last 10 minutes
          title = latest.job.name;
          tag = latest.job.id; // one notification per job, replaced rather than stacked
          body = describe(latest.job);
        }
      } catch { /* PC not reachable from here right now: the plain message */ }
    }
    testUntil = 0;
    await self.registration.showNotification(title, { body, tag, icon: "icon-192.png" });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!windows.length) return self.clients.openWindow(new URL("#tasks", self.registration.scope).href);
    windows[0].postMessage({ open: "#tasks" });
    return windows[0].focus();
  })());
});

/** Workflow data: from the PC when it answers (and kept); otherwise the kept copy, marked as such. */
async function dataFromPcOrCopy(request) {
  try {
    const res = await Promise.race([fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("PC asleep")), 5000))]);
    // Deleted on the PC: so is the copy, and the app learns it's gone. Only the node's own 404 says so; any other
    // (ComfyUI runs, this node didn't load) counts as "PC away", and the copy stays.
    if (res.status === 404 && res.headers.get("X-Phone-Gone")) {
      await caches.open(DATA).then((cache) => cache.delete(request));
      return res;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // 502: PC on, ComfyUI off
    const copy = res.clone();
    caches.open(DATA).then((cache) => cache.put(request, copy));
    return res;
  } catch (err) {
    const cached = await caches.match(request, { cacheName: DATA });
    if (!cached) throw err;
    const headers = new Headers(cached.headers);
    headers.set("X-Phone-Copy", "1"); // the app shows it's offline
    return new Response(cached.body, { status: 200, headers });
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  if (DATA_PATHS.some((p) => p.test(url.pathname))) return event.respondWith(dataFromPcOrCopy(event.request));
  if (!shellPaths().includes(url.pathname)) return;
  event.respondWith((async () => {
    const network = fetch(event.request);
    // Only a good answer replaces the offline copy. PC on but ComfyUI off: Tailscale answers 502.
    const fresh = network.then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const copy = res.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      return res;
    });
    const cached = await caches.match(event.request);
    if (!cached) return fresh.catch(() => network);
    // Falls back to the cached copy when the PC doesn't answer quickly (asleep, or no network).
    const slow = new Promise((resolve) => setTimeout(() => resolve(cached), 3000));
    return Promise.race([fresh.catch(() => cached), slow]);
  })());
});

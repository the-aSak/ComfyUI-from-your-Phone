// Gallery: copies of finished images kept on the phone (IndexedDB), so they also show without the PC.
import PhotoSwipe from "./vendor/photoswipe.esm.min.js";
import { $, api, AUDIO_SVG, audioThumb, closeOnBack, esc, fileLabel, fileRef, isAudio, isoDate, isoDateTime, isVideo, originalUrl, setting, thumbUrl, toast } from "./api.js";

const COPY_SIZE = 8192; // full-size WebP (up to 8192 px a side): ~1 MB instead of a ~20 MB PNG

// ---------- storage ----------
const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open("comfy-phone", 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore("images", { keyPath: "key" });
    req.result.createObjectStore("deleted"); // keys deleted on the phone, so they aren't copied again
  };
  req.onsuccess = () => {
    // Steps aside when another window of the app upgrades or deletes the database, instead of blocking it.
    req.result.onversionchange = () => req.result.close();
    resolve(req.result);
  };
  req.onerror = () => reject(req.error);
});

/** Runs fn(transaction) and resolves with the result of the request it returns, once committed. */
async function tx(stores, mode, fn) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

let images = []; // newest first
const known = new Set(); // copied or deleted
const failed = new Set(); // gone on the PC; retried after an app restart
const attempts = new Map(); // key -> server errors so far; a few are retried
const thumbUrls = new Map();
let loaded;
let syncRun = null; // the copying going on now
let selected = null; // Set of keys while selecting
let persistAsked = false;
// What Save stores: the small copy already on the phone, or the PC's original ("png": a PNG has the workflow inside).
let saveFormat = "webp";
try {
  if (localStorage.getItem("saveFormat") === "png") saveFormat = "png";
} catch { /* no storage: keep WebP */ }

async function load() {
  const [stored, deleted] = await Promise.all([
    tx("images", "readonly", (t) => t.objectStore("images").getAll()),
    tx("deleted", "readonly", (t) => t.objectStore("deleted").getAllKeys()),
  ]);
  images = stored.sort((a, b) => b.created - a.created);
  for (const key of [...stored.map((i) => i.key), ...deleted]) known.add(key);
  render();
}

// ---------- copying from the PC ----------
async function fetchBlob(url) {
  const res = await fetch(url, { cache: "no-store" }); // the copy goes into the gallery, not the browser's cache
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.blob();
}

/** Width, height and length (seconds) of a video, or the length of an audio file (tag "audio"). */
async function mediaInfo(blob, tag) {
  const media = document.createElement(tag);
  media.preload = "metadata";
  media.src = URL.createObjectURL(blob);
  try {
    await new Promise((resolve, reject) => {
      media.onloadedmetadata = resolve;
      media.onerror = () => reject(new Error(`can't read this ${tag}`));
    });
    return { width: media.videoWidth ?? 512, height: media.videoHeight ?? 512, length: media.duration }; // audio: its tile
  } finally {
    URL.revokeObjectURL(media.src);
  }
}

async function copyImage({ key, job, run, img }, detailsByJob) {
  if (!detailsByJob.has(job.id)) {
    detailsByJob.set(job.id, api(`api/jobs/${job.id}`).then((j) => ({ details: j.details ?? [], values: j.values ?? {}, runs: j.runs ?? [], recipe: j.recipe ?? null })));
  }
  const video = isVideo(img);
  const audio = isAudio(img);
  const src = { ...img, v: job.id };
  // Videos and audio are kept as they are (a few MB); images as a full-size WebP.
  const [thumb, full, { details, values, runs, recipe }, poster] = await Promise.all([
    audio ? new Blob([AUDIO_SVG], { type: "image/svg+xml" }) : fetchBlob(thumbUrl(src)),
    fetchBlob(video || audio ? originalUrl(src) : thumbUrl(src, COPY_SIZE)), detailsByJob.get(job.id),
    video ? fetchBlob(thumbUrl(src, 1600)) : null]);
  let width, height, length;
  if (video || audio) {
    ({ width, height, length } = await mediaInfo(full, audio ? "audio" : "video"));
  } else {
    const bitmap = await createImageBitmap(full);
    ({ width, height } = bitmap);
    bitmap.close();
  }
  const thisRun = runs.find((r) => r.index === run.index) ?? run; // the full run (the job list leaves texts out)
  const rec = {
    key, job_id: job.id, workflow_id: job.workflow_id, name: job.name,
    filename: img.filename, subfolder: img.subfolder,
    created: run.finished ?? job.created,
    duration: run.started && run.finished ? run.finished - run.started : null,
    width, height, thumb, full, ...(video && { video: true, poster, length }), ...(audio && { audio: true, length }),
    // This image's own seeds and rolls of {a|b}: what was really used, not what was typed.
    details: details.map((d) => (d.kind === "seed" ? { ...d, value: run.seeds[d.key] ?? d.value }
      : d.key in (thisRun.dynamic ?? {}) ? { ...d, value: thisRun.dynamic[d.key], rolled: true } : d)),
    values, // what the phone sent, for "Use again" (painted masks aren't in the details)
    recipe, // the workflow it was made with (a few KB), so "Use again" works after that workflow was deleted
    texts: thisRun.texts ?? [], // what text nodes (Preview as Text) showed
  };
  await tx("images", "readwrite", (t) => t.objectStore("images").put(rec));
  known.add(key);
  images = images.filter((r) => r.key !== key); // added by hand while it was also being copied
  images.push(rec);
  images.sort((a, b) => b.created - a.created);
  render();
  if (!persistAsked) {
    persistAsked = true;
    navigator.storage?.persist?.(); // asks Chrome not to clear the copies when space runs low
  }
}

const outputs = (job) => job.runs.flatMap((run) => run.outputs.map((img, i) => ({ key: `${job.id}:${run.index}:${i}`, job, run, img })));

/** Copies images of finished runs that aren't on the phone yet, unless turned off in Settings. Turned on
 * again, only those finished since then (older ones are added by hand from Tasks). Called with every job list. */
export async function syncImages(jobs) {
  const copy = setting("copyImages"); // null: on (the default), "off", or when it was turned on again
  if (copy === "off") return;
  const since = Number(copy ?? 0) / 1000;
  await loaded;
  if (syncRun) return;
  syncRun = copyNew(jobs.flatMap(outputs).filter((item) => (item.run.finished ?? 0) >= since));
  try {
    await syncRun;
  } finally {
    syncRun = null;
  }
}

let noRoom = false; // the phone's storage is full: no more copying until the app is opened again

async function copyNew(todo) {
  const detailsByJob = new Map();
  // New files first: the list is newest first, so a repeat would otherwise come before the run that made its file.
  todo.sort((a, b) => !!a.img.again - !!b.img.again);
  for (const item of todo) {
    if (noRoom) return;
    if (known.has(item.key) || failed.has(item.key)) continue;
    // A file saved before (the same settings again, so ComfyUI used its cache): one copy is enough.
    if (item.img.again && images.some((r) => r.filename === item.img.filename && (r.subfolder ?? "") === (item.img.subfolder ?? ""))) {
      known.add(item.key);
      // Kept like a deleted one, so it doesn't come back once that copy is deleted (Tasks can still add it).
      tx("deleted", "readwrite", (t) => t.objectStore("deleted").put(true, item.key)).catch(() => {});
      continue;
    }
    try {
      await copyImage(item, detailsByJob);
    } catch (err) {
      // Only a failed connection means "try again later" (fetch throws TypeError). Anything else would fail
      // the same way next time, after downloading the whole file again, and hold up the older images.
      if (err instanceof TypeError) break; // offline or PC asleep: try again with the next job list
      if (err.name === "QuotaExceededError") {
        noRoom = true;
        return toast("No room on this phone for more gallery copies. Free up space, then open the app again.", "bad");
      }
      const tries = (attempts.get(item.key) ?? 0) + 1;
      attempts.set(item.key, tries);
      if (err.status >= 500 && tries < 3) continue; // a hiccup on the PC: try again with the next job list
      failed.add(item.key);
      console.warn("Couldn't copy", item.img.filename, err);
      // A file this phone can't read (a ProRes video, say): not tried again, also after a restart, as if
      // deleted here (Tasks can still add it by hand). A missing one (404) needs no word.
      if (!err.status) {
        known.add(item.key);
        tx("deleted", "readwrite", (t) => t.objectStore("deleted").put(true, item.key)).catch(() => {});
        toast(`${item.img.filename} stays on the PC: ${err.message}`, "bad");
      }
    }
  }
}

/** Copies one finished image to the gallery by hand (from Tasks). */
export async function addToGallery(job, key) {
  await loaded;
  const item = outputs(job).find((o) => o.key === key);
  if (!item) throw new Error("image not found");
  if (images.some((r) => r.key === key)) return;
  await copyImage(item, new Map());
  await tx("deleted", "readwrite", (t) => t.objectStore("deleted").delete(key)); // deleted before, wanted again
}

/** Opens the gallery's viewer on an image, over whatever view is showing. false: not in the gallery.
 * series: the keys of all images of its job; ones still being copied are waited for, so the viewer has them all. */
export async function openInGallery(key, series = [key]) {
  await loaded;
  if (syncRun && series.some((k) => !images.some((r) => r.key === k))) {
    toast("Copying the images to the gallery…");
    await syncRun;
  }
  const index = images.findIndex((r) => r.key === key);
  if (index < 0) return false;
  openViewer(index);
  return true;
}

const stats = () => ({ count: images.length, bytes: images.reduce((sum, r) => sum + r.full.size + r.thumb.size, 0) });
export async function galleryInfo() {
  await loaded;
  return stats();
}

export async function deleteAllImages() {
  await remove([...images]);
  render();
}

// ---------- grid ----------
/** The phone's own preview of an image, if the gallery has it. */
export async function galleryThumb(key) {
  await loaded;
  const rec = images.find((r) => r.key === key);
  return rec && thumbSrc(rec);
}

function thumbSrc(rec) {
  if (rec.audio) return audioThumb; // always the current icon, also for clips copied before it changed
  if (!thumbUrls.has(rec.key)) thumbUrls.set(rec.key, URL.createObjectURL(rec.thumb));
  return thumbUrls.get(rec.key);
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;

function render() {
  if ($("#view-gallery").hidden) return;
  const { bytes } = stats();
  const videos = images.filter((r) => r.video).length;
  const audios = images.filter((r) => r.audio).length;
  const plural = (n, word) => (n ? [`${n} ${word}${n === 1 ? "" : "s"}`] : []);
  const counts = [...plural(images.length - videos - audios, "image"), ...plural(videos, "video"),
    ...plural(audios, "audio file")].join(", ");
  $("#gallery-stats").textContent = images.length ? `${counts} · ${mb(bytes)} on this phone` : "";
  $("#gallery-empty").hidden = images.length > 0;
  $("#gallery-empty").textContent = setting("copyImages") !== "off"
    ? "No images yet. Images you generate from the phone are copied here as they finish, so you can see them without the PC too."
    : "No images yet. Add the ones you want from Tasks, or turn on copying new images in Settings (⚙).";
  $("#select-btn").hidden = $("#save-format").hidden = !images.length;
  $("#save-format").textContent = `Save as ${saveFormat === "png" ? "original" : "WebP"}`;
  $("#gallery-grid").innerHTML = images.map((rec, i) => `
    <li><button class="thumb${rec.video ? " video" : ""}${selected?.has(rec.key) ? " selected" : ""}" data-i="${i}"
      ${selected ? `aria-pressed="${selected.has(rec.key)}"` : ""}
      aria-label="${esc(rec.name)}, ${esc(isoDateTime(rec.created * 1000))}">
      <img alt="" src="${thumbSrc(rec)}"></button></li>`).join("");
  document.body.classList.toggle("selecting", !!selected);
  $("#select-btn").textContent = selected ? "Done" : "Select";
  $("#select-count").textContent = selected ? `${selected.size} selected` : "";
  for (const b of ["#save-selected", "#delete-selected"]) $(b).disabled = !selected?.size;
}

export function showGallery() {
  render();
}

export function leaveGallery() {
  selected = null;
  document.body.classList.remove("selecting");
}

// ---------- save and delete ----------
const asIs = (rec) => rec.video || rec.audio; // stored unchanged; images as WebP
const copyName = (rec) => (asIs(rec) ? rec.filename : rec.filename.replace(/\.\w+$/, "") + ".webp");

/** Android's share sheet (messengers and so on), with the copy on the phone, so it works offline too. */
async function share(rec) {
  const files = [new File([rec.full], copyName(rec), { type: rec.full.type })];
  if (!navigator.canShare?.({ files })) return toast("This browser can't share files", "bad");
  try {
    await navigator.share({ files });
  } catch (err) {
    if (err.name !== "AbortError") toast(`Couldn't share: ${err.message}`, "bad"); // AbortError: closed the sheet
  }
}

async function save(recs) {
  let fellBack = ""; // why a PNG became the WebP copy: "gone" (deleted on the PC) or "away" (PC not reachable)
  for (const rec of recs) {
    const url = originalUrl({ ...rec, v: rec.job_id });
    // PNG only when the PC has it; otherwise the copy on the phone. Videos are stored unchanged anyway.
    const wantPng = !asIs(rec) && saveFormat === "png";
    const status = wantPng ? await fetch(url, { method: "HEAD" }).then((r) => r.status, () => 0) : 0;
    const png = status >= 200 && status < 300;
    if (wantPng && !png) fellBack = status === 404 ? "gone" : "away";
    const a = document.createElement("a");
    a.href = png ? url : URL.createObjectURL(rec.full);
    a.download = png ? rec.filename : copyName(rec);
    a.click();
    if (!png) setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }
  const what = recs.length > 1 ? `Saving ${recs.length} images to Downloads` : "Saving to Downloads";
  const why = fellBack === "gone"
    ? (recs.length > 1 ? "some originals are no longer on the PC" : "the original is no longer on the PC")
    : "PC not reachable for the original";
  toast(fellBack ? `${what} as WebP: ${why}` : what, "ok");
}

async function remove(recs) {
  await tx(["images", "deleted"], "readwrite", (t) => {
    for (const rec of recs) {
      t.objectStore("images").delete(rec.key);
      t.objectStore("deleted").put(true, rec.key);
    }
  });
  const keys = new Set(recs.map((r) => r.key));
  images = images.filter((r) => !keys.has(r.key));
  for (const key of keys) {
    URL.revokeObjectURL(thumbUrls.get(key));
    thumbUrls.delete(key);
  }
  toast(recs.length > 1 ? `Deleted ${recs.length} images from this phone` : "Deleted from this phone");
}

const confirmDelete = (n) =>
  confirm(`Delete ${n > 1 ? `${n} images` : "this image"} from the phone? The ${n > 1 ? "files" : "file"} on the PC stay.`);

// ---------- details ----------
function formatValue(d) {
  const v = d.value;
  if (v === null || v === undefined || v === "") return "–";
  if (d.kind === "bool") return v ? "Yes" : "No";
  // Files as "a.mp4 · output/video"; of the lists, those from output, and videos and audio (uploads from the phone)
  const file = d.kind === "combo" && fileRef(v);
  if (d.kind === "image" || file && (file.type === "output" || isVideo(file) || isAudio(file))) return fileLabel(v);
  if (d.kind === "loras") {
    const on = v.filter((l) => l.on);
    return on.length ? on.map((l) => `${l.lora} · ${l.strength}`).join("\n") : "None";
  }
  return String(v);
}

function formatDuration(s) {
  if (s === null) return null;
  return s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function detailsHtml(rec) {
  const rows = [
    ["Date", isoDateTime(rec.created * 1000)],
    ["Duration", formatDuration(rec.duration)],
    ...rec.details.map((d) => [d.label, formatValue(d)]),
    ...(rec.texts ?? []).map((t) => [t.label, t.text]),
    ["Size", rec.audio ? null : `${rec.width} × ${rec.height}`],
    ["Length", asIs(rec) && Number.isFinite(rec.length) ? formatDuration(rec.length) : null],
    ["File", rec.filename],
  ].filter(([, v]) => v !== null);
  return `<dl>${rows.map(([k, v]) => {
    const long = v.length > 240;
    // Long values show their first lines; "more" lets the same text run on (nothing is repeated).
    const value = long ? `<span class="clamp">${esc(v)}</span><button class="more" aria-expanded="false">more</button>` : esc(v);
    return `<dt>${esc(k)}</dt><dd>${value}</dd>`;
  }).join("")}</dl>`;
}

// ---------- use again ----------

/** Phone values that make the workflow produce rec again, on top of the workflow's current ones
 * (for settings shared after the image was made). */
function valuesFor(rec, wf, jobValues) {
  const fields = new Map(wf.fields.map((f) => [`${f.node}/${f.input}`, f]));
  const values = { ...(wf.values ?? {}) };
  const off = new Set();
  for (const d of rec.details) {
    const f = fields.get(d.key);
    if (!f) continue; // no longer shared
    if (d.bypassed ?? (d.value === "Bypassed" && !!wf.bypass?.[f.node])) {
      off.add(f.node);
      continue;
    }
    if (f.kind === "bypass" || d.value === null || d.value === undefined) continue;
    if (f.kind === "seed") values[d.key] = { mode: "fixed", value: d.value };
    else if (f.kind === "image") values[d.key] = { image: d.value, mask: jobValues?.[d.key]?.mask ?? null };
    // A rolled {a|b} is used as it came out; braces in it are meant literally, so they're escaped.
    else values[d.key] = d.rolled ? d.value.replace(/[{}|]/g, "\\$&") : d.value;
  }
  values["#bypass"] = [...off];
  return values;
}

async function useAgain(rec, pswp) {
  let wf = null;
  try {
    wf = await api(`api/workflows/${encodeURIComponent(rec.workflow_id)}`);
  } catch (err) {
    // Deleted since: the image carries the workflow it was made with (images copied before that came in don't).
    if (err.status !== 404) return toast(`Couldn't load the workflow: ${err.message}`, "bad");
    if (!rec.recipe) return toast(`"${rec.name}" is no longer on the phone`, "bad");
  }
  // A copy, so a workflow changed a lot since then isn't reset by accident.
  const when = isoDateTime(rec.created * 1000);
  const name = `${(wf ? wf.phone_name || wf.name : rec.name).slice(0, 90)} (image ${when})`;
  const jobValues = rec.values ?? await api(`api/jobs/${rec.job_id}`).then((j) => j.values, () => null);
  let copy;
  try {
    copy = wf
      ? await api(`api/workflows/${encodeURIComponent(wf.id)}/copy`, { method: "POST", body: { name, values: valuesFor(rec, wf, jobValues) } })
      : await api("api/workflows/restore", { method: "POST",
        body: { name, recipe: rec.recipe, values: valuesFor(rec, { ...rec.recipe, values: jobValues ?? {} }, jobValues) } });
  } catch (err) {
    return toast(`Couldn't use these settings: ${err.message}`, "bad");
  }
  toast(`New workflow "${copy.name}" with this image's settings (seed fixed)`);
  // Closing the viewer steps back in history; open the copy once that has happened.
  addEventListener("popstate", () => (location.hash = `#workflow/${encodeURIComponent(copy.id)}`), { once: true });
  pswp.close();
}

// ---------- full-screen viewer ----------
let infoOpen = false;
const ICON = (path) => `<svg class="pswp__icn pswp__icn-line" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">${path}</svg>`;

function openViewer(index) {
  const fullUrls = new Map();
  const pswp = new PhotoSwipe({
    dataSource: images.map((rec) => ({ width: rec.width, height: rec.height, rec })),
    index,
    bgOpacity: 1,
    showHideAnimationType: "fade",
    padding: { top: 0, bottom: 52, left: 0, right: 0 }, // room for the details bar
  });
  const blobUrl = (rec, part) => {
    const id = `${rec.key}/${part}`;
    if (!fullUrls.has(id)) fullUrls.set(id, URL.createObjectURL(rec[part]));
    return fullUrls.get(id);
  };
  pswp.addFilter("itemData", (data) => {
    const { rec } = data;
    if (rec.video) {
      return { ...data, html: `<div class="pswp-video"><video src="${blobUrl(rec, "full")}" poster="${blobUrl(rec, "poster")}"
        controls playsinline preload="metadata"></video></div>` };
    }
    if (rec.audio) {
      return { ...data, html: `<div class="pswp-video pswp-audio"><img src="${thumbSrc(rec)}" alt="">
        <audio src="${blobUrl(rec, "full")}" controls preload="metadata"></audio></div>` };
    }
    return { ...data, src: blobUrl(rec, "full"), msrc: thumbSrc(rec) };
  });
  const current = () => pswp.getItemData(pswp.currIndex).rec;
  // Touches on a video's control bar (or an audio player) go to the player instead of swiping.
  pswp.on("pointerDown", (e) => {
    const video = e.originalEvent.target.closest?.("video");
    if (video && e.originalEvent.clientY > video.getBoundingClientRect().bottom - 72) e.preventDefault();
    if (e.originalEvent.target.closest?.("audio")) e.preventDefault();
  });
  // Only the video on screen plays, and none after closing (the fade-out would keep the sound going).
  pswp.on("change", () => {
    for (const v of pswp.container.querySelectorAll("video, audio")) if (!pswp.currSlide.container.contains(v)) v.pause();
  });
  pswp.on("close", () => {
    for (const v of pswp.container.querySelectorAll("video, audio")) v.pause();
  });

  // Which way the user is going through the images: after deleting, the viewer carries on that way
  // (and only turns back at the end), so sorting out a series needs no extra swipe per image.
  let forward = true;
  let lastIndex = index;
  pswp.on("change", () => {
    const n = pswp.getNumItems();
    const step = (pswp.currIndex - lastIndex + n) % n; // the gallery loops around
    if (step) forward = step <= n / 2;
    lastIndex = pswp.currIndex;
  });
  const dropCurrent = () => {
    const i = pswp.currIndex;
    const before = pswp.getNumItems();
    pswp.options.dataSource.splice(i, 1);
    if (before === 1) return pswp.close();
    for (let k = i; k < before; k++) pswp.contentLoader.removeByIndex(k); // cached slides from here on moved by one
    lastIndex = i; // the image now at i is the one after the deleted one
    if (i === before - 1 || (!forward && i > 0)) pswp.goTo(i - 1);
    const at = pswp.currIndex;
    for (const k of [at - 1, at, at + 1]) pswp.refreshSlideContent(pswp.canLoop() ? pswp.getLoopedIndex(k) : k);
  };

  pswp.on("uiRegister", () => {
    pswp.ui.registerElement({
      name: "share", order: 7, isButton: true, title: "Share",
      html: ICON('<path d="M16 5v14m-5-9 5-5 5 5M11 14H8v12h16V14h-3"/>'),
      onClick: () => share(current()),
    });
    pswp.ui.registerElement({
      name: "save", order: 8, isButton: true, title: "Save to device",
      html: ICON('<path d="M16 6v14m-6-6 6 6 6-6M8 25h16"/>'),
      onClick: () => save([current()]),
    });
    pswp.ui.registerElement({
      name: "delete", order: 9, isButton: true, title: "Delete from phone",
      html: ICON('<path d="M9 10h14m-11 0V8h8v2m-9 0 1 15h8l1-15"/>'),
      onClick: async () => {
        if (!confirmDelete(1)) return;
        await remove([current()]);
        dropCurrent();
      },
    });
    pswp.ui.registerElement({
      name: "details", appendTo: "root",
      onInit: (el) => {
        const update = () => {
          const rec = current();
          el.innerHTML = `
            <button class="details-toggle" aria-expanded="${infoOpen}">
              <span>${esc(rec.name)} · ${esc(isoDate(rec.created * 1000))}</span>
              <span aria-hidden="true">${infoOpen ? "▾" : "▴"}</span>
            </button>
            <div class="details-body" ${infoOpen ? "" : "hidden"}>
              <button class="chip use-again">Use again</button>
              ${detailsHtml(rec)}
            </div>`;
        };
        el.addEventListener("click", (e) => {
          if (e.target.closest(".use-again")) return useAgain(current(), pswp);
          const more = e.target.closest(".more");
          if (more) {
            const open = more.parentElement.classList.toggle("open");
            more.textContent = open ? "less" : "more";
            more.setAttribute("aria-expanded", String(open));
            return;
          }
          if (!e.target.closest(".details-toggle")) return;
          infoOpen = !infoOpen;
          update();
        });
        // Keeps PhotoSwipe from treating scrolling the details as a swipe.
        for (const type of ["pointerdown", "touchstart", "wheel"]) el.addEventListener(type, (e) => e.stopPropagation());
        pswp.on("change", update);
        update();
      },
    });
  });

  // Android's back button closes the viewer instead of leaving the gallery.
  // close() is ignored while the opening animation runs, so a quick Back waits for it.
  const release = closeOnBack(() => (pswp.opener.isOpening ? pswp.on("openingAnimationEnd", () => pswp.close()) : pswp.close()));
  pswp.on("destroy", () => {
    release();
    for (const url of fullUrls.values()) URL.revokeObjectURL(url);
    render();
  });
  pswp.init();
}

// ---------- setup ----------
export function initGallery() {
  loaded = load().catch((err) => {
    console.error(err);
    $("#gallery-empty").textContent = `Can't open the phone's image storage (${err.message}).`;
  });

  $("#gallery-grid").addEventListener("click", (e) => {
    const btn = e.target.closest(".thumb");
    if (!btn) return;
    const rec = images[Number(btn.dataset.i)];
    if (!selected) return openViewer(Number(btn.dataset.i));
    if (selected.has(rec.key)) selected.delete(rec.key);
    else selected.add(rec.key);
    render();
  });
  $("#save-format").addEventListener("click", () => {
    saveFormat = saveFormat === "png" ? "webp" : "png";
    try {
      localStorage.setItem("saveFormat", saveFormat);
    } catch { /* setting lasts until the app closes */ }
    render();
    toast(saveFormat === "png" ? "Save now stores the original from the PC (a PNG with its workflow)"
      : "Save now stores the small WebP copy from this phone");
  });
  $("#select-btn").addEventListener("click", () => {
    selected = selected ? null : new Set();
    render();
  });
  const chosen = () => images.filter((r) => selected?.has(r.key));
  $("#save-selected").addEventListener("click", () => save(chosen()));
  $("#delete-selected").addEventListener("click", async () => {
    const recs = chosen();
    if (!recs.length || !confirmDelete(recs.length)) return;
    await remove(recs);
    selected = null;
    render();
  });
}

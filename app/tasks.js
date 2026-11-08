// Tasks: the phone's queue on the PC, with progress, time left and controls, plus finished jobs.
import { $, api, audioThumb, closeOnBack, esc, h, isAudio, isVideo, originalUrl, thumbUrl, toast } from "./api.js";
import { addToGallery, galleryThumb, openInGallery, syncImages } from "./gallery.js";
import { saveAsPrompt } from "./prompts.js";

let pollTimer = null;
let lastSignature = "";
let generation = 0; // stops a poll that was still waiting for the PC when polling restarted
let jobs = []; // newest first, as the PC sends them
const MAX_FINISHED = 100; // MAX_JOBS in jobs.py (tests/test_jobs.py checks they match)

// key: the image's name in the gallery
const outputsOf = (job) => job.runs.flatMap((r) => r.outputs.map((img, i) => ({ ...img, v: job.id, key: `${job.id}:${r.index}:${i}` })));
const kindOf = (img) => (isVideo(img) ? "video" : isAudio(img) ? "audio" : "image");
const isFinished = (job) => job.runs.every((r) => ["done", "error", "cancelled"].includes(r.status));
const isActive = (job) => job.runs.some((r) => r.status === "running" || (r.status === "queued" && !job.paused));

function formatEta(seconds) {
  if (seconds < 60) return "under a minute left";
  const min = Math.round(seconds / 60);
  return min < 60 ? `~${min} min left` : `~${Math.floor(min / 60)} h ${min % 60} min left`;
}

/** The parts of a card that change while an image is generating. */
function live(job) {
  const runs = job.runs;
  const count = (status) => runs.filter((r) => r.status === status).length;
  const done = count("done");
  const failed = count("error");
  const skipped = runs.filter((r) => r.status === "cancelled" && r.skip).length;
  const cancelled = count("cancelled") - skipped;
  const running = runs.find((r) => r.status === "running");
  const step = running?.progress ? running.progress.value / running.progress.max : 0;
  const parts = [];
  if (running) {
    parts.push(`Generating ${running.index + 1} of ${runs.length}`);
    if (running.progress) parts.push(`step ${running.progress.value}/${running.progress.max}`);
    if (job.cancelled) parts.push("cancelling…");
    else if (job.paused) parts.push("pauses after this image");
  } else if (!isFinished(job)) {
    parts.push(job.paused ? "Paused" : "Waiting");
  } else if (done === runs.length) {
    parts.push("Done");
  } else {
    parts.push(...[done && `${done} done`, failed && `${failed} failed`, skipped && `${skipped} skipped`,
      cancelled && `${cancelled} cancelled`].filter(Boolean));
  }
  if (job.eta !== null && job.eta !== undefined && !isFinished(job)) parts.push(formatEta(job.eta));
  return {
    finishedRuns: done + failed + skipped + cancelled,
    pct: Math.round(((done + failed + skipped + cancelled + step) / runs.length) * 100),
    text: `${done}/${runs.length} · ${parts.join(" · ")}`,
  };
}

/** Pictures, videos or audio that nodes only previewed (gone after the run), added up over the job's
 * runs: "Not saved: 3 images. Add a Save Image node to keep them." Counted per run by the PC (jobs.py). */
function unsavedNote(runs) {
  const counts = {};
  for (const r of runs) for (const [kind, n] of Object.entries(r.unsaved ?? {})) counts[kind] = (counts[kind] ?? 0) + n;
  const kinds = Object.keys(counts);
  if (!kinds.length) return "";
  const word = { image: "image", video: "video", audio: "audio file" };
  const node = { image: "Save Image", video: "Save Video", audio: "Save Audio" };
  const total = kinds.reduce((sum, k) => sum + counts[k], 0);
  const what = kinds.map((k) => `${counts[k]} ${word[k] ?? k}${counts[k] === 1 ? "" : "s"}`).join(", ");
  return `Not saved: ${what}. Add a ${kinds.map((k) => node[k] ?? "save").join(" or ")} node to keep ${total === 1 ? "it" : "them"}.`;
}

function jobCard(job, position = {}) {
  const s = live(job);
  const finished = isFinished(job);
  const images = outputsOf(job);
  const texts = job.runs.filter((r) => r.peek); // text-only results (an LLM's answer, say)
  const errors = [...new Set(job.runs.map((r) => r.error).filter(Boolean))];
  const unsaved = unsavedNote(job.runs);
  const name = esc(job.name);
  const several = job.runs.length > 1;
  const running = job.runs.find((r) => r.status === "running");
  const controls = finished ? "" : `
    <div class="job-controls">
      <button class="chip" data-action="${job.paused ? "resume" : "pause"}">${job.paused ? "Resume" : "Pause"}</button>
      ${several && running ? `<button class="chip" data-action="skip" ${running.skip || job.cancelled ? "disabled" : ""}>Skip image</button>` : ""}
      <button class="chip danger" data-action="cancel" ${job.cancelled ? "disabled" : ""}>${several ? "Cancel all" : "Cancel"}</button>
      <span class="spacer"></span>
      <button class="icon-btn" data-action="up" aria-label="Run ${name} earlier" ${position.first ? "disabled" : ""}>↑</button>
      <button class="icon-btn" data-action="down" aria-label="Run ${name} later" ${position.last ? "disabled" : ""}>↓</button>
    </div>`;
  return `
    <li class="card job${job.paused ? " paused" : ""}" data-id="${esc(job.id)}">
      <div class="job-head">
        <span class="item-title">${name}</span>
        <span class="item-meta">${new Date(job.created * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        ${finished ? `<button class="icon-btn" data-action="remove" aria-label="Remove ${name} from the list">✕</button>` : ""}
      </div>
      <div class="progress" role="progressbar" aria-label="${name} progress" aria-valuemin="0"
        aria-valuemax="${job.runs.length}" aria-valuenow="${s.finishedRuns}"><span style="width:${s.pct}%"></span></div>
      <p class="item-meta job-status">${esc(s.text)}</p>
      ${errors.map((e) => `<p class="bad small">${esc(e)}</p>`).join("")}
      ${unsaved ? `<p class="muted small">${esc(unsaved)}</p>` : ""}
      ${controls}
      ${images.length ? `<div class="thumbs">${images.map((img, i) => `
        <button class="thumb${isVideo(img) ? " video" : ""}" data-i="${i}" aria-label="Open ${kindOf(img)} ${i + 1}">
          <img loading="lazy" alt="" src="${esc(isAudio(img) ? audioThumb : thumbUrl(img))}"></button>`).join("")}</div>` : ""}
      ${texts.length ? `<div class="text-results">${texts.map((r) => `
        <button class="text-result" data-run="${r.index}" aria-label="Open text ${r.index + 1}">${r.peek.map((t) =>
          `<span class="peek"><b>${esc(t.label)}</b> ${esc(t.text)}</span>`).join("")}</button>`).join("")}</div>` : ""}
    </li>`;
}

function render() {
  const queue = jobs.filter((j) => !isFinished(j)).reverse(); // the order they run in
  const finished = jobs.filter(isFinished).sort((a, b) => b.created - a.created);
  $("#queue-list").innerHTML = queue.map((j, i) => jobCard(j, { first: i === 0, last: i === queue.length - 1 })).join("");
  $("#finished-list").innerHTML = finished.map((j) => jobCard(j)).join("");
  $("#queue-head").hidden = !queue.length;
  $("#finished-head").hidden = !finished.length;
  $("#finished-full").hidden = finished.length < MAX_FINISHED; // the PC drops the oldest beyond that
  $("#tasks-empty").hidden = jobs.length > 0;
}

/** Progress and time left change every poll; updating them in place keeps buttons tappable. */
function updateLive() {
  for (const job of jobs) {
    const card = $(`.job[data-id="${CSS.escape(job.id)}"]`);
    if (!card) continue;
    const s = live(job);
    $(".progress span", card).style.width = `${s.pct}%`;
    $(".progress", card).setAttribute("aria-valuenow", s.finishedRuns);
    $(".job-status", card).textContent = s.text;
    livePreview(job, card);
  }
}

/** The latest in-between picture of the generating image, refreshed with every poll. */
function livePreview(job, card) {
  const run = job.runs.find((r) => r.status === "running");
  const version = run?.preview;
  let box = $(".live-preview", card);
  if (!version) return box?.remove();
  if (!box) {
    const img = h("img", { alt: "Live preview" });
    img.addEventListener("error", () => (box.hidden = true)); // the image finished in between
    img.addEventListener("load", () => (box.hidden = false));
    box = h("div", { className: "live-preview" }, img);
    $(".job-status", card).after(box);
  }
  // The version starts at 1 for every image of a series: the run makes the address unique, so the
  // browser never shows the previous image's picture for it.
  const src = `api/jobs/${encodeURIComponent(job.id)}/preview?run=${run.index}&v=${version}`;
  const img = $("img", box);
  if (img.getAttribute("src") !== src) img.src = src;
}

async function refresh() {
  try {
    jobs = await api("api/jobs");
  } catch (err) {
    $("#tasks-error").textContent = `Couldn't load tasks (${err.message}).`;
    $("#tasks-error").hidden = false;
    return true;
  }
  $("#tasks-error").hidden = true;
  syncImages(jobs);
  const signature = JSON.stringify(jobs.map((j) => [j.id, j.paused, j.cancelled,
    j.runs.map((r) => [r.status, r.outputs.length, r.error, r.skip, r.unsaved])]));
  if (signature !== lastSignature) {
    lastSignature = signature;
    render();
  }
  updateLive();
  return jobs.some(isActive);
}

async function poll(gen) {
  const active = await refresh();
  if (gen !== generation) return;
  // Fast while something runs, slow otherwise (a job may also be started from another device).
  pollTimer = setTimeout(() => poll(gen), active ? 1500 : 8000);
}

export function showTasks() {
  stopTasks();
  poll(generation);
}

export function stopTasks() {
  generation++;
  clearTimeout(pollTimer);
  pollTimer = null;
}

async function act(job, action) {
  const rest = job.runs.length > 1 ? " and all its remaining images" : "";
  if (action === "cancel" && !confirm(`Cancel "${job.name}"${rest}? Images that are already finished stay.`)) return;
  try {
    if (action === "remove") await api(`api/jobs/${job.id}`, { method: "DELETE" });
    else await api(`api/jobs/${job.id}/${action}`, { method: "POST" });
  } catch (err) {
    toast(err.message, "bad");
  }
  showTasks();
}

/** Copy, share as a .txt file, or keep as a prompt: what one text node showed. */
function textActions(t, name) {
  const btn = (label, onclick) => h("button", { className: "chip", textContent: label, onclick }); // like a workflow's buttons
  return h("span", { className: "text-actions" },
    btn("Copy", () => navigator.clipboard.writeText(t.text)
      .then(() => toast("Copied", "ok"), (err) => toast(`Couldn't copy: ${err.message}`, "bad"))),
    btn("Share", () => shareText(t.text, `${name} - ${t.label}`)),
    btn("Save as prompt", () => saveAsPrompt(t.text)));
}

async function shareText(text, title) {
  const files = [new File([text], `${title.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80)}.txt`, { type: "text/plain" })];
  try {
    if (navigator.canShare?.({ files })) await navigator.share({ files });
    else await navigator.share({ text }); // no files on this browser: the text itself
  } catch (err) {
    if (err.name !== "AbortError") toast(`Couldn't share: ${err.message}`, "bad"); // AbortError: closed the sheet
  }
}

/** Full screen over Tasks: a picture or video (or, with media null, just the texts), buttons, and what
 * text nodes (Preview as Text) showed, scrollable below. Returns a function that sets the texts later. */
function showViewer(media, label, buttons, texts = [], name = "") {
  const close = (viaBack = false) => {
    if (viaBack !== true) release();
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const release = closeOnBack(() => close(true));
  const onKey = (e) => e.key === "Escape" && close();
  const panel = h("div", { className: "viewer-text" });
  const setTexts = (list) => {
    panel.replaceChildren(...list.flatMap((t) => [
      h("div", { className: "text-head" }, h("h3", { textContent: t.label }), textActions(t, name)),
      h("p", { textContent: t.text })]));
    panel.hidden = !list.length;
  };
  setTexts(texts);
  const overlay = h("div", { className: `viewer${media ? "" : " text-only"}`, role: "dialog", "aria-modal": "true", "aria-label": label },
    media,
    h("div", { className: "viewer-bar" }, ...buttons,
      h("button", { className: "icon-btn", "aria-label": "Close", textContent: "✕", onclick: close })),
    panel);
  overlay.addEventListener("click", (e) => e.target === overlay || e.target.tagName === "IMG" ? close() : null);
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  return setTexts;
}

function openViewer(job, img) {
  const media = isVideo(img)
    ? h("video", { src: originalUrl(img), poster: thumbUrl(img, 1600), controls: true, autoplay: true, playsInline: true })
    : isAudio(img)
      ? h("div", { className: "viewer-audio" }, h("img", { src: audioThumb, alt: "" }),
        h("audio", { src: originalUrl(img), controls: true, autoplay: true }))
      : h("img", { src: thumbUrl(img, 1600), alt: img.filename });
  const setTexts = showViewer(media, { video: "Video", audio: "Audio", image: "Image" }[kindOf(img)], [
    h("a", { href: originalUrl(img), target: "_blank", rel: "noopener", textContent: "Original" }),
    addButton(job, img)], [], job.name);
  // The job list carries no texts of finished images; this one job does.
  const runIndex = Number(img.key.split(":")[1]);
  api(`api/jobs/${encodeURIComponent(job.id)}`)
    .then((j) => setTexts(j.runs.find((r) => r.index === runIndex)?.texts ?? []), () => {});
}

/** The live preview, large, with what text nodes have shown so far (the prompt, say). */
function openLive(job, box) {
  const run = job.runs.find((r) => r.status === "running");
  showViewer(h("img", { src: $("img", box).src, alt: "Live preview" }), "Live preview", [], run?.texts ?? [], job.name);
}

/** A text-only result (an LLM's answer, say): its texts, full screen. The list has only their start. */
function openText(job, runIndex) {
  const setTexts = showViewer(null, "Text", [], [], job.name);
  api(`api/jobs/${encodeURIComponent(job.id)}`)
    .then((j) => setTexts(j.runs.find((r) => r.index === runIndex)?.texts ?? []),
      (err) => toast(`Couldn't load the text (${err.message})`, "bad"));
}

function addButton(job, img) {
  const btn = h("button", { className: "viewer-btn", textContent: "Add to gallery" });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Adding…";
    try {
      await addToGallery(job, img.key);
      btn.textContent = "In gallery ✓";
      toast("Added to the gallery", "ok");
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Add to gallery";
      toast(`Couldn't add it: ${err.message}`, "bad");
    }
  });
  return btn;
}

export function initTasks() {
  $("#view-tasks").addEventListener("click", async (e) => {
    const card = e.target.closest(".job");
    const job = card && jobs.find((j) => j.id === card.dataset.id);
    if (!job) return;
    const btn = e.target.closest("[data-action]");
    if (btn) return act(job, btn.dataset.action);
    const text = e.target.closest(".text-result");
    if (text) return openText(job, Number(text.dataset.run));
    const live = e.target.closest(".live-preview");
    if (live) return openLive(job, live);
    const thumb = e.target.closest(".thumb");
    if (!thumb) return;
    const images = outputsOf(job);
    const img = images[Number(thumb.dataset.i)];
    // Already in the gallery: its viewer, with details, sharing and Use again (Back returns here).
    if (await openInGallery(img.key, images.map((i) => i.key))) return;
    if (thumb.classList.contains("gone")) return toast("Deleted on the PC, and there's no copy on this phone", "bad");
    openViewer(job, img);
  });
  // A preview that won't load: if the PC answers that the file is gone, say so instead of a broken picture.
  $("#view-tasks").addEventListener("error", async (e) => {
    const thumb = e.target.tagName === "IMG" && e.target.closest(".thumbs .thumb");
    const job = thumb && jobs.find((j) => j.id === thumb.closest(".job")?.dataset.id);
    const img = job && outputsOf(job)[Number(thumb.dataset.i)];
    if (!img) return;
    const ownCopy = e.target.src.startsWith("blob:"); // the gallery's copy failed too
    const status = ownCopy ? 404 : await fetch(originalUrl(img), { method: "HEAD" }).then((r) => r.status, () => 0); // 0: PC away
    if (status !== 404 || thumb.classList.contains("gone")) return;
    const copy = !ownCopy && await galleryThumb(img.key);
    if (copy) return void (e.target.src = copy); // gone from the PC, but the gallery still has it
    thumb.classList.add("gone");
    thumb.setAttribute("aria-label", `${thumb.getAttribute("aria-label")}, deleted on the PC`);
  }, true); // error events don't bubble: caught on the way down
  $("#clear-finished").addEventListener("click", async () => {
    try {
      await api("api/jobs", { method: "DELETE" });
    } catch (err) {
      toast(err.message, "bad");
    }
    showTasks();
  });
}

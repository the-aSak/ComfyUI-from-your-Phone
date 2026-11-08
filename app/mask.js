// Full-screen mask painter. One finger paints, two fingers zoom and move the photo.
// The mask is a PNG whose alpha channel marks the area.
import { closeOnBack, h } from "./api.js";

const MAX_SIDE = 1600; // the mask is scaled to the photo's size by the loader node
const MAX_ZOOM = 8;

/** Resolves with a PNG data URL ("" when nothing is painted), or undefined when cancelled. */
export function paintMask(photoUrl, existingMask) {
  return new Promise((resolve) => {
    const photo = h("img", { alt: "", draggable: false });
    const canvas = h("canvas", { className: "painter-canvas", "aria-label": "Mask: paint with one finger, zoom with two" });
    const frame = h("div", { className: "painter-frame" }, photo, canvas);
    const stage = h("div", { className: "painter-stage" }, frame);
    const size = h("input", { type: "range", min: 8, max: 120, value: 40, "aria-label": "Brush size" });
    const paintBtn = h("button", { className: "seg", textContent: "Paint", "aria-pressed": "true" });
    const eraseBtn = h("button", { className: "seg", textContent: "Erase", "aria-pressed": "false" });
    const undoBtn = h("button", { className: "chip", textContent: "Undo", disabled: true });
    const clearBtn = h("button", { className: "chip", textContent: "Clear" });
    const fitBtn = h("button", { className: "chip painter-fit", textContent: "Fit", hidden: true });
    const overlay = h("div", { className: "painter", role: "dialog", "aria-modal": "true", "aria-label": "Paint mask" },
      h("div", { className: "painter-bar" },
        h("button", { className: "chip", textContent: "Cancel", onclick: () => finish(undefined) }),
        h("span", { className: "painter-title", textContent: "Paint mask" }),
        h("button", { className: "primary", textContent: "Done", onclick: () => finish(exportMask()) })),
      stage, fitBtn,
      h("div", { className: "painter-bar" },
        h("div", { className: "segmented", role: "group", "aria-label": "Tool" }, paintBtn, eraseBtn),
        size, undoBtn, clearBtn));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const undo = [];
    let erasing = false;

    // ---------- zoom ----------
    const view = { scale: 1, x: 0, y: 0 }; // CSS transform of the frame (origin top left)
    function applyView() {
      frame.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
      fitBtn.hidden = view.scale === 1;
    }
    function resetView() {
      Object.assign(view, { scale: 1, x: 0, y: 0 });
      applyView();
    }
    fitBtn.onclick = resetView;

    function fit() {
      if (!canvas.width) return;
      const scale = Math.min(stage.clientWidth / canvas.width, stage.clientHeight / canvas.height);
      frame.style.width = `${canvas.width * scale}px`;
      frame.style.height = `${canvas.height * scale}px`;
      resetView();
    }

    // ---------- pointers: one paints, two zoom ----------
    const pointers = new Map(); // pointerId -> {x, y} on screen
    let painting = null; // pointerId of the finger that paints
    let pinch = null; // gesture start: distance, frame point under the fingers, scale
    let blocked = false; // after a pinch, wait until all fingers are up before painting again
    let last = null;

    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) * canvas.width) / r.width, y: ((e.clientY - r.top) * canvas.height) / r.height };
    };
    const twoFingers = () => {
      const [a, b] = [...pointers.values()];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    };
    // Untransformed top left of the frame on screen.
    const origin = () => {
      const r = frame.getBoundingClientRect();
      return { x: r.left - view.x, y: r.top - view.y };
    };

    function stroke(from, to) {
      const r = canvas.getBoundingClientRect();
      ctx.globalCompositeOperation = erasing ? "destination-out" : "source-over";
      ctx.strokeStyle = "#ff0000";
      ctx.lineCap = ctx.lineJoin = "round";
      ctx.lineWidth = (Number(size.value) * canvas.width) / r.width; // brush size in screen pixels
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }

    function remember() {
      undo.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (undo.length > 10) undo.shift();
      undoBtn.disabled = false;
    }

    stage.addEventListener("pointerdown", (e) => {
      try {
        stage.setPointerCapture(e.pointerId); // keeps the stroke going when the finger leaves the photo
      } catch {
        // pointer already gone
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1 && !blocked) {
        painting = e.pointerId;
        remember();
        last = pos(e);
        stroke(last, last);
      } else if (pointers.size === 2) {
        if (painting !== null) {
          ctx.putImageData(undo.pop(), 0, 0); // the first finger was the start of a pinch, not a stroke
          undoBtn.disabled = !undo.length;
          painting = null;
        }
        blocked = true;
        const { dist, mid } = twoFingers();
        const o = origin();
        pinch = { dist, scale: view.scale, at: { x: (mid.x - o.x - view.x) / view.scale, y: (mid.y - o.y - view.y) / view.scale } };
      }
    });
    stage.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (e.pointerId === painting) {
        const p = pos(e);
        stroke(last, p);
        last = p;
      } else if (pinch && pointers.size === 2) {
        const { dist, mid } = twoFingers();
        const o = origin();
        view.scale = Math.min(MAX_ZOOM, Math.max(1, pinch.scale * (dist / pinch.dist)));
        // keep the point that was under the fingers under them
        view.x = mid.x - o.x - pinch.at.x * view.scale;
        view.y = mid.y - o.y - pinch.at.y * view.scale;
        applyView();
      }
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId === painting) painting = null;
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) {
        blocked = false;
        if (view.scale < 1.05) resetView();
      }
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);

    // ---------- tools ----------
    const setTool = (erase) => {
      erasing = erase;
      paintBtn.setAttribute("aria-pressed", String(!erase));
      eraseBtn.setAttribute("aria-pressed", String(erase));
    };
    paintBtn.onclick = () => setTool(false);
    eraseBtn.onclick = () => setTool(true);
    undoBtn.onclick = () => {
      ctx.putImageData(undo.pop(), 0, 0);
      undoBtn.disabled = !undo.length;
    };
    clearBtn.onclick = () => {
      remember();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };

    function exportMask() {
      const alpha = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < alpha.length; i += 4) if (alpha[i]) return canvas.toDataURL("image/png");
      return "";
    }

    // Android's back button cancels instead of leaving the workflow.
    const release = closeOnBack(() => finish(undefined, true));
    addEventListener("resize", fit);

    function finish(result, viaBack = false) {
      if (!viaBack) release();
      removeEventListener("resize", fit);
      overlay.remove();
      resolve(result);
    }

    photo.onload = async () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(photo.naturalWidth, photo.naturalHeight));
      canvas.width = Math.round(photo.naturalWidth * scale);
      canvas.height = Math.round(photo.naturalHeight * scale);
      if (existingMask) {
        const old = new Image();
        old.src = existingMask;
        await old.decode().catch(() => {});
        ctx.drawImage(old, 0, 0, canvas.width, canvas.height);
      }
      fit();
    };
    photo.src = photoUrl;
    document.body.append(overlay);
  });
}

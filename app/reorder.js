// Reordering list items while the list has the class "reordering": drag the ⠿ handle or use ↑/↓.

/** Moves an item one place up (-1) or down (1), then calls onChange. */
export function moveItem(li, delta, onChange) {
  const list = li.parentElement;
  const target = delta < 0 ? li.previousElementSibling : li.nextElementSibling?.nextElementSibling ?? null;
  if (delta < 0 && !target) return;
  list.insertBefore(li, target);
  li.querySelector(delta < 0 ? ".up" : ".down")?.focus();
  onChange();
}

/** Lets items be dragged by their .drag handle; onChange runs when one is dropped. */
export function enableDrag(list, onChange) {
  list.addEventListener("dragstart", (e) => e.preventDefault()); // no native drag, it would cancel ours
  list.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".drag");
    if (!handle || !list.classList.contains("reordering")) return;
    e.preventDefault();
    const item = handle.closest("li");
    item.classList.add("dragging");
    // Listen on window: moving the item in the DOM drops pointer capture on the handle.
    const onMove = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      const after = [...list.children].find((s) => {
        if (s === item) return false;
        const r = s.getBoundingClientRect();
        return ev.clientY < r.top + r.height / 2;
      });
      if (after !== item.nextElementSibling) list.insertBefore(item, after ?? null);
      if (ev.clientY < 90) window.scrollBy(0, -14);
      else if (ev.clientY > window.innerHeight - 170) window.scrollBy(0, 14);
    };
    const onUp = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      item.classList.remove("dragging");
      onChange();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
}

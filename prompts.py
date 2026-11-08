"""The phone's prompt and snippet library, kept on the PC as a backup and to share between devices.

The phones own the library; the PC only merges what they send and gives back the result. Merging is the
same on both sides (app/prompts.js mirrors merge_entry) and never loses text:
- every entry has a fixed id, so an entry coming back is merged, never doubled;
- text and name go by their last change ("updated"), the place in the list by its own time ("posUpdated"),
  so an older version never replaces a newer one, and reordering on one device can't undo an edit on another;
- deleting (only possible on a phone) leaves a marker; an entry edited after it was deleted stays.
Before every write the previous file is kept as prompts.prev.json, without the text of anything deleted:
a deleted entry keeps no text anywhere on the PC.
"""
import json
import math
import re
from pathlib import Path

try:
    from .workflows import HALF_CHARACTERS, replace_file
except ImportError:  # loaded standalone by the tests
    from workflows import HALF_CHARACTERS, replace_file

KINDS = ("prompt", "snippet")
ID_RE = re.compile(r"^[a-z0-9-]{1,40}$")
MAX_ENTRIES = 5000  # prompts and snippets; deletion markers don't count, they hold no text
MAX_MARKERS = 100000  # a marker is ~150 bytes, so even this many stays small
MAX_TEXT = 50_000  # characters per entry: as much as a prompt field takes (jobs.MAX_TEXT)
MAX_TOTAL_TEXT = 20_000_000  # characters in the whole library


def _finite(v):
    """A number the browser can read back: Python's json also takes Infinity and NaN, JavaScript doesn't (and an
    "updated" of Infinity would win every merge after it)."""
    try:
        return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
    except OverflowError:
        return False  # an int too large for a float


def _number(v):
    return _finite(v) and v >= 0


def validate(entry):
    """A clean copy of an entry from a phone, or ValueError."""
    if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not ID_RE.match(entry["id"]):
        raise ValueError("entry needs an id")
    deleted = entry.get("deleted")
    clean = {
        "id": entry["id"], "kind": entry.get("kind"), "name": entry.get("name", ""), "text": entry.get("text", ""),
        "created": entry.get("created"), "updated": entry.get("updated"),
        "pos": entry.get("pos", 0), "posUpdated": entry.get("posUpdated", 0), "deleted": deleted or None,
    }
    if clean["kind"] not in KINDS:
        raise ValueError(f"entry {entry['id']}: kind must be prompt or snippet")
    if not isinstance(clean["name"], str) or len(clean["name"]) > 200:
        raise ValueError(f"entry {entry['id']}: name too long")
    if not isinstance(clean["text"], str) or len(clean["text"]) > MAX_TEXT:
        raise ValueError(f"entry {entry['id']}: text too long")
    if not all(_number(clean[k]) for k in ("created", "updated", "posUpdated")) or not _finite(clean["pos"]):
        raise ValueError(f"entry {entry['id']}: bad times")
    if deleted is not None and not _number(deleted):
        raise ValueError(f"entry {entry['id']}: bad deletion time")
    return clean


def is_gone(entry):
    """Deleted, and not changed since."""
    return bool(entry.get("deleted")) and entry["deleted"] >= entry["updated"]


def merge_entry(a, b):
    """Two versions of the same entry -> one. Same result whichever comes first."""
    # Newer content wins; at the same time the copy that still has its text, then a fixed order.
    content = max(a, b, key=lambda e: (e["updated"], bool(e["text"]), e["text"], e["name"], e["kind"]))
    place = max(a, b, key=lambda e: (e["posUpdated"], e["pos"]))
    merged = dict(content, pos=place["pos"], posUpdated=place["posUpdated"],
                  deleted=max(a.get("deleted") or 0, b.get("deleted") or 0) or None)
    if is_gone(merged):
        merged.update(name="", text="")  # a deleted entry keeps only its marker
    return merged


def merge(ours, theirs):
    """Two libraries -> one: every entry of both, merged by id. Nothing is dropped."""
    by_id = {e["id"]: e for e in ours}
    for e in theirs:
        by_id[e["id"]] = merge_entry(by_id[e["id"]], e) if e["id"] in by_id else e
    return sorted(by_id.values(), key=lambda e: (e["created"], e["id"]))


class PromptLibrary:
    def __init__(self, path):
        self.path = Path(path)

    def load(self):
        # An unreadable file raises (no sync) rather than counting as empty, which would hide what's in it.
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []

    def version(self):
        """Changes whenever the stored library changes; lets a phone ask "anything new?" cheaply."""
        try:
            st = self.path.stat()
            return f"{st.st_mtime_ns}-{st.st_size}"
        except FileNotFoundError:
            return "0"

    def sync(self, entries):
        """Merges a phone's library into the PC's copy and returns the merged library."""
        if not isinstance(entries, list) or len(entries) > MAX_ENTRIES + MAX_MARKERS:
            raise ValueError("entries must be a list")
        incoming = [validate(e) for e in entries]  # all or nothing: one bad entry rejects the whole sync
        stored = self.load()
        merged = merge(stored, incoming)
        live = [e for e in merged if not is_gone(e)]
        if len(live) > MAX_ENTRIES or len(merged) - len(live) > MAX_MARKERS:
            raise ValueError(f"the library is full: at most {MAX_ENTRIES} prompts and snippets")
        if sum(len(e["text"]) + len(e["name"]) for e in live) > MAX_TOTAL_TEXT:
            raise ValueError("the library is full: too much text in all")
        if merged != stored:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self.path.exists():
                # The version before, in case the file breaks; but what was just deleted is gone from it too.
                gone = {e["id"] for e in merged if is_gone(e)}
                self._write(self.path.with_name("prompts.prev.json"),
                            [dict(e, name="", text="") if e["id"] in gone else e for e in stored])
            self._write(self.path, merged)
        return merged

    @staticmethod
    def _write(path, entries):
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8", errors=HALF_CHARACTERS)
        replace_file(tmp, path)

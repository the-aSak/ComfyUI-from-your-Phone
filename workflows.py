"""Storage for workflows shared to the phone. No ComfyUI imports, so it can be tested on its own."""
import json
import os
import re
import secrets
import time
from pathlib import Path

KINDS = {"seed", "int", "float", "string", "text", "bool", "combo", "loras", "image", "bypass", "note"}
NOTE_PREFIX = "note:"  # node of a "note" field: a Note on the canvas, which never goes to ComfyUI
MAX_NOTE = 20000
MAX_DYNAMIC = 100000  # characters of a text input with dynamic prompts
SAVED_WITH_SHARE = 120  # seconds: a save this soon after sharing doesn't count as "changed on PC"
LORA_LOADER = "Power Lora Loader (rgthree)"
LORAS_INPUT = "loras"  # virtual input: stands for all lora_N inputs of a Power Lora Loader
ID_RE = re.compile(r"^[a-z0-9-]{1,80}$")
MAX_FIELDS = 300
BYPASS_KEY = "#bypass"  # in a workflow's values: ids of the nodes switched off on the phone
SWITCH_ONLY = "#bypass"  # input of a "bypass" field: a card with just the node's bypass switch
# errors= for writing the data files: half an emoji (a lone surrogate, which JSON allows) can't be UTF-8 and
# would fail the whole write; this writes it as the escape \udXXX, which JSON reads back the same.
HALF_CHARACTERS = "backslashreplace"


def replace_file(tmp, path):
    """os.replace, tried again for a moment: on Windows it fails while another program has the file open
    (a virus scanner or a backup, say). All data files of this node are written this way."""
    for wait in (0.05, 0.1, 0.2, 0.4, None):
        try:
            return os.replace(tmp, path)
        except PermissionError:
            if wait is None:
                raise
            time.sleep(wait)


def read_file(path):
    """path.read_text, tried again for a moment while another program holds the file (see replace_file). For
    files read once at start: failing there would start empty, and the next save would overwrite them."""
    for wait in (0.05, 0.1, 0.2, 0.4, None):
        try:
            return path.read_text(encoding="utf-8")
        except PermissionError:
            if wait is None:
                raise
            time.sleep(wait)


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _is_link(v):
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and _is_int(v[1])


def apply_bypass(prompt, record, node_ids):
    """Bypasses nodes the way ComfyUI does: each link from a bypassed node is replaced by what the node
    would hand through (worked out by the share dialog), or dropped when nothing fits."""
    removed = {n: prompt.pop(n) for n in node_ids if n in prompt}
    if not removed:
        return

    def resolve(link):
        for _ in range(len(removed) + 1):  # a chain of bypassed nodes, never a loop
            if not (_is_link(link) and link[0] in removed):
                return link if _is_link(link) else None
            names = (record.get("bypass") or {}).get(link[0]) or []
            name = names[link[1]] if link[1] < len(names) else None
            link = removed[link[0]]["inputs"].get(name) if name else None
        return None

    for node in prompt.values():
        for key, value in list(node["inputs"].items()):
            if _is_link(value) and value[0] in removed:
                new = resolve(value)
                if new is None:
                    del node["inputs"][key]
                else:
                    node["inputs"][key] = new


def field_key(field):
    # Node ids may contain ":" (subgraphs) but never "/", so this stays unambiguous.
    return f"{field['node']}/{field['input']}"


def slugify(name):
    """The id of a share, from its name. web/share.js slugify does the same."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:80].strip("-")
    if slug:
        return slug
    # No a-z or 0-9 in it ("Портрет", "風景"): a code from the name (FNV-1a over its UTF-8), so they stay apart.
    code = 0x811C9DC5
    for byte in name.encode("utf-8"):
        code = ((code ^ byte) * 0x01000193) & 0xFFFFFFFF
    return f"workflow-{code:08x}"


def is_valid_id(workflow_id):
    return bool(ID_RE.match(workflow_id))


def display_name(record):
    """The name set on the phone, else the one shared from the PC."""
    return record.get("phone_name") or record["name"]


def graph_id(record):
    """ComfyUI's id of the workflow on the PC (in its JSON), which an unsaved workflow has too."""
    workflow = record.get("workflow")
    gid = workflow.get("id") if isinstance(workflow, dict) else None
    return gid if isinstance(gid, str) and gid.strip("0-") else None  # never the all-zero placeholder


def same_workflow(old, new, user_dir=None):
    """Whether a share comes from the same workflow on the PC as an earlier one: the same saved file, else the
    same id (all unsaved workflows are called "Unsaved Workflow"). Another saved file is another workflow ("Save
    As" keeps the id), unless the old file is gone: then it was moved or renamed, and the id decides. A copy made
    on the phone (no source) never is. user_dir: ComfyUI's user folder, to look for the old file.
    web/share.js decides the same way (sameWorkflow)."""
    if not old.get("source"):
        return False
    if old.get("source_path") and new.get("source_path"):
        if old["source_path"] == new["source_path"]:
            return True
        try:
            moved = user_dir is not None and pc_file_state(old, user_dir).get("pc_missing", False)
        except OSError:
            moved = False
        if not moved:
            return False
    return graph_id(old) is not None and graph_id(old) == graph_id(new)


def share_recipe(record):
    """What it takes to make a shared workflow again, in the form a share comes from the PC dialog. A job keeps it,
    the phone keeps it with each image, and "Use again" sends it back once the workflow itself was deleted; then
    validate_share checks it like any share. Without the PC's drawing of the workflow: the original PNG has that."""
    choice = record.get("text_choice")
    return {"prompt": record["prompt"], "fields": record["fields"], "bypass": record.get("bypass") or {},
            "dynamic": {key: record["prompt"][key.split("/", 1)[0]]["inputs"][key.split("/", 1)[1]]
                        for key in record.get("dynamic", [])},
            "texts": {"order": choice["order"], "hidden": choice["hidden"]} if choice else None}


def validate_share(body):
    """Checks a share request from the PC dialog. Returns the cleaned record or raises ValueError."""
    if not isinstance(body, dict):
        raise ValueError("body must be an object")
    name = body.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        raise ValueError("name must be 1-120 characters")
    prompt = body.get("prompt")
    if not isinstance(prompt, dict) or not prompt:
        raise ValueError("prompt must be a non-empty object")
    for node_id, node in prompt.items():
        if not isinstance(node, dict) or not isinstance(node.get("class_type"), str) or not isinstance(node.get("inputs"), dict):
            raise ValueError(f"prompt node {node_id} is malformed")
    workflow = body.get("workflow")
    if workflow is not None and not isinstance(workflow, dict):
        raise ValueError("workflow must be an object")
    source = body.get("source") or ""  # workflow file name on the PC, to find this share again
    if not isinstance(source, str) or len(source) > 260:
        raise ValueError("source must be a file name")
    # The saved file, relative to ComfyUI's user folder ("workflows/x.json"), to tell when it changed.
    source_path = body.get("path") or None
    if source_path is not None and not (isinstance(source_path, str) and len(source_path) <= 500
                                        and source_path.startswith("workflows/") and source_path.endswith(".json")
                                        and ".." not in source_path.replace("\\", "/").split("/")):
        raise ValueError("path must be a workflow file")
    fields = body.get("fields")
    if not isinstance(fields, list) or len(fields) > MAX_FIELDS:
        raise ValueError(f"fields must be a list of at most {MAX_FIELDS}")

    clean, seen = [], set()
    for f in fields:
        if not isinstance(f, dict):
            raise ValueError("field must be an object")
        node, inp, kind, label = f.get("node"), f.get("input"), f.get("kind"), f.get("label")
        if kind not in KINDS:
            raise ValueError(f"unknown field kind {kind!r}")
        if not isinstance(label, str) or not label or len(label) > 200:
            raise ValueError("field label must be 1-200 characters")
        if kind == "note":
            # Shown and editable on the phone, kept with the workflow, never applied to it.
            text = f.get("text")
            if not (isinstance(node, str) and node.startswith(NOTE_PREFIX) and len(node) <= 100 and inp == "text"
                    and isinstance(text, str) and len(text) <= MAX_NOTE):
                raise ValueError("note field is malformed")
            if (node, inp) not in seen:
                seen.add((node, inp))
                clean.append({"node": node, "input": inp, "kind": kind, "label": label, "text": text})
            continue
        if node not in prompt:
            raise ValueError(f"field refers to unknown node {node!r}")
        if kind == "loras":
            if prompt[node]["class_type"] != LORA_LOADER or inp != LORAS_INPUT:
                raise ValueError(f"loras field must point to a {LORA_LOADER}")
        elif kind == "bypass":
            if inp != SWITCH_ONLY:
                raise ValueError(f"bypass field must use input {SWITCH_ONLY!r}")
        elif inp not in prompt[node]["inputs"]:
            raise ValueError(f"node {node} has no input {inp!r}")
        if (node, inp) in seen:
            continue
        seen.add((node, inp))
        clean.append({"node": node, "input": inp, "kind": kind, "label": label})

    # Nodes the phone may bypass: for each output, the input it hands through when bypassed (None = dropped).
    bypass = body.get("bypass") or {}
    if not isinstance(bypass, dict) or len(bypass) > MAX_FIELDS:
        raise ValueError("bypass must be an object")
    # Nodes bypassed on the PC that come to the phone: ComfyUI's export leaves them out, so the dialog adds them,
    # each with what its outputs hand through. With a field they get a switch, starting off; any others are
    # bypassed below, as on the PC (the dialog sends none: ComfyUI bypasses those itself).
    pc_bypassed = body.get("pc_bypassed") or {}
    if not (isinstance(pc_bypassed, dict) and len(pc_bypassed) <= MAX_FIELDS
            and all(n in prompt and isinstance(o, list) and len(o) <= 64 for n, o in pc_bypassed.items())):
        raise ValueError("pc_bypassed must name nodes of the workflow")
    pc_bypassed = {n: [o if isinstance(o, str) and o in prompt[n]["inputs"] else None for o in outputs]
                   for n, outputs in pc_bypassed.items()}
    shared_nodes = {f["node"] for f in clean}
    bypass = {**{n: o for n, o in pc_bypassed.items() if n in shared_nodes}, **bypass}
    clean_bypass = {}
    for node, outputs in bypass.items():
        if node not in shared_nodes:
            continue  # no field on the phone to switch it with
        if not isinstance(outputs, list) or len(outputs) > 64:
            raise ValueError(f"bypass info for node {node} is malformed")
        inputs = prompt[node]["inputs"]
        clean_bypass[node] = [o if isinstance(o, str) and o in inputs else None for o in outputs]

    # A switch-only card without bypass info would do nothing.
    clean = [f for f in clean if f["kind"] != "bypass" or f["node"] in clean_bypass]
    # Text inputs with ComfyUI's dynamic prompts ({a|b}, comments). The PC's UI already rolled them once for
    # the share, so the dialog sends what was typed; it goes back into the prompt and is rolled per image.
    dynamic = body.get("dynamic") or {}
    if not isinstance(dynamic, dict) or len(dynamic) > MAX_FIELDS:
        raise ValueError("dynamic must be an object")
    for key, text in dynamic.items():
        node, _, inp = key.partition("/") if isinstance(key, str) else ("", "", "")
        if not (node in prompt and isinstance(prompt[node]["inputs"].get(inp), str)
                and isinstance(text, str) and len(text) <= MAX_DYNAMIC):
            raise ValueError(f"dynamic prompt {key!r} is malformed")
        prompt[node]["inputs"][inp] = text
    # Text nodes (Preview as Text) on the phone: "order" as ticked, "hidden" unticked. Nodes the dialog didn't
    # recognise are in neither and come last. None (older shares): every text, as before.
    texts = body.get("texts")
    text_choice = None
    if texts is not None:
        lists = [texts.get(k, []) for k in ("order", "hidden")] if isinstance(texts, dict) else [None]
        if not all(isinstance(ids, list) and len(ids) <= MAX_FIELDS and all(isinstance(n, str) and n in prompt for n in ids)
                   for ids in lists):
            raise ValueError("texts must list nodes of the workflow")
        text_choice = {"order": list(dict.fromkeys(lists[0])), "hidden": sorted(set(lists[1]) - set(lists[0]))}
    pc_off = [n for n in pc_bypassed if n in clean_bypass]  # switches that are off on the PC
    dropped = [n for n in pc_bypassed if n not in clean_bypass]
    apply_bypass(prompt, {"bypass": pc_bypassed}, dropped)
    if text_choice:
        text_choice = {k: [n for n in ids if n in prompt] for k, ids in text_choice.items()}
    return {"name": name.strip(), "source": source, "source_path": source_path, "prompt": prompt, "workflow": workflow,
            "fields": clean, "bypass": clean_bypass, "dynamic": sorted(k for k in dynamic if k.split("/", 1)[0] in prompt),
            "text_choice": text_choice, "pc_off": pc_off}


def pc_values(record):
    """The values of a share as it came from the PC: none of the phone's, its switches as on the PC."""
    return {BYPASS_KEY: record["pc_off"]} if record.get("pc_off") else {}


def pc_file_state(item, user_dir):
    """How the PC's file behind a share stands now: {"pc_changed": time} if it was saved after sharing,
    {"pc_missing": True} if its known path is gone, else {} (unchanged, or not known for sure).
    user_dir: ComfyUI's folder of the user ("user/default"), holding "workflows/"."""
    base = (Path(user_dir) / "workflows").resolve()
    if item.get("source_path"):
        file = (Path(user_dir) / item["source_path"]).resolve()
        if not file.is_relative_to(base):
            return {}
        if not file.is_file():
            return {"pc_missing": True}
    elif item.get("source"):
        # Shares from before the path was kept: by name, and only when that name is unique.
        matches = [p for p in base.rglob("*.json") if p.stem == item["source"]] if base.is_dir() else []
        if len(matches) != 1:
            return {}
        file = matches[0]
    else:
        return {}  # a copy made on the phone, or a share without a saved file
    changed = file.stat().st_mtime
    # Saving right after sharing (share, then Ctrl+S) is part of the same step, not a change since.
    return {"pc_changed": changed} if changed > item["shared_at"] + SAVED_WITH_SHARE else {}


def merge_order(old_fields, new_fields):
    """Keeps the phone's field order for fields that are shared again; new fields go to the end."""
    new_by_key = {field_key(f): f for f in new_fields}
    merged = [new_by_key.pop(field_key(f)) for f in old_fields if field_key(f) in new_by_key]
    return merged + [f for f in new_fields if field_key(f) in new_by_key]


class WorkflowStore:
    def __init__(self, directory):
        self.dir = Path(directory)
        self.order_path = self.dir.parent / "workflow-order.json"  # outside the folder of workflow files

    def _path(self, workflow_id):
        if not is_valid_id(workflow_id):
            raise KeyError(workflow_id)
        return self.dir / f"{workflow_id}.json"

    def get(self, workflow_id):
        try:
            return json.loads(self._path(workflow_id).read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise KeyError(workflow_id)

    def list(self):
        if not self.dir.is_dir():
            return []
        items = []
        for path in self.dir.glob("*.json"):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue  # skip a broken file instead of failing the whole list
            # "name" stays the PC's name: the share dialog uses it to update the same workflow.
            items.append({"id": record["id"], "name": record["name"], "phone_name": record.get("phone_name"),
                          "source": record.get("source", ""), "source_path": record.get("source_path"),
                          "graph_id": graph_id(record), "shared_at": record["shared_at"], "field_count": len(record["fields"])})
        try:
            order = json.loads(self.order_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            order = []
        rank = {workflow_id: i for i, workflow_id in enumerate(order)}
        # The order set on the phone; workflows shared since then follow, by name.
        return sorted(items, key=lambda r: (rank.get(r["id"], len(rank)), display_name(r).lower()))

    def set_list_order(self, ids):
        if not isinstance(ids, list) or len(ids) > 1000 or not all(isinstance(i, str) and is_valid_id(i) for i in ids):
            raise ValueError("order must be a list of workflow ids")
        self.dir.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.order_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(ids), encoding="utf-8")
        replace_file(tmp, self.order_path)

    def save_share(self, cleaned, user_dir=None):
        """Stores a validated share; sharing the same name again updates it and keeps the field order.
        user_dir: ComfyUI's user folder, to recognise a moved workflow file (same_workflow)."""
        workflow_id = slugify(cleaned["name"])
        try:
            old = self.get(workflow_id)
        except KeyError:
            old = None
        record = dict(cleaned, id=workflow_id, shared_at=time.time(), values=pc_values(cleaned))
        # Only the same workflow updates its share. Another one under the same name replaces it and starts
        # fresh: the old one's phone values could land in fields of a different workflow otherwise.
        if old and same_workflow(old, cleaned, user_dir):
            record["fields"] = merge_order(old["fields"], cleaned["fields"])
            # Values typed on the phone survive a re-share for every field that is still shared.
            keys = {field_key(f) for f in record["fields"]}
            record["values"] = {k: v for k, v in old.get("values", {}).items() if k in keys}
            # Switches like fields: one changed on the phone keeps the phone's state; one left as the PC had it
            # (shares from before "pc_off": every node ran on the PC) and a new one follow the PC now.
            was_off = set(old.get("values", {}).get(BYPASS_KEY, []))
            pc_was_off = set(old.get("pc_off", []))
            old_switches = old.get("bypass") or {}
            off = []
            for n in record["bypass"]:
                changed_on_phone = n in old_switches and (n in was_off) != (n in pc_was_off)
                if (n in was_off) if changed_on_phone else (n in record.get("pc_off", [])):
                    off.append(n)
            if off:
                record["values"][BYPASS_KEY] = off
            if old.get("phone_name"):
                record["phone_name"] = old["phone_name"]
        self._write(workflow_id, record)
        return record

    def set_values(self, workflow_id, values):
        """Stores the phone's values (already validated). Never touches the workflow on the PC."""
        record = self.get(workflow_id)
        record["values"] = values
        self._write(workflow_id, record)

    def merge_values(self, workflow_id, values):
        """Stores the fields the phone changed (validated) over the ones kept: what the phone didn't send
        stays, even if the phone showed an older copy (opened offline). Returns all values now kept."""
        record = self.get(workflow_id)
        record["values"] = {**record.get("values", {}), **values}
        self._write(workflow_id, record)
        return record["values"]

    def rename(self, workflow_id, name):
        """Sets the name shown on the phone; None (or the PC's name) goes back to the PC's name."""
        if name is not None and (not isinstance(name, str) or not name.strip() or len(name) > 120):
            raise ValueError("name must be 1-120 characters")
        record = self.get(workflow_id)
        name = name.strip() if name else None
        if name and name != record["name"]:
            record["phone_name"] = name
        else:
            record.pop("phone_name", None)
        self._write(workflow_id, record)

    def set_order(self, workflow_id, keys):
        record = self.get(workflow_id)
        by_key = {field_key(f): f for f in record["fields"]}
        if not isinstance(keys, list) or sorted(keys) != sorted(by_key):
            raise ValueError("order must list every shared field exactly once")
        record["fields"] = [by_key[k] for k in keys]
        self._write(workflow_id, record)

    def copy(self, workflow_id, name, values, record=None):
        """A new workflow from an existing one with other values ("Use again" on an image). It has no
        file on the PC behind it, so sharing from the PC never updates or removes it.
        record: the workflow made again from an image's recipe (validated), when workflow_id is gone."""
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise ValueError("name must be 1-120 characters")
        record = record or self.get(workflow_id)
        base = slugify(name)[:70].strip("-") or "workflow"
        new_id = f"{base}-{secrets.token_hex(2)}"
        while self._path(new_id).exists():
            new_id = f"{base}-{secrets.token_hex(2)}"
        copy = dict(record, id=new_id, name=name.strip(), source="", source_path=None, shared_at=time.time(),
                    values=values, copy_of=workflow_id)
        copy.pop("phone_name", None)
        self._write(new_id, copy)
        try:
            order = json.loads(self.order_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            order = []  # no order set yet: sorted by name, which puts it below the original anyway
        if workflow_id in order:
            order.insert(order.index(workflow_id) + 1, new_id)  # right below the original
            self.set_list_order(order)
        elif workflow_id not in {r["id"] for r in self.list()}:
            # Made again from a recipe: no original to stand by, so at the very end, where it's easy to find.
            self.set_list_order([r["id"] for r in self.list() if r["id"] != new_id] + [new_id])
        return copy

    def delete(self, workflow_id):
        try:
            self._path(workflow_id).unlink()
        except FileNotFoundError:
            raise KeyError(workflow_id)

    def _write(self, workflow_id, record):
        self.dir.mkdir(parents=True, exist_ok=True)
        path = self._path(workflow_id)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8", errors=HALF_CHARACTERS)
        replace_file(tmp, path)  # atomic, so a crash never leaves a half-written workflow

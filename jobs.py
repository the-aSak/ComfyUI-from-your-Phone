"""Phone jobs: turn a shared workflow plus the phone's values into ComfyUI prompts and run them one by one."""
import asyncio
import copy
import json
import logging
import math
import os
import re
import statistics
import struct
import time
import uuid
from pathlib import Path

try:
    from .workflows import BYPASS_KEY, HALF_CHARACTERS, field_key, read_file, replace_file, share_recipe
except ImportError:  # loaded standalone by the tests
    from workflows import BYPASS_KEY, HALF_CHARACTERS, field_key, read_file, replace_file, share_recipe

SEED_MAX = 2**50  # inside every seed widget's range (rgthree allows ±2^50) and exact in JavaScript
MAX_TEXT = 50_000
MAX_MASK = 4_000_000  # PNG data URL of a painted mask
MASK_PREFIX = "data:image/png;base64,"
MAX_COUNT = 100
MAX_JOBS = 100
LORA_KEY = re.compile(r"^lora_\d+$")
FINISHED = ("done", "error", "cancelled")
# Bulky, not needed by the often-polled job list. "values" can hold painted masks (MBs); the gallery and
# "Use again" get them once per job from get().
HIDDEN = ("base", "workflow", "details", "values", "recipe")
log = logging.getLogger("comfy-phone")


def _is_number(v):
    # Not Infinity or NaN: Python's json reads them, but the browser can't, so the workflow wouldn't open again.
    return _is_int(v) or (isinstance(v, float) and math.isfinite(v))


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _safe_input_name(name):
    """A file in ComfyUI's input folder, given relative to it (no way out of the folder)."""
    if not isinstance(name, str) or not 0 < len(name) <= 500:
        return False
    return ":" not in name and not name.startswith(("/", "\\")) and ".." not in name.replace("\\", "/").split("/")


def _valid(kind, v):
    if kind == "image":
        # A file name, or {"image": name, "mask": PNG data URL | "" (no mask) | None (keep the PC's mask)}
        if isinstance(v, dict):
            mask = v.get("mask")
            return set(v) <= {"image", "mask"} and isinstance(v.get("image"), str) and _safe_input_name(v["image"]) \
                and (mask is None or mask == "" or (isinstance(mask, str) and mask.startswith(MASK_PREFIX) and len(mask) <= MAX_MASK))
        return isinstance(v, str) and _safe_input_name(v)
    if kind in ("text", "string", "combo", "note"):
        return isinstance(v, str) and len(v) <= MAX_TEXT
    if kind == "int":
        return _is_int(v)
    if kind == "float":
        return _is_number(v)
    if kind == "bool":
        return isinstance(v, bool)
    if kind == "seed":
        return isinstance(v, dict) and v.get("mode") in ("random", "fixed") and _is_int(v.get("value"))
    if kind == "loras":
        return isinstance(v, list) and len(v) <= 200 and all(
            isinstance(l, dict) and isinstance(l.get("on"), bool) and isinstance(l.get("lora"), str)
            and len(l["lora"]) <= 500 and _is_number(l.get("strength")) for l in v)
    return False


def validate_values(record, values):
    """Checks values sent by the phone against the shared fields. Unknown keys are dropped."""
    if not isinstance(values, dict):
        raise ValueError("values must be an object")
    fields = {field_key(f): f for f in record["fields"]}
    clean = {}
    for key, value in values.items():
        if key == BYPASS_KEY:
            if not isinstance(value, list):
                raise ValueError("bypass must be a list of node ids")
            allowed = record.get("bypass") or {}
            # Kept also when empty: the phone sends its whole list, and [] (all on again) must replace what the
            # PC kept when it merges (workflows.merge_values).
            clean[key] = [n for n in dict.fromkeys(v for v in value if isinstance(v, str)) if n in allowed]
            continue
        field = fields.get(key)
        if field is None:
            continue  # field no longer shared (re-shared on the PC meanwhile)
        if not _valid(field["kind"], value):
            raise ValueError(f"invalid value for {field['label']}")
        clean[key] = value
    return clean


def apply_loras(inputs, loras):
    for key in [k for k in inputs if LORA_KEY.match(k)]:
        del inputs[key]
    for i, lora in enumerate(loras, 1):
        # strengthTwo None = clip strength follows model strength (the phone edits one strength)
        inputs[f"lora_{i}"] = {"on": lora["on"], "lora": lora["lora"], "strength": lora["strength"], "strengthTwo": None}


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


def apply_values(record, values):
    """The workflow's prompt with the phone's values filled in (seeds are set per run)."""
    base = copy.deepcopy(record["prompt"])
    for field in record["fields"]:
        key = field_key(field)
        if field["kind"] in ("seed", "note") or key not in values:
            continue
        inputs = base[field["node"]]["inputs"]
        if field["kind"] == "loras":
            apply_loras(inputs, values[key])
        elif field["kind"] == "image" and isinstance(values[key], dict):
            inputs[field["input"]] = values[key]["image"]
            if values[key].get("mask") is not None and "mask_data" in inputs:  # TrixLoadImageAIO
                inputs["mask_data"] = values[key]["mask"]
        else:
            inputs[field["input"]] = values[key]
    apply_bypass(base, record, values.get(BYPASS_KEY, []))
    return base


def image_inputs(record, base):
    """(label, file name) of every shared image field whose node runs (not bypassed)."""
    return [(f["label"], base[f["node"]]["inputs"][f["input"]]) for f in record["fields"]
            if f["kind"] == "image" and f["node"] in base and isinstance(base[f["node"]]["inputs"].get(f["input"]), str)]


def alpha_masks(record, values, base):
    """(node, input, picture, mask) of every shared Load Image field with a mask set on the phone
    ("" = none). Load Image reads its mask from the picture's transparency, so these need a copy of
    the picture carrying that mask (made by the server)."""
    found = []
    for f in record["fields"]:
        v = values.get(field_key(f))
        if (f["kind"] == "image" and isinstance(v, dict) and v.get("mask") is not None
                and base.get(f["node"], {}).get("class_type") == "LoadImage"):
            found.append((f["node"], f["input"], v["image"], v["mask"]))
    return found


def job_details(record, base):
    """Label and value of every shared field, shown under the image in the gallery."""
    details = []
    for field in record["fields"]:
        if field["kind"] == "note":
            continue  # not part of the workflow
        if field["node"] not in base or field["kind"] == "bypass":
            off = field["node"] not in base
            details.append({"key": field_key(field), "label": field["label"], "kind": "text",
                            "value": "Bypassed" if off else "On", "bypassed": off})
            continue
        inputs = base[field["node"]]["inputs"]
        if field["kind"] == "loras":
            value = [{"on": v.get("on", True), "lora": v.get("lora"), "strength": v.get("strength")}
                     for k, v in inputs.items() if LORA_KEY.match(k) and isinstance(v, dict)]
        else:
            value = inputs.get(field["input"])
        details.append({"key": field_key(field), "label": field["label"], "kind": field["kind"], "value": value})
    return details


def dynamic_prompt(text, rng):
    """ComfyUI's dynamic prompts, as its own UI applies them before queueing (processDynamicPrompt in the
    frontend): // and /* */ comments go, {a|b|c} becomes one of the options (nested allowed), \\{ \\} \\| stay."""
    text = re.sub(r"/\*[\s\S]*?\*/|//.*", "", text)
    i = 0

    def escaped():
        nonlocal i
        kept = "\\" + text[i:i + 1]  # the backslash stays for now; only \{ \} \| lose it at the end
        i += 1
        return kept

    def choice():
        nonlocal i
        options, current, depth = [], "", 0
        while i < len(text):
            c = text[i]
            i += 1
            if c == "\\":
                current += escaped()
                continue
            if c == "{":
                depth += 1
            elif c == "}":
                if not depth:
                    break
                depth -= 1
            elif c == "|" and not depth:
                options.append(current)
                current = ""
                continue
            current += c
        options.append(current)
        return dynamic_prompt(rng.choice(options), rng)

    out = []
    while i < len(text):
        c = text[i]
        i += 1
        out.append(escaped() if c == "\\" else choice() if c == "{" else c)
    return re.sub(r"\\([{}|])", r"\1", "".join(out))


def seed_range(class_type, name):
    """The random seeds a node's input takes, (low, high): ComfyUI refuses a number above an input's max, and
    many nodes stop at 2^31 or 2^32 (API nodes, Ollama). Never beyond 0..SEED_MAX; all of that when the node
    isn't known, and outside ComfyUI (the tests)."""
    try:
        import nodes  # ComfyUI's node registry, in the same process as this custom node
        spec = nodes.NODE_CLASS_MAPPINGS[class_type].INPUT_TYPES()
        opts = {**spec.get("required", {}), **spec.get("optional", {})}[name][1]
        low, high = max(0, int(opts.get("min", 0))), min(SEED_MAX - 1, int(opts.get("max", SEED_MAX)))
        if low <= high:
            return low, high
    except Exception:
        pass  # no such node or input, or no limits given
    return 0, SEED_MAX - 1


def build_job(record, values, count, rng):
    """Returns a job: one base prompt with the phone's values applied, plus one run per image with its seeds
    and its own pick of every dynamic prompt ({a|b}), so each image of a series can differ."""
    if not _is_int(count) or not 1 <= count <= MAX_COUNT:
        raise ValueError(f"count must be 1-{MAX_COUNT}")
    values = validate_values(record, values)
    base = apply_values(record, values)
    seed_fields = [(field_key(f), values.get(field_key(f), {"mode": "random", "value": 0}),
                    seed_range(base.get(f["node"], {}).get("class_type"), f["input"]))
                   for f in record["fields"] if f["kind"] == "seed"]

    runs = []
    for index in range(count):
        seeds = {}
        for key, seed, (low, high) in seed_fields:
            fixed = seed["mode"] == "fixed" and seed["value"] >= 0  # -1 means random (rgthree convention)
            seeds[key] = seed["value"] if fixed else rng.randrange(low, high + 1)
        picks = {}  # input -> the text it gets this time, where that differs from what was typed
        for key in record.get("dynamic", []):
            node, inp = key.split("/", 1)
            text = base.get(node, {}).get("inputs", {}).get(inp)  # not there: bypassed
            if isinstance(text, str) and (picked := dynamic_prompt(text, rng)) != text:
                picks[key] = picked
        runs.append({"index": index, "status": "queued", "seeds": seeds, "dynamic": picks, "outputs": [],
                     "error": None, "prompt_id": None, "started": None, "finished": None})
    return {"id": uuid.uuid4().hex[:12], "workflow_id": record["id"], "name": record.get("phone_name") or record["name"],
            "created": time.time(), "count": count, "values": values, "base": base, "text_choice": record.get("text_choice"),
            "workflow": record.get("workflow"), "details": job_details(record, base), "runs": runs,
            "recipe": share_recipe(record)}  # kept after the end (a few KB): images carry it to the phone


def run_prompt(job, run):
    prompt = copy.deepcopy(job["base"])
    for key, value in {**run["seeds"], **run.get("dynamic", {})}.items():
        node, inp = key.split("/", 1)
        if node in prompt:  # not bypassed
            prompt[node]["inputs"][inp] = value
    return prompt


def describe_rejection(body, default="Prompt rejected"):
    """Short message for node errors from /prompt (a 400, or a 200 where some outputs were dropped)."""
    body = body if isinstance(body, dict) else {}
    error = body.get("error")
    parts = [error.get("message", default) if isinstance(error, dict) else str(error or default)]
    for node_id, node_error in (body.get("node_errors") or {}).items():
        for err in node_error.get("errors", [])[:2]:
            text = f"{node_error.get('class_type', node_id)}: {err.get('message', '')} {err.get('details', '')}".strip()
            parts.append(text if len(text) <= 160 else text[:159] + "…")  # details can list every model
    return " · ".join(parts)


def describe_failure(status):
    """Short message for a prompt that failed while running (from /history)."""
    for kind, data in status.get("messages", []):
        if kind == "execution_error":
            return f"{data.get('node_type', 'Node')}: {data.get('exception_message', 'error')}".strip()
        if kind == "execution_interrupted":
            return "Interrupted"
    return "Failed"


VIDEO_SUFFIXES = (".mp4", ".webm", ".mov", ".mkv")


def unsaved_counts(entry):
    """What nodes only previewed (Preview Image, Preview Audio: type "temp", gone after the run), as
    {"image": 2, "audio": 1}; empty when nothing was previewed (a text-only workflow, say). The Tasks card
    adds these up over the job's images: "Not saved: 3 images. Add a Save Image node to keep them."."""
    counts = {}
    for out in entry.get("outputs", {}).values():
        if not isinstance(out, dict):
            continue
        for key in ("images", "gifs", "audio"):
            for item in out.get(key) or []:
                if not (isinstance(item, dict) and item.get("type") == "temp"):
                    continue
                name = str(item.get("filename", "")).lower()
                kind = "audio" if key == "audio" else "video" if key == "gifs" or name.endswith(VIDEO_SUFFIXES) else "image"
                counts[kind] = counts.get(kind, 0) + 1
    return counts


def collect_outputs(entry):
    """Saved images, videos and audio of a finished prompt. Previews have type "temp" and are skipped.
    ComfyUI's SaveVideo reports videos under "images"; Video Helper Suite's Video Combine under "gifs";
    ComfyUI's Save Audio (FLAC, MP3, Opus) under "audio".
    "again": the node came from ComfyUI's cache (all settings as in an earlier run), so the file is one saved
    before, not a new one; the gallery keeps one copy of it."""
    cached = set()
    for msg in (entry.get("status") or {}).get("messages") or []:
        if isinstance(msg, list) and len(msg) == 2 and msg[0] == "execution_cached" and isinstance(msg[1], dict):
            cached.update(str(n) for n in msg[1].get("nodes") or [])
    return [{"filename": img["filename"], "subfolder": img.get("subfolder", ""), "type": "output",
             **({"again": True} if node in cached else {})}
            for node, out in entry.get("outputs", {}).items() if isinstance(out, dict)
            for key in ("images", "gifs", "audio") if isinstance(out.get(key), list)  # a node may report None
            for img in out[key]
            if isinstance(img, dict) and img.get("type") == "output" and img.get("filename")]


TEXT_LIMIT = 24576  # characters per text (16k + 8k tokens of an LLM fit), so a runaway node doesn't bloat the job list
PEEK = 160  # characters of each text shown on a Tasks card of a text-only result


def is_output_node(class_type):
    """ComfyUI's own word on whether a node class is an output node (Preview as Text, Show Text, Display
    Int: they must be, or ComfyUI wouldn't run them). True when unknown, and outside ComfyUI (the tests)."""
    try:
        import nodes  # ComfyUI's node registry, in the same process as this custom node
    except ImportError:
        return True
    cls = nodes.NODE_CLASS_MAPPINGS.get(class_type)
    return cls is None or bool(getattr(cls, "OUTPUT_NODE", False))


def collect_texts(outputs, base, choice=None):
    """What nodes like "Preview as Text" or "Show Text" display: [{node, label, text}], labelled with the
    node's title. outputs: node id -> its UI output (from the history, or live from the websocket).
    choice: the share's {"order", "hidden"} text nodes; others keep their place after the ordered ones."""
    texts = []
    for node, out in outputs.items():
        parts = out.get("text") if isinstance(out, dict) else None
        if not isinstance(parts, list):
            continue
        text = "\n".join(p if isinstance(p, str) else json.dumps(p, ensure_ascii=False) for p in parts).strip()
        if not text:
            continue
        spec = base.get(node, {})
        if spec.get("class_type") and not is_output_node(spec["class_type"]):
            continue  # a working node that shows its status on the canvas (H3 Sparse Attention, say)
        label = spec.get("_meta", {}).get("title") or spec.get("class_type") or "Text"
        texts.append({"node": node, "label": label, "text": text[:TEXT_LIMIT]})
    if choice:
        hidden, rank = set(choice.get("hidden", ())), {n: i for i, n in enumerate(choice.get("order", ()))}
        texts = sorted((t for t in texts if t["node"] not in hidden), key=lambda t: rank.get(t["node"], len(rank)))
    return texts


def is_finished(job):
    return all(r["status"] in FINISHED for r in job["runs"])


def typical_durations(jobs, last=5):
    """Median seconds per image of each workflow, from its most recent finished runs."""
    runs = {}
    for job in jobs:
        for run in job["runs"]:
            if run["status"] == "done" and run["started"] and run["finished"]:
                runs.setdefault(job["workflow_id"], []).append((run["finished"], run["finished"] - run["started"]))
    return {wf: statistics.median(d for _, d in sorted(items)[-last:]) for wf, items in runs.items()}


def estimate(jobs, now):
    """Seconds until each unfinished job is done. The running image comes first, then the queue in order.
    None while paused, or when a workflow ahead of it has never finished a run (nothing to estimate from)."""
    typical = typical_durations(jobs)
    total, known = 0.0, True
    for job in jobs:
        for run in job["runs"]:
            if run["status"] == "running":
                avg = typical.get(job["workflow_id"])
                known = known and avg is not None
                total += max((avg or 0) - (now - run["started"]), 0)
    eta = {}
    for job in jobs:
        if is_finished(job):
            continue
        paused = job.get("paused")
        avg = typical.get(job["workflow_id"])
        for run in job["runs"]:
            if run["status"] == "queued" and not paused:
                known = known and avg is not None
                total += avg or 0
        eta[job["id"]] = None if paused or not known else round(total)
    return eta


class Cancelled(Exception):
    """The job was cancelled from the phone while this run was in ComfyUI."""


class PromptRejected(Exception):
    """ComfyUI refused the prompt; every remaining run of the job would fail the same way."""


class JobQueue:
    def __init__(self, path, base_url, client_id="comfy-phone"):
        self.path = Path(path)
        self.base_url = base_url
        self.client_id = client_id
        self.jobs = self._load()
        self.progress = {}  # prompt_id -> {"value", "max"} of the running node, from ComfyUI's websocket
        self.previews = {}  # prompt_id -> {"mime", "data", "version"}: the latest live preview
        self.shown = {}  # prompt_id -> {node: UI output}: what nodes showed so far (for texts while it runs)
        self._running = None  # prompt_id of the image generating now
        self._task = None
        self.on_finished = None  # called with a job when its last image is done (not when cancelled)

    def _load(self):
        try:
            jobs = json.loads(read_file(self.path))
        except FileNotFoundError:
            return []
        except (OSError, ValueError):
            # Set aside rather than overwritten by the next save: the history can still be read from it.
            broken = self.path.with_name(f"{self.path.stem}.broken-{time.strftime('%Y%m%d-%H%M%S')}.json")
            log.exception("[phone] could not read %s, starting with an empty job list (kept as %s)", self.path, broken.name)
            try:
                os.replace(self.path, broken)
            except OSError:
                pass
            return []
        for job in jobs:
            for run in job["runs"]:
                if run["status"] in ("queued", "running"):
                    # shortcut: unfinished runs are dropped on restart, resume them if that turns out to matter
                    run.update(status="error", error="Interrupted (ComfyUI restarted)")
        return jobs

    def _save(self):
        # The oldest finished jobs go, so the newest MAX_JOBS finished stay (also one that just finished, which the
        # phone hasn't copied yet); unfinished ones (paused, say) stay however many and however old.
        finished = [j for j in self.jobs if is_finished(j)]
        for job in finished[:max(0, len(finished) - MAX_JOBS)]:
            self.jobs.remove(job)
        for job in self.jobs:
            if is_finished(job):
                job.pop("base", None)  # only needed to run it; keeps the file small
                job.pop("workflow", None)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(self.jobs, ensure_ascii=False), encoding="utf-8", errors=HALF_CHARACTERS)
            replace_file(tmp, self.path)
        except OSError:
            # The jobs go on: they're in memory, and the next save writes them. Stopping here would leave
            # the rest of the queue waiting, or a running image without its job.
            log.exception("[phone] could not save %s, trying again with the next change", self.path)

    def public(self):
        """Jobs for the phone, newest first, with progress and the estimated time left. Texts only for the
        image generating now (the list is polled often); finished ones come with get()."""
        eta = estimate(self.jobs, time.time())
        def slim(run):
            out = {k: v for k, v in run.items() if k not in ("texts", "dynamic")}  # long texts: get()
            if run.get("texts") and not run.get("outputs"):  # text only (an LLM, say): the card shows its start
                out["peek"] = [{"label": t["label"], "text": t["text"][:PEEK]} for t in run["texts"]]
            return out
        return [dict({k: v for k, v in job.items() if k not in HIDDEN}, eta=eta.get(job["id"]), runs=[
            dict(slim(run), progress=self.progress.get(run["prompt_id"]),
                 preview=self.previews.get(run["prompt_id"], {}).get("version"),
                 texts=collect_texts(self.shown.get(run["prompt_id"], {}), job.get("base", {}), job.get("text_choice")))
            if run["status"] == "running" else slim(run)
            for run in job["runs"]]) for job in reversed(self.jobs)]

    def preview(self, job_id):
        """The latest live preview of the job's generating image, or None."""
        job = self._find(job_id)
        running = next((r for r in job["runs"] if r["status"] == "running"), None)
        return running and self.previews.get(running["prompt_id"])

    def take_preview(self, data):
        """Keeps a live preview from ComfyUI's websocket: [event][image type][image], or with
        metadata [4][length][json][image]. Without metadata it belongs to our running image."""
        if len(data) < 8 or self._running is None:
            return
        event, second = struct.unpack(">II", data[:8])
        if event == 1:  # PREVIEW_IMAGE; second = 1 JPEG, 2 PNG
            mime, image, prompt_id = ("image/png" if second == 2 else "image/jpeg"), data[8:], self._running
        elif event == 4:  # PREVIEW_IMAGE_WITH_METADATA; second = length of the json
            meta = json.loads(data[8:8 + second])
            mime, image, prompt_id = meta.get("image_type", "image/jpeg"), data[8 + second:], meta.get("prompt_id")
        else:
            return
        if prompt_id != self._running:
            return
        old = self.previews.get(prompt_id)
        self.previews[prompt_id] = {"mime": mime, "data": bytes(image), "version": old["version"] + 1 if old else 1}

    def get(self, job_id):
        """One job with its details, for the gallery."""
        job = next((j for j in self.jobs if j["id"] == job_id), None)
        return job and {k: v for k, v in job.items() if k not in ("base", "workflow")}

    def _find(self, job_id):
        for job in self.jobs:
            if job["id"] == job_id:
                return job
        raise KeyError(job_id)

    def add(self, job):
        self.jobs.append(job)
        self._save()
        self._kick()

    def pause(self, job_id, paused):
        """A paused job starts no new images; an image that is already running finishes."""
        job = self._find(job_id)
        if is_finished(job):
            raise ValueError("this job has already finished")
        job["paused"] = paused
        self._save()
        if not paused:
            self._kick()

    def cancel(self, job_id):
        job = self._find(job_id)
        job["cancelled"] = True  # the worker stops a running image within a second
        for run in job["runs"]:
            if run["status"] == "queued":
                run.update(status="cancelled", finished=time.time())
        self._save()

    def skip(self, job_id):
        """Stops only the image that is generating; the job goes on with its next one."""
        job = self._find(job_id)
        running = next((r for r in job["runs"] if r["status"] == "running"), None)
        if running is None:
            raise ValueError("no image of this job is generating")
        running["skip"] = True  # the worker stops it within a second
        self._save()

    def move(self, job_id, by):
        """Moves an unfinished job by one place among the unfinished ones (-1 = runs earlier)."""
        job = self._find(job_id)
        waiting = [j for j in self.jobs if not is_finished(j)]
        if job not in waiting:
            raise ValueError("this job has already finished")
        target = waiting.index(job) + by
        if 0 <= target < len(waiting):
            a, b = self.jobs.index(job), self.jobs.index(waiting[target])
            self.jobs[a], self.jobs[b] = self.jobs[b], self.jobs[a]
            self._save()

    def remove(self, job_id=None):
        """Removes one finished job from the list, or all of them. Images stay on the PC and the phone."""
        if job_id is None:
            self.jobs = [j for j in self.jobs if not is_finished(j)]
        else:
            job = self._find(job_id)
            if not is_finished(job):
                raise ValueError("cancel the job before removing it")
            self.jobs.remove(job)
        self._save()

    def _kick(self):
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(self._worker())

    def _next(self):
        for job in self.jobs:
            if job.get("paused"):
                continue
            for run in job["runs"]:
                if run["status"] == "queued":
                    return job, run
        return None

    async def _worker(self):
        import aiohttp
        async with aiohttp.ClientSession(self.base_url) as session:
            listener = asyncio.create_task(self._listen(session))
            try:
                while (item := self._next()) is not None:
                    await self._run_one(session, *item)
            finally:
                listener.cancel()

    async def _run_one(self, session, job, run):
        try:
            await self._execute(session, job, run)
        except Cancelled:
            run["status"] = "cancelled"
        except PromptRejected as exc:
            for other in job["runs"]:
                if other["status"] in ("queued", "running"):
                    other.update(status="error", error=str(exc), finished=time.time())
        except Exception as exc:
            log.exception("[phone] run %s/%s failed", job["id"], run["index"])
            run.update(status="error", error=str(exc) or type(exc).__name__)
        run["finished"] = run["finished"] or time.time()
        self.progress.pop(run["prompt_id"], None)
        self.previews.pop(run["prompt_id"], None)
        self.shown.pop(run["prompt_id"], None)
        self._running = None
        self._save()
        if self.on_finished and is_finished(job) and not job.get("cancelled"):
            try:
                self.on_finished(job)
            except Exception:
                log.exception("[phone] after job %s", job["id"])

    async def _listen(self, session):
        """Keeps the step progress of our prompts up to date (ComfyUI only sends it over its websocket)."""
        import aiohttp
        while True:
            try:
                async with session.ws_connect(f"/ws?clientId={self.client_id}") as ws:
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.BINARY:
                            self.take_preview(msg.data)
                            continue
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            continue
                        event = json.loads(msg.data)
                        data = event.get("data") or {}
                        if event.get("type") == "progress":
                            self.progress[data.get("prompt_id")] = {"value": data["value"], "max": data["max"]}
                        elif event.get("type") == "executed" and data.get("prompt_id") == self._running:
                            self.shown.setdefault(self._running, {})[str(data.get("node"))] = data.get("output")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.debug("[phone] progress websocket: %s", exc)
            await asyncio.sleep(2)

    async def _execute(self, session, job, run):
        run.update(status="running", started=time.time())
        self._save()
        # preview_method: live previews for the phone, whatever the PC's own setting is.
        extra = {"preview_method": "auto"}
        if job.get("workflow"):  # an empty one ("workflow": None) breaks ComfyUI's own job list (/api/jobs)
            extra["extra_pnginfo"] = {"workflow": job["workflow"]}
        payload = {"prompt": run_prompt(job, run), "client_id": self.client_id, "extra_data": extra}
        async with session.post("/prompt", json=payload) as res:
            body = await res.json(content_type=None)
        if res.status != 200 or "prompt_id" not in body:
            raise PromptRejected(describe_rejection(body))
        # ComfyUI still queues a prompt when only some outputs are invalid and silently skips those.
        dropped = describe_rejection(body, "Some nodes failed validation") if body.get("node_errors") else None
        prompt_id = run["prompt_id"] = body["prompt_id"]
        self._running = prompt_id
        self._save()

        missing = 0
        while True:
            await asyncio.sleep(1)
            async with session.get(f"/history/{prompt_id}") as res:
                history = await res.json(content_type=None)
            if prompt_id in history:
                entry = history[prompt_id]
                break
            if job.get("cancelled") or run.get("skip"):
                async with session.post("/queue", json={"delete": [prompt_id]}):
                    pass  # in case it hasn't started yet
                async with session.post("/interrupt", json={"prompt_id": prompt_id}):
                    pass  # in case it is running; only stops this prompt
                raise Cancelled()
            async with session.get("/queue") as res:
                queue = await res.json(content_type=None)
            waiting = {item[1] for item in queue.get("queue_running", []) + queue.get("queue_pending", [])}
            missing = 0 if prompt_id in waiting else missing + 1
            if missing >= 3:
                raise RuntimeError("Removed from the ComfyUI queue")

        status = entry.get("status", {})
        if status.get("status_str") == "error":
            raise RuntimeError(describe_failure(status))
        outputs = collect_outputs(entry)
        texts = collect_texts(entry.get("outputs", {}), job.get("base", {}), job.get("text_choice"))
        if not outputs:
            if dropped:
                raise PromptRejected(dropped)  # the remaining runs would end the same way
            unsaved = unsaved_counts(entry)  # made, but only previewed: gone after the run, so say so
            if unsaved:
                run["unsaved"] = unsaved
            if not texts:  # text alone is a result too (an LLM's answer, say)
                raise RuntimeError("Nothing was saved" if unsaved
                                   else "Finished, but no image was saved (does the workflow have a Save Image node?)")
        run.update(status="done", outputs=outputs, texts=texts)

"""ComfyUI-from-your-Phone: serves a mobile web app at /phone/ plus its API under /phone/api/."""
import asyncio
import functools
import hashlib
import os
import random
import uuid
from pathlib import Path

import folder_paths
import nodes
from aiohttp import web
from comfy.cli_args import args
from multidict import CIMultiDict
from server import PromptServer

from .jobs import MASK_PREFIX, VIDEO_SUFFIXES, JobQueue, alpha_masks, apply_values, build_job, file_inputs, job_details, shown_file, validate_values
from .prompts import PromptLibrary
from .push import Push, missing_packages
from .workflows import WorkflowStore, pc_file_state, validate_share

ROOT = Path(__file__).parent
APP_DIR = (ROOT / "app").resolve()
DATA = ROOT / "data"
STORE = WorkflowStore(DATA / "workflows")
THUMB_DIR = DATA / "thumbs"
THUMB_SIZES = (512, 1600, 8192)  # grid, Tasks preview, gallery copy on the phone
_MAKING = {}  # preview file name -> the task making it
# Named here: Windows doesn't know every audio type, and a wrong one would reach the phone's share sheet.
AUDIO_TYPES = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".ogg": "audio/ogg",
               ".opus": "audio/ogg", ".m4a": "audio/mp4"}
MEDIA_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".gif") + VIDEO_SUFFIXES + tuple(AUDIO_TYPES)  # what /phone/api/original serves
# Pictures never go into the phone browser's own cache: the app's gallery is the only place on the
# phone that keeps them, so deleting there really deletes them.
NO_STORE = {"Cache-Control": "no-store"}
GONE = {"X-Phone-Gone": "1"}  # a 404 from this node: the workflow was deleted (sw.js)

# Previews are a cache: emptied at every start, like ComfyUI's temp folder, and rebuilt on demand.
# The phone keeps its own copies, so nothing is lost.
if THUMB_DIR.is_dir():
    for _old in THUMB_DIR.iterdir():
        if _old.is_file() and _old.suffix in (".webp", ".tmp"):
            _old.unlink(missing_ok=True)

# shortcut: talks to ComfyUI over plain HTTP on loopback; needs a change if ComfyUI runs with --tls-keyfile
# or listens only on a non-loopback address.
JOBS = JobQueue(DATA / "jobs.json", f"http://127.0.0.1:{args.port}")
PUSH = Push(DATA / "push.json")  # notifications, for phones that turned them on
JOBS.on_finished = lambda job: PUSH.notify()
PROMPTS = PromptLibrary(DATA / "prompts.json")  # the phones' prompts and snippets (backup + between devices)
RNG = random.SystemRandom()

for _job in JOBS.jobs:  # jobs from before the gallery stored details
    if "details" not in _job:
        try:
            _record = STORE.get(_job["workflow_id"])
            _job["details"] = job_details(_record, apply_values(_record, _job["values"]))
        except Exception:  # workflow gone or changed: the image just shows without details
            continue

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"  # PC-side extension: "Share to phone"

routes = PromptServer.instance.routes


APP_ENTRY = ("/phone", "/phone/")
# Other sites may not show the app inside a frame of theirs (they could trick a tap on Delete).
NO_FRAMING = {"Cache-Control": "no-cache", "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY"}


@web.middleware
async def _allow_app_launch(request, handler):
    # Opening the installed app from the home screen arrives as a cross-site navigation,
    # which ComfyUI's CSRF protection rejects with 403. Only top-level navigations to the app's
    # static entry page are let through (not frames); its own follow-up requests are same-origin.
    if (request.method == "GET" and request.path in APP_ENTRY
            and request.headers.get("Sec-Fetch-Mode") == "navigate"
            and request.headers.get("Sec-Fetch-Dest") == "document"
            and request.headers.get("Sec-Fetch-Site") == "cross-site"):
        headers = CIMultiDict(request.headers)
        headers["Sec-Fetch-Site"] = "none"
        request = request.clone(headers=headers)
    return await handler(request)


# Outermost, so it runs before ComfyUI's own checks.
PromptServer.instance.app.middlewares.insert(0, _allow_app_launch)


@routes.get("/phone")
async def phone_redirect(request):
    raise web.HTTPFound("/phone/")


@routes.get("/phone/")
async def phone_index(request):
    return web.FileResponse(APP_DIR / "index.html", headers=NO_FRAMING)


@routes.get("/phone/api/status")
async def phone_status(request):
    try:
        from comfyui_version import __version__ as version
    except ImportError:
        version = "unknown"
    return web.json_response({
        "ok": True,
        "comfyui_version": version,
        "queue_remaining": PromptServer.instance.prompt_queue.get_tasks_remaining(),
        "max_upload": round(args.max_upload_size * 1024 * 1024),  # ComfyUI's own limit (--max-upload-size)
    })


@routes.post("/phone/api/ping")
async def phone_ping(request):
    # Lets the app check that write requests get through (proxy / origin check).
    return web.json_response({"ok": True})


def _push_missing():
    # 500, not 502: the app reads 502-504 as "ComfyUI isn't running".
    why = missing_packages()
    return why and web.json_response({"error": why}, status=500)


@routes.get("/phone/api/push")
async def push_key(request):
    # A key made on this PC; creating it needs no internet. Turning notifications on starts here, so a missing
    # package is said here.
    return _push_missing() or web.json_response({"key": await asyncio.to_thread(PUSH.public_key)})


async def _endpoint(request):
    try:
        body = await request.json()
    except ValueError:
        body = None
    return body.get("endpoint") if isinstance(body, dict) else None


@routes.put("/phone/api/push/subscription")
async def push_subscribe(request):
    try:
        PUSH.add(await _endpoint(request))
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response({"ok": True})


@routes.delete("/phone/api/push/subscription")
async def push_unsubscribe(request):
    PUSH.remove(await _endpoint(request))
    return web.json_response({"ok": True})


@routes.post("/phone/api/push/test")
async def push_test(request):
    if not PUSH.endpoints:
        return web.json_response({"error": "Notifications aren't turned on on any phone"}, status=400)
    if missing := _push_missing():
        return missing
    sent = await PUSH.send()
    if not sent:
        # 500, not 502: the app reads 502-504 as "ComfyUI isn't running".
        return web.json_response({"error": "No push service took it. Is the PC connected to the internet?"}, status=500)
    return web.json_response({"sent": sent})


@routes.get("/phone/api/prompts")
async def get_prompts(request):
    # A phone that has the current version gets an empty "unchanged" instead of the whole library.
    version = PROMPTS.version()
    headers = {**NO_STORE, "ETag": f'"{version}"'}
    if request.headers.get("If-None-Match") == f'"{version}"':
        return web.Response(status=304, headers=headers)
    return web.json_response({"version": version, "entries": PROMPTS.load()}, headers=headers)


@routes.put("/phone/api/prompts")
async def sync_prompts(request):
    # The phone sends its library after changing it; the PC merges (never replaces) and answers with the result.
    try:
        body = await request.json()
        merged = PROMPTS.sync(body.get("entries") if isinstance(body, dict) else None)
    except ValueError as exc:  # also invalid JSON
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response({"version": PROMPTS.version(), "entries": merged}, headers=NO_STORE)


def _user_dir():
    # shortcut: ComfyUI's single-user folder ("default"); with --multi-user the hints don't fit, and a moved file
    # isn't told apart from a "Save As" copy. Upgrade if multi-user setups turn up.
    return Path(folder_paths.get_user_directory()) / "default"


def _add_pc_state(items):
    user_dir = _user_dir()
    for item in items:
        try:
            item.update(pc_file_state(item, user_dir))
        except OSError:
            pass  # no hint rather than no list
    return items


@routes.get("/phone/api/workflows")
async def list_workflows(request):
    # The phone's files are read here, where all writes happen too: Windows refuses to replace a file that
    # another thread is reading. Only the PC's workflow files are checked in the background.
    return web.json_response(await asyncio.to_thread(_add_pc_state, STORE.list()))


@routes.post("/phone/api/workflows")
async def share_workflow(request):
    try:
        cleaned = validate_share(await request.json())
    except ValueError as exc:  # also covers invalid JSON
        return web.json_response({"error": str(exc)}, status=400)
    record = STORE.save_share(cleaned, _user_dir())
    return web.json_response({"id": record["id"], "field_count": len(record["fields"])})


@routes.get("/phone/api/workflows/{id}")
async def get_workflow(request):
    try:
        record = STORE.get(request.match_info["id"])
    except KeyError:
        # Marked as ours: only then does sw.js drop the phone's copy. A plain 404 (this node not loaded, say)
        # leaves it, so the phone still shows its copies.
        return web.json_response({"error": "no longer on the PC"}, status=404, headers=GONE)
    # Without the PC's drawing of the workflow (often 100 KB): only the PC needs it, to put it into the PNGs.
    record.pop("workflow", None)
    for f in record["fields"]:  # lists of videos or audio files get the phone's upload and "From PC" buttons
        if f["kind"] == "combo" and (media := media_kind(record["prompt"].get(f["node"], {}).get("class_type"), f["input"])):
            f["media"] = media
    return web.json_response(record)


# The VideoHelperSuite adds its upload buttons in its own PC-side script, so ComfyUI doesn't flag these lists.
VHS_UPLOADS = {("VHS_LoadVideo", "video"): "video", ("VHS_LoadVideoFFmpeg", "video"): "video",
               ("VHS_LoadAudioUpload", "audio"): "audio"}


@functools.cache
def media_kind(class_type, name):
    """"video" or "audio" when this input of the node is a list of such files that ComfyUI lets you upload
    to (Load Video, Load Audio, …), else None."""
    if (class_type, name) in VHS_UPLOADS:
        return VHS_UPLOADS[class_type, name]
    cls = nodes.NODE_CLASS_MAPPINGS.get(class_type)
    try:  # read the way ComfyUI's /object_info reads it
        inputs = cls.GET_NODE_INFO_V1()["input"] if hasattr(cls, "GET_NODE_INFO_V1") else cls.INPUT_TYPES()
        spec = inputs.get("required", {}).get(name) or inputs.get("optional", {}).get(name)
        opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
    except Exception:  # unknown node or input
        return None
    return "video" if opts.get("video_upload") else "audio" if opts.get("audio_upload") else None


def _files(kind):
    """Every file of this kind ("image", "video", "audio") in ComfyUI's input and output folders and their
    subfolders, newest first, named the way the loaders take them: "sub/a.png", "sub/a.png [output]"."""
    found = []

    def walk(folder, prefix, mark):
        try:
            entries = list(os.scandir(folder))
        except OSError:  # gone or unreadable: skipped, like hidden ones
            return
        for e in entries:
            # Links and Windows junctions too: ComfyUI's loaders refuse what lies outside input/output anyway.
            # (is_junction needs Python 3.12; older ones still list what's behind a junction)
            if e.name.startswith(".") or e.is_symlink() or (hasattr(e, "is_junction") and e.is_junction()):
                continue
            if e.is_dir(follow_symlinks=False):
                walk(e.path, f"{prefix}{e.name}/", mark)
            elif folder_paths.filter_files_content_types([e.name], [kind]):  # ComfyUI's own idea of the type
                try:
                    found.append((e.stat().st_mtime, f"{prefix}{e.name}{mark}"))
                except OSError:
                    pass

    walk(folder_paths.get_input_directory(), "", "")
    walk(folder_paths.get_output_directory(), "", " [output]")
    return [name for _, name in sorted(found, reverse=True)]  # same time: by name, backwards (…_00002 before …_00001)


@routes.get("/phone/api/files")
async def list_files(request):
    kind = request.rel_url.query.get("kind")
    if kind not in ("image", "video", "audio"):
        return web.json_response({"error": "kind must be image, video or audio"}, status=400)
    return web.json_response(await asyncio.to_thread(_files, kind))


@routes.delete("/phone/api/workflows/{id}")
async def delete_workflow(request):
    try:
        STORE.delete(request.match_info["id"])
    except KeyError:
        raise web.HTTPNotFound()
    return web.json_response({"ok": True})


def _get_record(request):
    try:
        return STORE.get(request.match_info["id"])
    except KeyError:
        raise web.HTTPNotFound()


@routes.put("/phone/api/workflows/{id}/values")
async def save_values(request):
    record = _get_record(request)
    try:
        body = await request.json()
        values = validate_values(record, body.get("values") if isinstance(body, dict) else None)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    # The phone sends what it changed; fields it didn't touch keep what the PC has (maybe newer than its copy).
    return web.json_response({"ok": True, "values": STORE.merge_values(record["id"], values)})


@routes.delete("/phone/api/workflows/{id}/values")
async def reset_values(request):
    # "Reset to PC values" also brings back the PC's name.
    record = _get_record(request)
    STORE.set_values(record["id"], {})
    STORE.rename(record["id"], None)
    return web.json_response({"ok": True})


@routes.put("/phone/api/workflows/{id}/name")
async def rename_workflow(request):
    record = _get_record(request)
    try:
        body = await request.json()
        STORE.rename(record["id"], body.get("name") if isinstance(body, dict) else 0)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response({"ok": True})


@routes.post("/phone/api/workflows/{id}/copy")
async def copy_workflow(request):
    # "Use again": a copy with an image's settings, so the workflow itself stays as it is.
    record = _get_record(request)
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("body must be an object")
        copy = STORE.copy(record["id"], body.get("name"), validate_values(record, body.get("values", {})))
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response({"id": copy["id"], "name": copy["name"]})


@routes.post("/phone/api/workflows/restore")
async def restore_workflow(request):
    # "Use again" on an image whose workflow was deleted: made again from the recipe the image carries
    # (workflows.share_recipe), checked like a share from the PC. Only phone copies come from it, no PC file.
    try:
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("recipe"), dict):
            raise ValueError("recipe must be an object")
        record = validate_share(dict(body["recipe"], name=body.get("name"), source="", path=None, workflow=None))
        copy = STORE.copy("", record["name"], validate_values(record, body.get("values", {})), record=record)  # no original left
    except ValueError as exc:  # also covers invalid JSON
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response({"id": copy["id"], "name": copy["name"]})


@routes.put("/phone/api/workflow-order")
async def save_workflow_order(request):
    try:
        body = await request.json()
        STORE.set_list_order(body.get("ids") if isinstance(body, dict) else None)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response({"ok": True})


@routes.put("/phone/api/workflows/{id}/order")
async def save_order(request):
    record = _get_record(request)
    try:
        body = await request.json()
        STORE.set_order(record["id"], body.get("keys") if isinstance(body, dict) else None)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response({"ok": True})


@routes.get("/phone/api/jobs")
async def list_jobs(request):
    return web.json_response(JOBS.public())


@routes.get("/phone/api/jobs/{id}")
async def get_job(request):
    job = JOBS.get(request.match_info["id"])
    if job is None:
        raise web.HTTPNotFound()
    return web.json_response(job)


@routes.get("/phone/api/jobs/{id}/preview")
async def job_preview(request):
    try:
        preview = JOBS.preview(request.match_info["id"])
    except KeyError:
        raise web.HTTPNotFound()
    if not preview:
        raise web.HTTPNotFound()
    return web.Response(body=preview["data"], content_type=preview["mime"], headers={"Cache-Control": "no-store"})


JOB_ACTIONS = {
    "pause": lambda job_id: JOBS.pause(job_id, True),
    "resume": lambda job_id: JOBS.pause(job_id, False),
    "cancel": JOBS.cancel,
    "skip": JOBS.skip,
    "up": lambda job_id: JOBS.move(job_id, -1),
    "down": lambda job_id: JOBS.move(job_id, 1),
}


@routes.post("/phone/api/jobs/{id}/{action}")
async def job_action(request):
    action = JOB_ACTIONS.get(request.match_info["action"])
    if action is None:
        raise web.HTTPNotFound()
    try:
        action(request.match_info["id"])
    except KeyError:
        return web.json_response({"error": "job not found"}, status=404)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=409)
    return web.json_response({"ok": True})


@routes.delete("/phone/api/jobs/{id}")
async def remove_job(request):
    try:
        JOBS.remove(request.match_info["id"])
    except KeyError:
        return web.json_response({"error": "job not found"}, status=404)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=409)
    return web.json_response({"ok": True})


@routes.delete("/phone/api/jobs")
async def clear_finished_jobs(request):
    JOBS.remove()
    return web.json_response({"ok": True})


@routes.post("/phone/api/jobs")
async def create_job(request):
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("body must be an object")
        record = STORE.get(str(body.get("workflow_id", "")))
    except KeyError:
        return web.json_response({"error": "workflow not found"}, status=404)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    try:
        values = validate_values(record, body.get("values", {}))
        job = build_job(record, values, body.get("count", 1), RNG)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    # Some loaders (Trix) quietly take another picture when the file is gone, so check first.
    for label, name in file_inputs(record, job["base"], media_kind):
        if not folder_paths.exists_annotated_filepath(name):
            return web.json_response({"error": f"{label}: {shown_file(name)} is no longer on the PC."}, status=400)
    for node, inp, picture, mask in alpha_masks(record, values, job["base"]):
        try:
            job["base"][node]["inputs"][inp] = await asyncio.to_thread(_with_mask, picture, mask)
        except Exception as exc:
            return web.json_response({"error": f"Couldn't apply the mask to {picture}: {exc}"}, status=400)
    STORE.set_values(record["id"], values)  # generating also saves what was used
    JOBS.add(job)
    return web.json_response({"id": job["id"], "count": job["count"]})


def _with_mask(picture, mask):
    """Load Image takes its mask from the picture's transparency (transparent = masked), the way
    ComfyUI's own mask editor saves it. Returns the name of a copy of the picture with the phone's mask
    ("" = without a mask), next to the phone's photos; the picture itself when nothing changes."""
    import base64
    import io
    from PIL import Image, ImageOps
    with Image.open(folder_paths.get_annotated_filepath(picture)) as opened:
        if not mask and "A" not in opened.getbands() and "transparency" not in opened.info:
            return picture  # no mask wanted, and it has none
        img = ImageOps.exif_transpose(opened).convert("RGB")  # turned like Load Image turns it
    if mask:
        with Image.open(io.BytesIO(base64.b64decode(mask[len(MASK_PREFIX):]))) as painted:
            masked = painted.convert("RGBA").getchannel("A").resize(img.size, Image.Resampling.BILINEAR)
        img.putalpha(ImageOps.invert(masked))
    name = f"masked-{hashlib.sha1(f'{picture}|{mask}'.encode()).hexdigest()[:16]}.png"
    folder = Path(folder_paths.get_input_directory()) / "phone"
    target = folder / name
    if not target.exists():  # the same picture and mask again: reuse the copy
        folder.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(f".{uuid.uuid4().hex}.tmp")
        img.save(tmp, "PNG")
        tmp.replace(target)
    return f"phone/{name}"


def _make_thumb(source, target, size):
    from PIL import Image, ImageOps
    if source.suffix.lower() in VIDEO_SUFFIXES:
        import av  # ships with ComfyUI
        with av.open(str(source)) as container:
            img = next(container.decode(video=0)).to_image()
    else:
        with Image.open(source) as opened:
            img = ImageOps.exif_transpose(opened)  # phone photos, turned the way ComfyUI's loaders turn them
    img.thumbnail((size, size))
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    img.convert("RGB").save(tmp, "WEBP", quality=82)
    tmp.replace(target)


def _media_file(query):
    """The file a request names inside ComfyUI's input or output folder, else 404 (never outside them)."""
    if query.get("type", "output") not in ("output", "input"):
        raise web.HTTPBadRequest(text="type must be output or input")
    folder = folder_paths.get_input_directory() if query.get("type") == "input" else folder_paths.get_output_directory()
    out_dir = Path(folder).resolve()
    source = (out_dir / query.get("subfolder", "") / query.get("filename", "")).resolve()
    if not source.is_relative_to(out_dir) or not source.is_file():
        raise web.HTTPNotFound()
    return source


@routes.get("/phone/api/thumb")
async def thumb(request):
    query = request.rel_url.query
    try:
        size = int(query.get("size", "512"))
    except ValueError:
        size = 0
    if size not in THUMB_SIZES:
        raise web.HTTPBadRequest(text="size must be one of %s" % (THUMB_SIZES,))
    source = _media_file(query)
    stat = source.stat()
    name = hashlib.sha1(f"{source}|{stat.st_mtime_ns}|{size}".encode()).hexdigest()
    target = THUMB_DIR / f"{name}.webp"
    if not target.exists():
        # The gallery and Tasks often ask for the same preview at once: they share one making of it,
        # so the file is written once and never replaced while being sent (Windows refuses that).
        making = _MAKING.get(name)
        if making is None:
            making = _MAKING[name] = asyncio.ensure_future(asyncio.to_thread(_make_thumb, source, target, size))
            making.add_done_callback(lambda _: _MAKING.pop(name, None))
        await asyncio.shield(making)
    return web.FileResponse(target, headers=NO_STORE)


@routes.get("/phone/api/original")
async def original(request):
    # ComfyUI's /view lets the browser keep a copy; this serves the same files without one.
    source = _media_file(request.rel_url.query)
    if source.suffix.lower() not in MEDIA_SUFFIXES:
        raise web.HTTPNotFound()  # pictures, videos and audio only: nothing (like SVG or HTML) that could run as a page
    audio = AUDIO_TYPES.get(source.suffix.lower())
    return web.FileResponse(source, headers={**NO_STORE, "X-Content-Type-Options": "nosniff",
                                             **({"Content-Type": audio} if audio else {})})


# Registered last so the explicit routes above win.
@routes.get("/phone/{path:.+}")
async def phone_file(request):
    path = (APP_DIR / request.match_info["path"]).resolve()
    if not path.is_relative_to(APP_DIR) or not path.is_file():
        raise web.HTTPNotFound()
    # no-cache = revalidate every time, so app updates reach the phone on the next load.
    return web.FileResponse(path, headers={"Cache-Control": "no-cache"})

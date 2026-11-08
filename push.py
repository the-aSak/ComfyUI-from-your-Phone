"""Notifications ("your images are ready") over Web Push, for phones that turned them on in Settings.

The PC asks the browser maker's push service (Google's for Chrome) to wake the app on the phone. The message
is empty: the app then asks the PC itself, over Tailscale, what finished. So the push service learns only
that, and when, this PC wanted to reach a phone. Nothing is sent while no phone has turned it on.
"""
import asyncio
import base64
import functools
import json
import logging
import time
from pathlib import Path
from urllib.parse import urlsplit

try:
    from .workflows import read_file, replace_file
except ImportError:  # loaded standalone by the tests
    from workflows import read_file, replace_file

log = logging.getLogger(__name__)

# The push services of the browsers. A subscription is only an address, so the PC never posts anywhere else.
PUSH_HOSTS = ("fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com")
PUSH_DOMAINS = (".notify.windows.com",)
SUBJECT = "mailto:noreply@comfy-phone.invalid"  # the contact Web Push asks for; never written to
TOKEN_LIFE = 12 * 3600  # longest the push services accept is 24 h
MAX_DEVICES = 10
MISSING = "the PC needs the Python packages cryptography and PyJWT for notifications (see the README)"


@functools.cache  # checked once (installing them needs a restart anyway), so the log says it once
def missing_packages():
    """MISSING when a package notifications need can't be loaded (fresh ComfyUI installs often lack them), else
    None. Everything else works without them."""
    try:
        import jwt  # noqa: F401
        from cryptography.hazmat.primitives.asymmetric import ec  # noqa: F401
    except ImportError as exc:
        log.warning("[phone] notifications are off: %s (%s)", MISSING, exc)
        return MISSING
    return None


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def valid_endpoint(url):
    """An https address of a known push service."""
    if not isinstance(url, str) or len(url) > 2000:
        return False
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    return parts.scheme == "https" and (host in PUSH_HOSTS or host.endswith(PUSH_DOMAINS))


class Push:
    def __init__(self, path):
        self.path = Path(path)
        try:
            data = json.loads(read_file(self.path))
        except FileNotFoundError:
            data = {}
        except (OSError, ValueError):
            log.exception("[phone] could not read %s; notifications start empty", self.path)
            data = {}
        self._pem = data.get("key")  # the PC's own key, made the first time a phone asks for it
        self.endpoints = [e for e in data.get("endpoints", []) if valid_endpoint(e)]
        self._private = None
        self._tasks = set()

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"key": self._pem, "endpoints": self.endpoints}), encoding="utf-8")
        replace_file(tmp, self.path)

    def _key(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        if self._private is None:
            if self._pem:
                self._private = serialization.load_pem_private_key(self._pem.encode(), password=None)
            else:
                self._private = ec.generate_private_key(ec.SECP256R1())
                self._pem = self._private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                        serialization.NoEncryption()).decode()
                self._save()
        return self._private

    def public_key(self):
        """The key the phone subscribes with (applicationServerKey), base64url."""
        from cryptography.hazmat.primitives import serialization
        raw = self._key().public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        return b64url(raw)

    def add(self, endpoint):
        if not valid_endpoint(endpoint):
            raise ValueError("not an address of a known push service")
        if endpoint not in self.endpoints:
            if len(self.endpoints) >= MAX_DEVICES:  # each finished job sends one request per device
                raise ValueError(f"notifications are on for {MAX_DEVICES} devices already; turn them off on one first")
            self.endpoints.append(endpoint)
            self._save()

    def remove(self, endpoint):
        if endpoint in self.endpoints:
            self.endpoints.remove(endpoint)
            self._save()

    def authorization(self, endpoint):
        """The VAPID header: proves to the push service that this PC is the one the phone subscribed to."""
        import jwt
        parts = urlsplit(endpoint)
        claims = {"aud": f"{parts.scheme}://{parts.netloc}", "exp": int(time.time()) + TOKEN_LIFE, "sub": SUBJECT}
        return f"vapid t={jwt.encode(claims, self._key(), algorithm='ES256')}, k={self.public_key()}"

    async def send(self, session=None):
        """Wakes every subscribed phone. Returns how many push services took it."""
        import aiohttp
        if not self.endpoints or missing_packages():  # turned on before the packages went: said in the log
            return 0
        own = session is None
        session = session or aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))
        sent = 0
        try:
            for endpoint in list(self.endpoints):
                headers = {"TTL": "3600", "Urgency": "normal", "Authorization": self.authorization(endpoint)}
                try:
                    async with session.post(endpoint, data=b"", headers=headers) as res:
                        if res.status in (404, 410):  # the phone turned it off or the subscription ran out
                            self.remove(endpoint)
                        elif res.status >= 400:
                            log.warning("[phone] push service answered %s: %s", res.status, (await res.text())[:200])
                        else:
                            sent += 1
                except Exception as exc:  # no internet: the phone just gets no notification
                    log.warning("[phone] could not reach the push service: %s", exc)
        finally:
            if own:
                await session.close()
        return sent

    def notify(self):
        """Sends in the background (called when a job finishes)."""
        if not self.endpoints:
            return
        task = asyncio.get_running_loop().create_task(self.send())
        self._tasks.add(task)  # keeps it alive until done
        task.add_done_callback(self._tasks.discard)

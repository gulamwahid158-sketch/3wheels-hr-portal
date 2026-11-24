"""Runs on a PC in the office (same LAN as the CP PLUS machine).
machine --TCP/JSON--> this script --HTTPS--> portal /api/biometric/ingest

Setup:  set PORTAL_URL=https://hr.3wheels.ai   set BIOMETRIC_TOKEN=<same secret as on Render>
Run:    python machine_connector.py            (needs port 80 free; on the machine set Server IP = this PC's IP, DNS = No, port 80)
Punches are saved to connector_queue.jsonl first, so nothing is lost when the internet or the portal is down.
Allow the machine through the Windows firewall (inbound TCP 80 from the machine's IP).
"""
import base64, json, os, socket, sys, threading, time, urllib.request, urllib.error
from datetime import datetime

PORT = int(os.environ.get("CONNECTOR_PORT", "80"))
PORTAL = os.environ.get("PORTAL_URL", "https://hr.3wheels.ai").rstrip("/")
TOKEN = os.environ.get("BIOMETRIC_TOKEN", "")
HERE = os.path.dirname(os.path.abspath(__file__))
QUEUE = os.path.join(HERE, "connector_queue.jsonl")   # punches not yet delivered
SEEN = os.path.join(HERE, "connector_seen.txt")       # punches already stored (the machine repeats them)
LOG = os.path.join(HERE, "connector.log")
lock = threading.Lock()
stats = {"repeats": 0}
seen = set(open(SEEN).read().split("\n")) if os.path.exists(SEEN) else set()


def log(msg):
    line = "%s %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line, flush=True)
    with lock, open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def decode_block(block):
    raw = base64.b64decode(block)
    return json.loads(raw[4:].rstrip(b"\0").decode("utf-8", "replace"))   # 4 byte length + JSON + NUL


def encode_block(obj):
    body = json.dumps(obj).encode() + b"\0"
    return base64.b64encode(len(body).to_bytes(4, "little") + body).decode()


def ack_reply(request_json):
    """THE UNKNOWN PART: the JSON the machine wants back so that it marks a punch as received.
    Until CP PLUS tells us, this is a best guess; set ACK_STYLE=plain to try another one."""
    style = os.environ.get("ACK_STYLE", "block")
    t = request_json.get("trans_id", "")
    if style == "sweep":
        return sweep_reply(t)
    if style == "block":   # same envelope as the machine's own messages, with an encoded body
        return {"trans_id": t, "response_code": "OK", "cmd_code": "", "blk_len": 0, "blk_no": 0,
                "block": encode_block({"result": "OK"})}
    return {"trans_id": t, "response_code": "OK", "cmd_code": "", "blk_len": 0, "blk_no": 0, "block": ""}


SWEEP_EVERY = 6          # requests answered with one variant before moving to the next
sweep_state = {"n": 0, "label": "", "prev": ""}


def sweep_variants():
    """Replies to try, most promising first. A reply is bytes (sent as the body) or a dict (sent as JSON)."""
    out = [("plain OK", b"OK"), ("plain SUCCESS", b"SUCCESS"), ("plain 0", b"0"), ("empty body", b""), ("empty json", b"{}")]
    keys = ["response_code", "result", "ret", "code", "status", "return_code", "err_code"]
    vals = ["OK", "SUCCESS", "0", "200", "1", "true"]
    for shape in ("block", "bare", "bare+trans", "empty-block"):
        for k in keys:
            for v in vals:
                out.append(("%s %s=%s" % (shape, k, v), (shape, k, v)))
    return out


def sweep_reply(trans_id):
    variants = sweep_variants()
    only = os.environ.get("SWEEP_ONLY")   # stay on one reply once it is known to work
    changed = None
    with lock:
        idx = next((i for i, v in enumerate(variants) if v[0] == only), None) if only else None
        if idx is None:
            idx = (sweep_state["n"] // SWEEP_EVERY) % len(variants)
        sweep_state["n"] += 1
        if variants[idx][0] != sweep_state["label"]:
            sweep_state["prev"], sweep_state["label"] = sweep_state["label"], variants[idx][0]
            changed = "SWEEP now trying: %s (%d of %d)" % (sweep_state["label"], idx + 1, len(variants))
    if changed:
        log(changed)   # outside the lock: log() takes the same (non reentrant) lock and would hang the connector
    spec = variants[idx][1]
    if isinstance(spec, bytes):
        return spec
    shape, k, v = spec
    if shape == "bare":
        return {k: v}
    if shape == "bare+trans":
        return {"trans_id": trans_id, k: v}
    env = {"trans_id": trans_id, k: v, "cmd_code": "", "blk_len": 0, "blk_no": 0, "block": ""}
    if shape == "block":
        env["block"] = encode_block({k: v})
    return env


def save_punch(d, dev):
    key = "%s|%s" % (d.get("user_id"), d.get("io_time"))
    with lock:
        if key in seen:
            return False
        seen.add(key)
        at = datetime.strptime(d["io_time"], "%Y%m%d%H%M%S").strftime("%Y-%m-%d %H:%M:%S")
        with open(QUEUE, "a", encoding="utf-8") as f:
            f.write(json.dumps({"enno": d["user_id"], "at": at, "machine": dev, "name": ""}) + "\n")
        with open(SEEN, "a") as f:
            f.write(key + "\n")
    log("punch saved: user %s at %s" % (d["user_id"], at))
    if os.environ.get("ACK_STYLE") == "sweep":
        log("*** NEW PUNCH ARRIVED: the machine moved on. Reply in use: %r (before it: %r)" % (sweep_state["label"], sweep_state["prev"]))
    return True


def handle(conn, addr):
    """Two framings seen from this machine: HTTP with a JSON body, and raw TCP = 4 header bytes + JSON.
    A raw message has no end marker, so as soon as one JSON object is complete we answer it."""
    conn.settimeout(25)
    data = b""
    HTTP = (b"GET ", b"POST ", b"PUT ", b"HEAD ")
    CRLF2 = b"\r\n\r\n"
    try:
        while len(data) < 262144:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
            if data.startswith(HTTP):
                if CRLF2 in data:
                    head, _, rest = data.partition(CRLF2)
                    n = 0
                    for line in head.split(b"\r\n"):
                        if line.lower().startswith(b"content-length:"):
                            n = int(line.split(b":")[1])
                    if len(rest) >= n:
                        break
            elif b"{" in data:
                try:
                    json.loads(data[data.index(b"{"):].decode("utf-8", "replace").rstrip("\0"))
                    break
                except ValueError:
                    pass
        raw = not data.startswith(HTTP)
        text = data[data.index(b"{"):] if raw else data.partition(CRLF2)[2]
        req = json.loads(text.decode("utf-8", "replace").rstrip("\0"))
        if req.get("request_code") == "realtime_glog" and req.get("block"):
            if not save_punch(decode_block(req["block"]), str(req.get("dev_id", ""))):
                stats["repeats"] += 1
                if stats["repeats"] % 100 == 1:
                    log("machine keeps repeating an already stored punch (%d times so far): it is not accepting our reply" % stats["repeats"])
        else:
            log("from %s (%s): %s %s" % (addr[0], "raw" if raw else "http", req.get("request_code"), req.get("trans_id")))
        reply = ack_reply(req)
        body = reply if isinstance(reply, bytes) else json.dumps(reply).encode()
        if raw:
            conn.sendall(data[:data.index(b"{")] + body)   # same 4 byte header the machine used, then our JSON
        else:
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json;charset=utf-8\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body)
    except Exception as e:
        log("bad request from %s: %s | got %d bytes: %r" % (addr[0], e, len(data), data[:200]))
    finally:
        conn.close()


def sender():
    """Every few seconds: send what is waiting in the queue to the portal; keep it if that fails."""
    while True:
        time.sleep(5)
        with lock:
            lines = open(QUEUE, encoding="utf-8").read().splitlines() if os.path.exists(QUEUE) else []
        if not lines:
            continue
        batch = [json.loads(x) for x in lines[:500]]
        try:
            r = urllib.request.Request(PORTAL + "/api/biometric/ingest", data=json.dumps({"punches": batch}).encode(),
                                       headers={"Content-Type": "application/json", "Authorization": "Bearer " + TOKEN})
            res = json.loads(urllib.request.urlopen(r, timeout=30).read())
        except urllib.error.HTTPError as e:
            log("portal refused (%s): %s" % (e.code, e.read()[:200])); time.sleep(55); continue
        except Exception as e:
            log("portal not reachable, will retry: %s" % e); time.sleep(55); continue
        with lock:   # drop only what we sent; new lines may have been added meanwhile
            rest = open(QUEUE, encoding="utf-8").read().splitlines()[len(batch):]
            open(QUEUE, "w", encoding="utf-8").write("".join(x + "\n" for x in rest))
        log("sent %d punch(es) to portal, %d new" % (res.get("received", 0), res.get("new", 0)))


if __name__ == "__main__":
    if len(TOKEN) < 16:
        sys.exit("Set BIOMETRIC_TOKEN (same value as on Render, at least 16 characters).")
    threading.Thread(target=sender, daemon=True).start()
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", PORT)); srv.listen(16)
    log("connector listening on port %d, portal %s" % (PORT, PORTAL))
    while True:
        c, a = srv.accept()
        threading.Thread(target=handle, args=(c, a), daemon=True).start()

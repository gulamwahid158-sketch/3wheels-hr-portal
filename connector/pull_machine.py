"""Pulls punches from the CP PLUS CP-VTA-F1043 over the LAN and sends them to the portal.

The machine must be in Net Mode = LOCAL (Set Comm -> TCP/IP -> Net Mode). It then listens on TCP port 5005
and answers read-only requests; this script only reads (ping, record count, user names, punch records).

Setup:  set PORTAL_URL=https://hr.3wheels.ai   set BIOMETRIC_TOKEN=<same secret as on the portal>   set MACHINE_IP=192.168.1.49
Run:    python pull_machine.py            (repeats every PULL_EVERY seconds, default 60)
        python pull_machine.py --once     (one pull, then stop)

Wire format (found by testing, matches a public write-up of a related reader):
  request  55 aa | 12 byte payload | 01 00          reply  aa 55 | 8 byte header | [55 aa | payload]
  record count: payload 01 b4 08 00 00 00 00 00 ff ff 00 00      -> count in reply bytes 4..5 (little endian)
  user name:    payload 01 c7 <id u32 le> 00 00 00 00 14 00      -> UTF-16LE name (10 characters at most)
  records:      block 0 payload 01 a4 00 00 00 00 <count u16 le> 00 00 00 04, block n payload 01 a4 00 00 00 00 00 00 <n u16 le> 00 04
                each reply carries 1024 bytes = 85 records of 12 bytes after a 12 byte header
  record:       user id u32 le | 01 00 | verify mode (33 = fingerprint) | seconds | u32 le with
                bits 0-11 year-1521, 12-15 month, 16-20 day, 21-25 hour, 26-31 minute
The machine does not say IN or OUT; the portal treats the first punch of a day as in and the last as out.
"""
import json, os, socket, sys, time, urllib.error, urllib.request
from datetime import datetime

MACHINE_IP = os.environ.get("MACHINE_IP", "192.168.1.49")
MACHINE_PORT = int(os.environ.get("MACHINE_PORT", "5005"))
MACHINE_NO = os.environ.get("MACHINE_NO", "2")
PORTAL = os.environ.get("PORTAL_URL", "https://hr.3wheels.ai").rstrip("/")
TOKEN = os.environ.get("BIOMETRIC_TOKEN", "")
EVERY = int(os.environ.get("PULL_EVERY", "60"))
PULL_FROM = os.environ.get("PULL_FROM", "")        # e.g. 2026-11-01: older punches are not sent to the portal
HERE = os.path.dirname(os.path.abspath(__file__))
SENT = os.path.join(HERE, "pulled_sent.txt")      # punches the portal already has
COUNT = os.path.join(HERE, "pulled_count.txt")   # record count at the last complete pull
LOG = os.path.join(HERE, "pull_machine.log")


def log(msg):
    line = "%s %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def ask(payload_hex, want=None, wait=3.0):
    """One request on its own connection; returns the reply bytes (waits until `want` bytes arrived, if given)."""
    s = socket.create_connection((MACHINE_IP, MACHINE_PORT), timeout=5)
    s.sendall(bytes.fromhex("55aa" + payload_hex + "0100"))
    s.settimeout(wait)
    out = b""
    try:
        while want is None or len(out) < want:
            chunk = s.recv(8192)
            if not chunk:
                break
            out += chunk
    except socket.timeout:
        pass
    finally:
        s.close()
    return out


def decode_record(r):
    v = int.from_bytes(r[8:12], "little")
    year, month, day = (v & 0xfff) + 1521, (v >> 12) & 0xf, (v >> 16) & 0x1f
    hour, minute = (v >> 21) & 0x1f, (v >> 26) & 0x3f
    return int.from_bytes(r[:4], "little"), datetime(year, month, day, hour, minute, r[7])


def read_all_punches():
    if ask("0180000000000000000000" + "00", want=10)[:2] != b"\xaa\x55":
        raise RuntimeError("machine did not answer the ping (is Net Mode = Local?)")
    count = int.from_bytes(ask("01b408000000" + "0000ffff0000", want=10)[4:6], "little")
    blocks = (count * 12 + 1023) // 1024
    data = b""
    for n in range(blocks):
        arg = count.to_bytes(2, "little").hex() + "000000" + "04" if n == 0 else "0000" + n.to_bytes(2, "little").hex() + "0004"
        reply = ask("01a4" + "00000000" + arg if n == 0 else "01a4" + "00000000" + arg, want=1038, wait=4.0)
        if len(reply) < 1038 or reply[:2] != b"\xaa\x55":
            raise RuntimeError("block %d of %d came back incomplete (%d bytes)" % (n, blocks, len(reply)))
        data += reply[12:12 + 1024]
    out = []
    for i in range(count):
        uid, at = decode_record(data[i * 12:(i + 1) * 12])
        out.append((uid, at))
    return count, out


def user_name(uid):
    r = ask("01c7" + uid.to_bytes(4, "little").hex() + "00000000" + "1400", want=12, wait=2.0)
    if len(r) > 12 and r[10:12] == b"\x55\xaa":
        return r[12:].decode("utf-16le", "ignore").split("\0")[0].strip()
    return ""


def post(batch):
    req = urllib.request.Request(PORTAL + "/api/biometric/ingest", data=json.dumps({"punches": batch}).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + TOKEN})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def pull_once():
    seen = set(open(SENT).read().split("\n")) if os.path.exists(SENT) else set()
    count, punches = read_all_punches()
    fresh = [(u, t) for u, t in punches if "%d|%s" % (u, t.strftime("%Y%m%d%H%M%S")) not in seen and (not PULL_FROM or t.strftime("%Y-%m-%d") >= PULL_FROM)]
    if not fresh:
        open(COUNT, "w").write(str(count))
        log("machine has %d punches, nothing new" % count)
        return 0
    names = {u: user_name(u) for u in {u for u, _ in fresh}}
    sent = 0
    for i in range(0, len(fresh), 500):
        part = fresh[i:i + 500]
        res = post([{"enno": str(u), "name": names.get(u, ""), "at": t.strftime("%Y-%m-%d %H:%M:%S"), "machine": MACHINE_NO} for u, t in part])
        with open(SENT, "a") as f:
            f.write("".join("%d|%s\n" % (u, t.strftime("%Y%m%d%H%M%S")) for u, t in part))
        sent += len(part)
        log("sent %d punch(es) to the portal, %d were new there" % (len(part), res.get("new", 0)))
    open(COUNT, "w").write(str(count))
    return sent


if __name__ == "__main__":
    if len(TOKEN) < 16:
        sys.exit("Set BIOMETRIC_TOKEN (same value as on the portal, at least 16 characters).")
    once = "--once" in sys.argv
    log("pulling from machine %s:%d every %ds, portal %s" % (MACHINE_IP, MACHINE_PORT, EVERY, PORTAL))
    while True:
        try:
            pull_once()
        except urllib.error.HTTPError as e:
            log("portal refused (%s): %s" % (e.code, e.read()[:200]))
        except Exception as e:
            log("could not pull: %s" % e)
        if once:
            break
        time.sleep(EVERY)

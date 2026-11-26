"""Checks that the HR portal is working. The visit also keeps the free Render server from sleeping (it sleeps after 15 idle minutes).

Run once:  python website_check.py          (the scheduled task does this every 5 minutes, see install_website_check.ps1)
It opens the home page and /api/health (which also asks the database) and writes one line to website_check.log:
OK, SLOW (took longer than SLOW_SECONDS) or DOWN. After DOWN_AFTER failures in a row it shows one Windows message,
and writes a line when the website is back. Read-only: no login, nothing is changed.
"""
import os, subprocess, sys, time, urllib.error, urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
URL = os.environ.get("CHECK_URL", "https://hr.3wheels.ai").rstrip("/")
LOG = os.environ.get("CHECK_LOG", os.path.join(HERE, "website_check.log"))
STATE = LOG + ".fails"
SLOW_SECONDS = 5
DOWN_AFTER = 3          # failures in a row before the message (about 15 minutes at one check per 5 minutes)


def visit(path, must_contain):
    """(ok, seconds, note). A sleeping server needs up to a minute for its first answer, so wait that long."""
    t = time.time()
    try:
        with urllib.request.urlopen(urllib.request.Request(URL + path, headers={"User-Agent": "3wheels-website-check"}), timeout=90) as r:
            text = r.read(4000).decode("utf-8", "replace")
        if must_contain not in text: return False, time.time() - t, "%s answered, but not as expected" % path
        return True, time.time() - t, ""
    except urllib.error.HTTPError as e:
        return False, time.time() - t, "%s answered %s%s" % (path, e.code, " (database unreachable)" if e.code == 503 else "")
    except Exception as e:
        return False, time.time() - t, "%s: %s" % (path, e)


def log(line):
    line = "%s %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), line)
    try: print(line, flush=True)
    except Exception: pass
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > 1_000_000: os.replace(LOG, LOG + ".old")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError: pass


def popup(text):
    """A message box in its own process, so this check does not wait for someone to press OK."""
    if os.environ.get("CHECK_NO_POPUP"): return
    code = "import ctypes,sys; ctypes.windll.user32.MessageBoxW(0, sys.argv[1], '3Wheels HR portal', 0x30 | 0x1000)"
    subprocess.Popen([sys.executable, "-c", code, text])


def check():
    results = [visit("/api/health", '"ok"'), visit("/", "<div id=\"app\">")]
    ok = all(r[0] for r in results)
    slowest = max(r[1] for r in results)
    try: fails = int(open(STATE).read())
    except (OSError, ValueError): fails = 0
    if ok:
        if fails >= DOWN_AFTER: log("BACK: the website is working again")
        fails = 0
        log("%s health %.1fs, page %.1fs" % ("SLOW" if slowest > SLOW_SECONDS else "OK  ", results[0][1], results[1][1]))
    else:
        fails += 1
        why = "; ".join(r[2] for r in results if not r[0])
        log("DOWN (%d in a row) %s" % (fails, why))
        if fails == DOWN_AFTER: popup("The HR website is not working (%d checks in a row).\n\n%s\n\n%s" % (fails, URL, why))
    try: open(STATE, "w").write(str(fails))
    except OSError: pass
    return ok


SYNC_LOG = os.path.join(HERE, "pull_machine.log")
SYNC_STALE_MIN = 20     # no successful pull for this long = the machine sync has stopped


def check_sync():
    """If this PC runs the machine sync, say so (once) when it has not read the machine successfully for a while."""
    if not os.path.exists(SYNC_LOG): return True
    last = None
    with open(SYNC_LOG, encoding="utf-8", errors="replace") as f:
        for line in f:
            if "nothing new" in line or "punch(es) to the portal" in line:
                try: last = datetime.strptime(line[:19], "%Y-%m-%d %H:%M:%S")
                except ValueError: pass
    flag = LOG + ".syncdown"
    minutes = (datetime.now() - last).total_seconds() / 60 if last else None
    if minutes is not None and minutes <= SYNC_STALE_MIN:
        if os.path.exists(flag):
            os.remove(flag); log("SYNC BACK: punches are being read from the machine again")
        return True
    if not os.path.exists(flag):
        why = "No successful read of the attendance machine since %s." % (last.strftime("%d-%m %H:%M") if last else "the log began")
        log("SYNC STOPPED: " + why)
        popup("Machine sync has stopped.\n\n%s\n\nCheck that the machine is on (Net Mode Local) and that no other PC is reading it. Details: pull_machine.log" % why)
        open(flag, "w").write("1")
    return False


if __name__ == "__main__":
    site_ok = check()
    sync_ok = check_sync()
    sys.exit(0 if site_ok and sync_ok else 1)

"""Watches whether the biometric machine is sending data to this PC. Prints a line only when something changes.
Run:  python -u watch_machine.py [machine_ip]      (default 192.168.1.49)
Reads connector.log written by machine_connector.py, so keep the connector running too."""
import os, re, subprocess, sys, time
from datetime import datetime

MACHINE = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.49"
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "connector.log")
NO_DATA_AFTER = 300   # seconds of silence before we say so


def now():
    return datetime.now().strftime("%H:%M:%S")


def ping_ok():
    """One lost ping is common on Wi-Fi, so the machine counts as gone only after 3 failed pings in a row."""
    for _ in range(3):
        r = subprocess.run(["ping", "-n", "1", "-w", "800", MACHINE], capture_output=True, text=True)
        if "TTL=" in r.stdout and "unreachable" not in r.stdout:
            return True
        time.sleep(1)
    return False


def main():
    pos = os.path.getsize(LOG) if os.path.exists(LOG) else 0
    up = None
    last_msg = time.time()
    silent_said = False
    print("%s watching machine %s, log %s" % (now(), MACHINE, LOG), flush=True)
    while True:
        ok = ping_ok()
        if ok != up:
            print("%s MACHINE %s on the network" % (now(), "IS" if ok else "is NOT"), flush=True)
            up = ok
        if os.path.exists(LOG):
            size = os.path.getsize(LOG)
            if size < pos:
                pos = 0
            if size > pos:
                with open(LOG, encoding="utf-8", errors="replace") as f:
                    f.seek(pos)
                    chunk = f.read()
                    pos = f.tell()
                for line in chunk.splitlines():
                    m = re.search(r"punch saved: user (\S+) at (.+)", line)
                    if m:
                        print("%s *** NEW PUNCH from machine: user %s at %s" % (now(), m.group(1), m.group(2)), flush=True)
                        last_msg = time.time(); silent_said = False
                    elif "receive_cmd" in line or "realtime_glog" in line:
                        print("%s machine contacted the connector (%s)" % (now(), "command poll" if "receive_cmd" in line else "punch"), flush=True)
                        last_msg = time.time(); silent_said = False
                    elif "repeating an already stored punch" in line:
                        print("%s machine is RE-SENDING an old punch (reply not accepted)" % now(), flush=True)
                        last_msg = time.time(); silent_said = False
                    elif "bad request" in line:
                        print("%s bad request from machine: %s" % (now(), line[line.find("bad request"):][:160]), flush=True)
                    elif "sent " in line and "portal" in line:
                        print("%s connector -> website: %s" % (now(), line[20:]), flush=True)
                    elif "portal" in line and ("refused" in line or "not reachable" in line):
                        print("%s WEBSITE problem: %s" % (now(), line[20:][:160]), flush=True)
        if time.time() - last_msg > NO_DATA_AFTER and not silent_said:
            print("%s no message from the machine for %d s" % (now(), NO_DATA_AFTER), flush=True)
            silent_said = True
        time.sleep(5)


if __name__ == "__main__":
    main()

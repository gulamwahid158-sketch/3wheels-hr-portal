"""Biometric machine exports -> punches -> one attendance row per employee per day.

The CP Plus / ZK style machine export ("GLog") is a tab separated text file:
    No  Mchn  EnNo  Name  Mode  IOMd  DateTime
    000001  2  000000005  shiv prakash  33  0  2026/07/29  19:17:09
The machine does not say IN or OUT (IOMd is always 0), so for each day the first punch
is the check-in and the last punch is the check-out.
"""
import re
from datetime import datetime, timedelta

# A punch before this hour belongs to the previous day's shift (people finishing a night shift).
DAY_STARTS_AT = 7


def norm_id(value):
    """Machine user ids are zero padded ('000000005'); compare them without the padding."""
    s = str(value or "").strip()
    return str(int(s)) if s.isdigit() else s


def norm_name(value):
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def parse_glog(text):
    """Return (punches, bad_lines). punches = [{enno, name, machine, at}] in file order."""
    punches, bad = [], 0
    for line in str(text or "").splitlines():
        if not line.strip():
            continue
        cols = line.split("\t") if "\t" in line else line.split(",")
        cols = [c.strip() for c in cols]
        if len(cols) < 7 or not cols[0].isdigit():
            if cols and cols[0].lower() in ("no", "no."):  # header row
                continue
            bad += 1
            continue
        try:
            at = datetime.strptime(re.sub(r"\s+", " ", cols[6]), "%Y/%m/%d %H:%M:%S")
        except ValueError:
            bad += 1
            continue
        enno = norm_id(cols[2])
        if not enno:
            bad += 1
            continue
        punches.append({"enno": enno, "name": cols[3], "machine": cols[1], "at": at})
    return punches, bad


def attendance_day(at):
    """Which calendar day's attendance a punch counts for."""
    return (at - timedelta(hours=DAY_STARTS_AT)).date()


def derive_days(times):
    """times: datetimes of one person. Returns {'YYYY-MM-DD': ('HH:MM' first in, 'HH:MM' last out)}.

    A day made only of after-midnight punches has no check-in to hang them on, so it is skipped.
    last_out earlier than first_in therefore means the shift ended after midnight.
    """
    # the database layer hands DATETIME columns back as 'YYYY-MM-DD HH:MM:SS' text
    times = [t if isinstance(t, datetime) else datetime.strptime(str(t)[:19], "%Y-%m-%d %H:%M:%S") for t in times]
    groups = {}
    for t in sorted(set(times)):
        groups.setdefault(attendance_day(t), []).append(t)
    days = {}
    for day, ts in groups.items():
        if all(t.date() != day for t in ts):
            continue
        days[day.isoformat()] = (ts[0].strftime("%H:%M"), ts[-1].strftime("%H:%M"))
    return days


def work_minutes(first_in, last_out):
    """Minutes between two HH:MM strings, adding a day when the shift ran past midnight."""
    def m(t):
        h, mi = str(t).split(":")
        return int(h) * 60 + int(mi)
    d = m(last_out) - m(first_in)
    return d if d >= 0 else d + 24 * 60


# How a finished day is judged from its first and last punch (the machine has no in/out, so hours between them decide).
FULL_DAY_MIN = 6 * 60      # at least this long between first and last punch = Present
HALF_DAY_MIN = 3 * 60      # at least this long (but less than a full day) = Half Day; anything shorter, or one punch only = Leave


def classify(first_in, last_out):
    """'P' present, 'HD' half day, 'L' leave (too short, or a single punch)."""
    m = work_minutes(first_in, last_out)
    return "P" if m >= FULL_DAY_MIN else "HD" if m >= HALF_DAY_MIN else "L"


def suggest_employee(machine_name, employees):
    """Best guess for who a machine user is: the machine cuts names to ~14 characters, so match
    on the start of the portal name. Returns the employee id only when exactly one fits."""
    n = norm_name(machine_name)
    if not n:
        return None
    exact = [e for e in employees if norm_name(e["name"]) == n]
    if len(exact) == 1:
        return exact[0]["id"]
    hits = [e for e in employees if norm_name(e["name"]).startswith(n)]
    return hits[0]["id"] if len(hits) == 1 else None

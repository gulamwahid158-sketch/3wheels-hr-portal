import os, re, time, functools, smtplib, calendar, threading
from io import BytesIO
from concurrent.futures import ThreadPoolExecutor
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import date, timedelta, datetime
from flask import Flask, request, jsonify, session, send_from_directory, send_file
from werkzeug.security import check_password_hash, generate_password_hash
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
import pymysql
import db
import biometric
from designations import DESIGNATION_GROUPS, DESIGNATIONS, DEPARTMENTS

ROOT = os.path.join(os.path.dirname(__file__), "..", "frontend")
PORTAL_URL = os.environ.get("PORTAL_URL", "http://localhost:5000").rstrip("/")
app = Flask(__name__, static_folder=ROOT, static_url_path="")
app.secret_key = os.environ.get("SECRET_KEY", "dev-only-change-me")
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                  SESSION_COOKIE_SECURE=PORTAL_URL.startswith("https://"))
# Behind Render / nginx / any reverse proxy: trust X-Forwarded-* so https + host are right.
from werkzeug.middleware.proxy_fix import ProxyFix
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

EXEC_ROLES = ("ceo", "coo", "cpo", "executive", "superadmin")   # leadership tier
HR_LIKE_ROLES = ("hr", "admin")                                  # manage people, never executive accounts
ADMIN_ROLES = HR_LIKE_ROLES + ("ceo", "coo", "cpo", "executive", "superadmin")
ROLES = ("employee", "manager", "hr", "admin", "ceo", "coo", "cpo", "executive", "superadmin")
EMP_EXTRA_FIELDS = tuple(name for name, _ in db.EMPLOYEE_EXTRA_COLUMNS)


def send_welcome_email(to_email, name, emp_no, password, role, designation, department):
    subject = "Welcome to 3Wheels AI — Your Official Account Credentials"
    body_text = f"""Dear {name},

Welcome to 3Wheels AI!

Your official employee account has been created by HR. You can now log in to the 3Wheels AI portal using your official credentials below:

- Portal URL: {PORTAL_URL}
- Official Email: {to_email}
- Employee ID: {emp_no}
- Temporary Password: {password}
- Designation: {designation}
- Department: {department}
- Role: {role.upper()}

Please sign in and set up your workspace. Keep these credentials confidential.

Best regards,
People Operations & HR Team
3Wheels AI
"""
    try:
        run("INSERT INTO email_outbox(to_email, subject, body) VALUES(?, ?, ?)",
            (to_email, subject, body_text))
    except Exception as e:
        print(f"[Outbox Warning] Could not log email: {e}")

    smtp_host = os.environ.get("SMTP_HOST")
    if smtp_host:
        try:
            smtp_port = int(os.environ.get("SMTP_PORT", 587))
            smtp_user = os.environ.get("SMTP_USER")
            smtp_pass = os.environ.get("SMTP_PASS")
            msg = MIMEMultipart()
            msg["From"] = os.environ.get("SMTP_FROM", smtp_user or "hr@3wheels.ai")
            msg["To"] = to_email
            msg["Subject"] = subject
            msg.attach(MIMEText(body_text, "plain"))
            with smtplib.SMTP(smtp_host, smtp_port, timeout=5) as s:
                s.starttls()
                if smtp_user and smtp_pass:
                    s.login(smtp_user, smtp_pass)
                s.send_message(msg)
        except Exception as ex:
            print(f"[SMTP Warning] Could not dispatch remote email: {ex}")
    else:
        print(f"[OFFICIAL EMAIL DISPATCHED] To: {to_email} | Subject: {subject} | ID: {emp_no}")
    return True


def q(sql, args=(), one=False):
    c = db.conn()
    rows = [dict(r) for r in c.execute(sql, args).fetchall()]
    c.close()
    return (rows[0] if rows else None) if one else rows


def run(sql, args=()):
    c = db.conn()
    cur = c.execute(sql, args)
    c.commit(); lid = cur.lastrowid; c.close()
    if "employees" in sql[:60].lower(): _ME_CACHE.clear()          # someone's row changed: forget the remembered users
    _SETTLED.clear()                                                # data changed: attendance is settled afresh on the next read
    return lid


_POOLX = ThreadPoolExecutor(max_workers=6)
_IN_POOL = threading.local()


def _in_pool(call):
    _IN_POOL.on = True
    try: return call()
    finally: _IN_POOL.on = False


def par(*calls):
    """Run independent database reads at the same time and return their results in order.
    The database is remote (~60-200 ms per trip), so N reads one after another cost N trips, side by side about one.
    Each call must only use q()/db.conn() with values worked out beforehand (no request or session inside).
    A par() started from inside another par() runs its calls one by one, so the pool can never wait on itself."""
    if len(calls) == 1 or getattr(_IN_POOL, "on", False): return [c() for c in calls]
    futs = [_POOLX.submit(_in_pool, c) for c in calls]
    return [f.result() for f in futs]


_SETTLED = {}         # (employees, month, today) -> time of the last settle_days run, so page loads in quick succession do not repeat it
SETTLE_TTL = 60


_ME_CACHE = {}        # uid -> (time, row): the signed-in user's row is read on every request, and each database trip costs ~60 ms
ME_TTL = 3.0


def me():
    uid = session.get("uid")
    if not uid: return None
    hit = _ME_CACHE.get(uid)
    if hit and time.monotonic() - hit[0] < ME_TTL: return dict(hit[1])
    row = q("SELECT * FROM employees WHERE id=? AND active=1", (uid,), one=True)
    if row: _ME_CACHE[uid] = (time.monotonic(), row)
    else: _ME_CACHE.pop(uid, None)
    return dict(row) if row else None


def auth(roles=None):
    def deco(fn):
        @functools.wraps(fn)
        def w(*a, **k):
            u = me()
            if not u: return jsonify(error="Login required"), 401
            if roles and u["role"] not in roles: return jsonify(error="Forbidden"), 403
            return fn(u, *a, **k)
        return w
    return deco


def body(*req):
    j = request.get_json(silent=True) or {}
    miss = [r for r in req if j.get(r) in (None, "")]
    if miss: raise ValueError("Missing: " + ", ".join(miss))
    return j


@app.errorhandler(pymysql.err.OperationalError)
def db_unavailable(e):
    # e.g. hosted MySQL connection limit reached, or the database is unreachable
    print("[DB error]", e)
    return jsonify(error="The database is busy or unreachable. Please try again in a few minutes."), 503


@app.after_request
def cache_static(resp):
    if request.path.endswith((".js", ".css")) and resp.status_code == 200: resp.headers["Cache-Control"] = "public, max-age=300"
    return resp


@app.errorhandler(ValueError)
def bad(e): return jsonify(error=str(e)), 400


def approver_of(u):
    if u["manager_id"]: return u["manager_id"]
    cpo = q("SELECT id FROM employees WHERE role='cpo' AND active=1 AND id!=? LIMIT 1", (u["id"],), one=True)
    if cpo: return cpo["id"]
    ceo = q("SELECT id FROM employees WHERE role='ceo' AND active=1 AND id!=? LIMIT 1", (u["id"],), one=True)
    if ceo: return ceo["id"]
    hr = q("SELECT id FROM employees WHERE role='hr' AND active=1 AND id!=? LIMIT 1", (u["id"],), one=True)
    return hr["id"] if hr else u["id"]


def notify(emp_id, text):
    run("INSERT INTO notifications(emp_id,text) VALUES(?,?)", (emp_id, text))


def pdate(s):
    try: return date.fromisoformat(s)
    except Exception: raise ValueError("Invalid date: %s" % s)


def count_days(f, t, fs=1, ts=2):
    f, t = pdate(f), pdate(t)
    if t < f: raise ValueError("To date must be on/after From date")
    hol = {h["date"] for h in q("SELECT date FROM holidays WHERE restricted=0")}
    n, d_ = 0.0, f
    while d_ <= t:
        if d_.weekday() != 6 and d_.isoformat() not in hol: n += 1
        d_ += timedelta(days=1)
    if n and fs == 2: n -= 0.5
    if n and ts == 1: n -= 0.5
    return max(n, 0)


_LT = [0.0, []]


def leave_types_cached():
    if time.monotonic() - _LT[0] > 60: _LT[1] = q("SELECT * FROM leave_types"); _LT[0] = time.monotonic()
    return _LT[1]


def balances(emp_id):
    out = []
    grants = {}
    grant_rows, spent_rows = par(lambda: q("SELECT * FROM leave_grants WHERE emp_id=? ORDER BY id", (emp_id,)),
                                 lambda: q("SELECT code, COALESCE(SUM(days),0) s FROM requests WHERE emp_id=? AND kind IN('leave','rh') AND status IN('approved','pending') GROUP BY code", (emp_id,)))
    for g_ in grant_rows: grants.setdefault(g_["code"], g_)      # 2 trips side by side, not 2 per leave type (the database is remote)
    spent = {r["code"]: r["s"] for r in spent_rows}
    for t in leave_types_cached():
        g = grants.get(t["code"]) or {"granted": 0, "opening_used": 0}
        used = spent.get(t["code"], 0)
        consumed = g["opening_used"] + used
        out.append(dict(code=t["code"], name=t["name"], granted=g["granted"], consumed=consumed, balance=g["granted"] - consumed))
    return out


# ---------- auth ----------
@app.post("/api/login")
def login():
    j = body("email", "password")
    u = q("SELECT * FROM employees WHERE email=? AND active=1", (j["email"].strip().lower(),), one=True)
    if not u or not check_password_hash(u["password_hash"], j["password"]):
        return jsonify(error="Invalid email or password"), 401
    session["uid"] = u["id"]
    return jsonify(ok=True)


@app.post("/api/logout")
def logout(): session.clear(); return jsonify(ok=True)


@app.get("/api/me")
@auth()
def whoami(u):
    u.pop("password_hash")
    mgr, unread, pending = par(lambda: q("SELECT name FROM employees WHERE id=?", (u["manager_id"],), one=True),
                               lambda: q("SELECT COUNT(*) c FROM notifications WHERE emp_id=? AND is_read=0", (u["id"],), one=True),
                               lambda: pending_review_count(u))
    u["manager_name"] = mgr["name"] if mgr else None
    u["unread"] = unread["c"]
    u["pending_reviews"] = pending
    return jsonify(u)


@app.get("/api/approval-info")
@auth()
def approval_info(u):
    """Who can approve this employee's leave/regularization requests: their reporting
    manager (if any) plus HR Head/CEO/COO/CPO, who can always step in as backup approvers."""
    manager = None
    if u["manager_id"]:
        m = q("SELECT id,name,designation FROM employees WHERE id=? AND active=1", (u["manager_id"],), one=True)
        if m: manager = {"id": m["id"], "name": m["name"], "designation": m["designation"]}
    backups = q("""
        SELECT id, name, role, designation FROM employees
        WHERE active=1 AND id!=? AND role IN ('hr','admin','ceo','coo','cpo','executive')
        ORDER BY CASE role WHEN 'hr' THEN 0 WHEN 'admin' THEN 1 WHEN 'ceo' THEN 2 WHEN 'coo' THEN 3 WHEN 'cpo' THEN 4 WHEN 'executive' THEN 5 ELSE 6 END, name
    """, (u["id"],))
    return jsonify(manager=manager, backups=backups)


@app.get("/api/notifications")
@auth()
def notifs(u):
    r = q("SELECT * FROM notifications WHERE emp_id=? ORDER BY id DESC LIMIT 50", (u["id"],))
    run("UPDATE notifications SET is_read=1 WHERE emp_id=?", (u["id"],))
    return jsonify(r)


# ---------- home ----------
@app.get("/api/home")
@auth()
def home(u):
    today = date.today().isoformat()
    md = date.today().strftime("%m-%d")
    hol, bal, pend, pay, tasks_, bdays, track = par(
        lambda: q("SELECT * FROM holidays WHERE date>=? ORDER BY date LIMIT 3", (today,)),
        lambda: balances(u["id"]),
        lambda: pending_review_count(u),
        lambda: q("SELECT * FROM payslips WHERE emp_id=? ORDER BY month DESC LIMIT 1", (u["id"],), one=True),
        lambda: q("SELECT * FROM tasks WHERE emp_id=? AND done=0 ORDER BY due_date LIMIT 5", (u["id"],)),
        lambda: q("SELECT name,dob FROM employees WHERE substr(dob,6,5)=? AND active=1", (md,)),
        lambda: q("SELECT kind,status,created_at FROM requests WHERE emp_id=? ORDER BY id DESC LIMIT 3", (u["id"],)))
    return jsonify(holidays=hol, balances=bal, pending_reviews=pend, payslip=pay, tasks=tasks_, birthdays=bdays, tracking=track)


# ---------- leave ----------
@app.get("/api/leave/balances")
@auth()
def leave_balances(u): return jsonify(balances(u["id"]))


@app.get("/api/leave/types")
@auth()
def leave_types(u): return jsonify(q("SELECT * FROM leave_types"))


@app.get("/api/leave/requests")
@auth()
def leave_requests(u):
    kind = request.args.get("kind")
    sql, a = "SELECT * FROM requests WHERE emp_id=?", [u["id"]]
    if kind: sql += " AND kind=?"; a.append(kind)
    return jsonify(q(sql + " ORDER BY id DESC", a))


@app.post("/api/leave/apply")
@auth()
def leave_apply(u):
    j = body("code", "from_date", "to_date", "reason")
    fs, ts = int(j.get("from_session", 1)), int(j.get("to_session", 2))
    t = q("SELECT * FROM leave_types WHERE code=? AND kind IN('leave','compoff','lop')", (j["code"],), one=True)
    if not t: raise ValueError("Unknown leave type")
    days = count_days(j["from_date"], j["to_date"], fs, ts)
    if days <= 0: raise ValueError("Selected dates have no working days")
    clash = q("SELECT id FROM requests WHERE emp_id=? AND kind IN('leave','rh') AND status IN('pending','approved') AND from_date<=? AND to_date>=?", (u["id"], j["to_date"], j["from_date"]), one=True)
    if clash: raise ValueError("You already have leave overlapping these dates")
    if j["code"] != "LOP":
        bal = next(b for b in balances(u["id"]) if b["code"] == j["code"])["balance"]
        if days > bal: raise ValueError("Insufficient %s balance (%.1f available, %.1f requested)" % (t["name"], bal, days))
    approver = int(j.get("approver_id") or approver_of(u))
    rid = run("INSERT INTO requests(emp_id,kind,code,from_date,to_date,from_session,to_session,days,reason,approver_id,contact) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
              (u["id"], "leave", j["code"], j["from_date"], j["to_date"], fs, ts, days, j["reason"], approver, str(j.get("contact") or "").strip()[:120] or None))
    if u["role"] == "superadmin":
        # nobody sits above the superadmin: the leave is approved on the spot, no one else is asked
        run("UPDATE requests SET status='approved',decided_at=?,approver_id=?,remark=? WHERE id=?",
            (datetime.now().isoformat(), u["id"], "Auto-approved (superadmin)", rid))
        d_, t_ = pdate(j["from_date"]), pdate(j["to_date"])
        while d_ <= t_:
            run("UPDATE attendance SET status=? WHERE emp_id=? AND date=? AND status NOT IN('H','O')", (j["code"] if j["code"] != "LOP" else "A", u["id"], d_.isoformat()))
            d_ += timedelta(days=1)
        return jsonify(id=rid, days=days, auto_approved=True)
    notify(approver, "%s applied for %s leave (%.1f day(s))" % (u["name"], t["name"], days))
    return jsonify(id=rid, days=days)


@app.post("/api/leave/rh")
@auth()
def rh_apply(u):
    j = body("date", "reason")
    h = q("SELECT * FROM holidays WHERE date=? AND restricted=1", (j["date"],), one=True)
    if not h: raise ValueError("That date is not a restricted holiday")
    if q("SELECT COUNT(*) c FROM requests WHERE emp_id=? AND kind='rh' AND status IN('pending','approved')", (u["id"],), one=True)["c"] >= 2:
        raise ValueError("Restricted holiday limit (2) reached")
    rid = run("INSERT INTO requests(emp_id,kind,code,from_date,to_date,days,reason,approver_id) VALUES(?,?,?,?,?,?,?,?)",
              (u["id"], "rh", "RH", j["date"], j["date"], 0, j["reason"], int(j.get("approver_id") or approver_of(u))))
    return jsonify(id=rid)


@app.post("/api/leave/compoff")
@auth()
def compoff_grant(u):
    j = body("date", "reason")
    a = q("SELECT * FROM attendance WHERE emp_id=? AND date=?", (u["id"], j["date"]), one=True)
    if not a or a["status"] not in ("O", "H") or not a["first_in"]:
        raise ValueError("Comp-off needs work recorded on an off day or holiday")
    rid = run("INSERT INTO requests(emp_id,kind,code,from_date,to_date,days,reason,approver_id) VALUES(?,?,?,?,?,?,?,?)",
              (u["id"], "compoff_grant", "CO", j["date"], j["date"], 1, j["reason"], int(j.get("approver_id") or approver_of(u))))
    return jsonify(id=rid)


@app.post("/api/leave/cancel")
@auth()
def leave_cancel(u):
    j = body("request_id", "reason")
    r = q("SELECT * FROM requests WHERE id=? AND emp_id=? AND kind IN('leave','rh')", (j["request_id"], u["id"]), one=True)
    if not r: raise ValueError("Leave not found")
    if r["status"] not in ("approved", "pending"): raise ValueError("Only pending/approved leave can be cancelled")
    if r["status"] == "pending":
        run("UPDATE requests SET status='cancelled',decided_at=? WHERE id=?", (datetime.now().isoformat(), r["id"]))
        return jsonify(status="cancelled")
    if q("SELECT id FROM requests WHERE kind='cancel' AND ref_id=? AND status='pending'", (r["id"],), one=True):
        raise ValueError("Cancellation already requested")
    rid = run("INSERT INTO requests(emp_id,kind,code,from_date,to_date,days,reason,ref_id,approver_id) VALUES(?,?,?,?,?,?,?,?,?)",
              (u["id"], "cancel", r["code"], r["from_date"], r["to_date"], r["days"], j["reason"], r["id"], int(j.get("approver_id") or approver_of(u))))
    return jsonify(id=rid, status="pending")


@app.get("/api/leave/calendar")
@auth()
def leave_cal(u):
    m = request.args.get("month", date.today().strftime("%Y-%m"))
    return jsonify(
        mine=q("SELECT r.*, e.name FROM requests r JOIN employees e ON e.id=r.emp_id WHERE r.kind='leave' AND r.status='approved' AND r.emp_id=? AND substr(r.from_date,1,7)<=? AND substr(r.to_date,1,7)>=?", (u["id"], m, m)),
        team=q("SELECT r.*, e.name FROM requests r JOIN employees e ON e.id=r.emp_id WHERE r.kind='leave' AND r.status='approved' AND r.emp_id!=? AND e.department=(SELECT department FROM employees WHERE id=?) AND substr(r.from_date,1,7)<=? AND substr(r.to_date,1,7)>=?", (u["id"], u["id"], m, m)),
        holidays=q("SELECT * FROM holidays WHERE substr(date,1,7)=?", (m,)))


@app.get("/api/holidays")
@auth()
def holidays(u): return jsonify(q("SELECT * FROM holidays ORDER BY date"))


# ---------- attendance ----------
@app.get("/api/attendance")
@auth()
def attendance(u):
    m = request.args.get("month", date.today().strftime("%Y-%m"))
    try: datetime.strptime(m, "%Y-%m")
    except ValueError: raise ValueError("Invalid month, expected YYYY-MM")
    settle_days([u["id"]], m)          # no punch = Leave, short day = Half Day, before the month is read
    rows = q("SELECT * FROM attendance WHERE emp_id=? AND substr(date,1,7)=? ORDER BY date", (u["id"], m))
    work = [r for r in rows if r["status"] == "P"]

    def mins(t): h, mi = t.split(":"); return int(h) * 60 + int(mi)
    avg_in = sum(mins(r["first_in"]) for r in work) / len(work) if work else 0
    avg_out = sum(mins(r["last_out"]) for r in work) / len(work) if work else 0
    avg_work = sum(biometric.work_minutes(r["first_in"], r["last_out"]) for r in work) / len(work) if work else 0  # night shifts end after midnight
    fmt = lambda x: "%02d:%02d" % divmod(int(x), 60)
    sm = re.match(r"^(\d{1,2}):(\d{2})-", u["shift"] or "")      # "Flexible" has no start time, so nobody is late
    shift_start = int(sm.group(1)) * 60 + int(sm.group(2)) if sm else None
    summary = dict(present=len(work), absent=sum(r["status"] == "A" for r in rows), leave=sum(r["status"] in ("CL", "L", "CO") for r in rows),
                   half_day=sum(r["status"] == "HD" for r in rows),
                   holidays=sum(r["status"] == "H" for r in rows), late_in=sum(mins(r["first_in"]) > shift_start + 15 for r in work) if shift_start is not None else 0,
                   avg_first_in=fmt(avg_in) if work else "-", avg_last_out=fmt(avg_out) if work else "-",
                   avg_work_hrs=("%.2f" % (avg_work / 60)) if work else "-")
    exc = [r["date"] for r in rows if r["status"] in ("A", "L", "HD")]      # days that can be regularized
    return jsonify(days=rows, summary=summary, exceptions=exc, shift=u["shift"])


@app.post("/api/regularization")
@auth()
def regularize(u):
    j = body("kind", "date", "reason")
    if j["kind"] not in ("regularize", "permission"): raise ValueError("Invalid kind")
    if pdate(j["date"]) > date.today(): raise ValueError("Cannot regularize a future date")
    if j["kind"] == "regularize" and not (j.get("in_time") and j.get("out_time")): raise ValueError("In and out time required")
    if q("SELECT id FROM regularizations WHERE emp_id=? AND date=? AND kind=? AND status='pending'", (u["id"], j["date"], j["kind"]), one=True):
        raise ValueError("A request for this date is already pending")
    approver = int(j.get("approver_id") or approver_of(u))
    rid = run("INSERT INTO regularizations(emp_id,kind,date,in_time,out_time,reason,approver_id) VALUES(?,?,?,?,?,?,?)",
              (u["id"], j["kind"], j["date"], j.get("in_time"), j.get("out_time"), j["reason"], approver))
    notify(approver, "%s requested %s for %s" % (u["name"], j["kind"], j["date"]))
    return jsonify(id=rid)


@app.get("/api/regularization")
@auth()
def regs(u): return jsonify(q("SELECT r.*, a.name approver_name FROM regularizations r LEFT JOIN employees a ON a.id=r.approver_id WHERE r.emp_id=? ORDER BY r.id DESC", (u["id"],)))


# ---------- salary ----------
@app.get("/api/payslips")
@auth()
def payslips(u): return jsonify(q("SELECT * FROM payslips WHERE emp_id=? ORDER BY month DESC", (u["id"],)))

@app.post("/api/payslip-request")
@auth()
def payslip_request(u):
    j = body("month")
    run("INSERT INTO payslip_requests(emp_id,month) VALUES(?,?)", (u["id"], j["month"]))
    accs = q("SELECT id,email,name FROM employees WHERE role='accounts' AND active=1")
    for a in accs:
        notify(a["id"], "%s requested payslip for %s" % (u["name"], j["month"]))
    return jsonify(ok=True)

@app.get("/api/payslip-requests")
@auth()
def payslip_requests_list(u):
    if u["role"] not in ("accounts",) + ADMIN_ROLES:
        return jsonify(error="Forbidden"), 403
    rows = q("""SELECT pr.id, pr.month, pr.status, pr.created_at, e.emp_no, e.name, e.designation, e.department
                FROM payslip_requests pr JOIN employees e ON e.id=pr.emp_id WHERE pr.status='pending' ORDER BY pr.id DESC""")
    return jsonify(rows)

@app.get("/api/my-payslip-requests")
@auth()
def my_payslip_requests(u):
    rows = q("SELECT id, month, status, file_path, created_at FROM payslip_requests WHERE emp_id=? AND status='sent' ORDER BY id DESC", (u["id"],))
    return jsonify(rows)

import os as _os
UPLOAD_DIR = _os.path.join(_os.path.dirname(__file__), "uploads")
_os.makedirs(UPLOAD_DIR, exist_ok=True)

@app.post("/api/payslip-requests/<int:rid>/send")
@auth()
def payslip_requests_send(u, rid):
    if u["role"] not in ("accounts",) + ADMIN_ROLES:
        return jsonify(error="Forbidden"), 403
    pr = q("SELECT * FROM payslip_requests WHERE id=?", (rid,), one=True)
    if not pr: return jsonify(error="Not found"), 404
    emp = q("SELECT id,email,name FROM employees WHERE id=?", (pr["emp_id"],), one=True)
    f = request.files.get("file")
    path = None
    if f and f.filename:
        path = _os.path.join(UPLOAD_DIR, "%d_%s" % (rid, f.filename))
        f.save(path)
    run("UPDATE payslip_requests SET status='sent', file_path=? WHERE id=?", (path, rid))
    notify(pr["emp_id"], "Your payslip for %s is ready to download." % pr["month"])
    try:
        import smtplib
        from email.message import EmailMessage
        host = _os.environ.get("SMTP_HOST")
        if host and emp:
            m = EmailMessage()
            m["Subject"] = "Payslip ready: %s" % pr["month"]
            m["From"] = _os.environ.get("SMTP_FROM", "noreply@example.com")
            m["To"] = emp["email"]
            m.set_content("Your payslip for %s is ready. Download from portal." % pr["month"])
            with smtplib.SMTP(host, int(_os.environ.get("SMTP_PORT", "587"))) as s:
                s.starttls()
                s.login(_os.environ.get("SMTP_USER",""), _os.environ.get("SMTP_PASS",""))
                s.send_message(m)
    except Exception:
        pass
    return jsonify(ok=True)

@app.get("/api/payslip-download/<int:rid>")
@auth()
def payslip_download(u, rid):
    pr = q("SELECT * FROM payslip_requests WHERE id=?", (rid,), one=True)
    if not pr or not pr.get("file_path"): return jsonify(error="Not found"), 404
    if u["id"] != pr["emp_id"] and u["role"] != "accounts":
        return jsonify(error="Forbidden"), 403
    run("UPDATE payslip_requests SET downloaded=1 WHERE id=?", (rid,))
    from flask import send_file
    return send_file(pr["file_path"], as_attachment=True)


@app.get("/api/ytd")
@auth()
def ytd(u):
    r = q("SELECT COUNT(*) months,SUM(basic) basic,SUM(hra) hra,SUM(allowances) allowances,SUM(pf) pf,SUM(tax) tax,SUM(pt) pt,SUM(net) net FROM payslips WHERE emp_id=? AND month>=?", (u["id"], "2026-04"), one=True)
    return jsonify(r)


@app.get("/api/it-statement")
@auth()
def it_statement(u):
    dec = q("SELECT section,SUM(amount) amount FROM it_declarations WHERE emp_id=? GROUP BY section", (u["id"],))
    gross = q("SELECT COALESCE(SUM(basic+hra+allowances),0) g, COALESCE(SUM(tax),0) t FROM payslips WHERE emp_id=?", (u["id"],), one=True)
    return jsonify(gross=gross["g"], tax_deducted=gross["t"], declarations=dec)


def simple_resource(path, table, fields, required, extra_status=None):
    def lst(u):
        return jsonify(q("SELECT * FROM %s WHERE emp_id=? ORDER BY id DESC" % table, (u["id"],)))

    def add(u):
        j = body(*required)
        cols = ["emp_id"] + fields; vals = [u["id"]] + [j.get(f) for f in fields]
        if "approver_id" in db.columns(table):
            cols.append("approver_id"); vals.append(approver_of(u))
        for f in ("amount", "tenure_months"):
            if f in fields and float(j.get(f) or 0) <= 0: raise ValueError("%s must be positive" % f)
        rid = run("INSERT INTO %s(%s) VALUES(%s)" % (table, ",".join(cols), ",".join("?" * len(cols))), vals)
        return jsonify(id=rid)
    app.add_url_rule("/api/" + path, "list_" + path, auth()(lst), methods=["GET"])
    app.add_url_rule("/api/" + path, "add_" + path, auth()(add), methods=["POST"])


simple_resource("it-declaration", "it_declarations", ["fy", "section", "description", "amount"], ["fy", "section", "amount"])
simple_resource("poi", "poi", ["fy", "section", "description", "amount", "proof_note"], ["fy", "section", "amount"])
simple_resource("reimbursement", "reimbursements", ["category", "amount", "bill_date", "description"], ["category", "amount", "bill_date"])
simple_resource("loans", "loans", ["amount", "tenure_months", "reason"], ["amount", "tenure_months", "reason"])
simple_resource("tickets", "tickets", ["category", "subject", "body"], ["category", "subject", "body"])
simple_resource("resignation", "resignations", ["last_day", "reason"], ["last_day", "reason"])


@app.get("/api/salary-revisions")
@auth()
def revisions(u): return jsonify(q("SELECT * FROM salary_revisions WHERE emp_id=? ORDER BY effective_from DESC", (u["id"],)))


# ---------- documents / people ----------
@app.get("/api/documents")
@auth()
def docs(u): return jsonify(q("SELECT * FROM documents WHERE emp_id=? OR emp_id IS NULL ORDER BY id DESC", (u["id"],)))


@app.get("/api/designations")
@auth()
def designations_master(u):
    return jsonify(
        groups=DESIGNATION_GROUPS,
        flat=DESIGNATIONS,
        departments=DEPARTMENTS,
    )


@app.get("/api/people")
@auth()
def people(u):
    s = "%" + request.args.get("q", "") + "%"
    # five independent reads run side by side: the list, everyone's direct reports, CL grants, CL used, and all names
    rows, all_reports, grant_rows, used_rows, name_rows = par(
        lambda: q("SELECT id,emp_no,biometric_id,name,email,department,designation,location,join_date,substr(dob,6) dob,skills,manager_id,role FROM employees WHERE active=1 AND (name LIKE ? OR department LIKE ? OR emp_no LIKE ?) ORDER BY name", (s, s, s)),
        lambda: q("SELECT id, name, manager_id FROM employees WHERE active=1 AND manager_id IS NOT NULL"),
        lambda: q("SELECT * FROM leave_grants WHERE code='CL'"),
        lambda: q("SELECT emp_id, COALESCE(SUM(days),0) s FROM requests WHERE code='CL' AND kind IN('leave','rh') AND status IN('approved','pending') GROUP BY emp_id"),
        lambda: q("SELECT id, name FROM employees"))
    report_map = {}
    for r in all_reports:
        report_map.setdefault(r["manager_id"], []).append(r["name"])
    cl_grants = {g["emp_id"]: g for g in grant_rows}
    cl_used = {u_row["emp_id"]: u_row["s"] for u_row in used_rows}
    names = {e["id"]: e["name"] for e in name_rows}      # one query, not one per person (the database is remote)
    for r in rows:
        r["manager_name"] = names.get(r["manager_id"])
        team = report_map.get(r["id"], [])
        r["team_size"] = len(team)
        r["team_members"] = team

        g = cl_grants.get(r["id"])
        granted = g["granted"] if g else 0.0
        opening = g["opening_used"] if g else 0.0
        used = cl_used.get(r["id"], 0.0)
        r["cl_balance"] = round(granted - (opening + used), 1)

    return jsonify(rows)


@app.get("/api/people/teams")
@auth()
def people_teams(u):
    managers = q("""
        SELECT m.id, m.emp_no, m.name, m.email, m.department, m.designation, m.location, m.role,
               COUNT(e.id) team_size
        FROM employees m
        JOIN employees e ON e.manager_id = m.id
        WHERE m.active = 1 AND e.active = 1
        GROUP BY m.id
        ORDER BY team_size DESC, m.name ASC
    """)
    for m in managers:
        m["members"] = q("""
            SELECT id, emp_no, name, email, department, designation, location, role, join_date
            FROM employees
            WHERE manager_id = ? AND active = 1
            ORDER BY name ASC
        """, (m["id"],))
    return jsonify(managers)


@app.get("/api/orgchart")
@auth()
def org(u): return jsonify(q("SELECT id,emp_no,name,designation,manager_id,role,department FROM employees WHERE active=1"))


# ---------- engage ----------
REACTION_EMOJIS = ("👍", "❤️", "🎉", "👏", "😮")
_REACT_KEY = re.compile(r"^(post:\d+|kudos:\d+|bday:\d{4}-\d{2}-\d{2}:\d+)$")


@app.get("/api/feed")
@auth()
def feed(u):
    """One timeline for the Engage page: posts, polls, kudos and automatic birthday
    posts (today and the last 7 days), newest first, each with its reactions."""
    items = []
    vote_rows, my_vote_rows, post_rows, kudos_rows, bday_rows, react_rows, mine_rows = par(      # seven independent reads, one trip's time
        lambda: q("SELECT post_id, `option`, COUNT(*) c FROM poll_votes GROUP BY post_id, `option`"),
        lambda: q("SELECT post_id, `option` FROM poll_votes WHERE emp_id=?", (u["id"],)),
        lambda: q("SELECT p.*, e.name author, e.location, e.department FROM posts p JOIN employees e ON e.id=p.author_id"),
        lambda: q("SELECT k.*, a.name from_name, b.name to_name, b.location, b.department FROM kudos k "
                  "JOIN employees a ON a.id=k.from_id JOIN employees b ON b.id=k.to_id"),
        lambda: q("SELECT id, name, dob, location, department, designation FROM employees WHERE active=1 AND dob IS NOT NULL AND dob<>''"),
        lambda: q("SELECT item_key, emoji, COUNT(*) c FROM reactions GROUP BY item_key, emoji"),
        lambda: q("SELECT item_key, emoji FROM reactions WHERE emp_id=?", (u["id"],)))

    votes = {}
    for v in vote_rows:
        votes.setdefault(v["post_id"], {})[v["option"]] = v["c"]
    my_votes = {v["post_id"]: v["option"] for v in my_vote_rows}
    for p in post_rows:
        item = dict(p, key="post:%d" % p["id"], kind=p["type"], group="Announcements")
        if p["type"] == "poll":
            item["results"] = votes.get(p["id"], {})
            item["my_vote"] = my_votes.get(p["id"])
        items.append(item)

    for k in kudos_rows:
        items.append(dict(k, key="kudos:%d" % k["id"], kind="kudos", group="Recognition", author=k["from_name"], body=k["message"]))

    today = date.today()
    for e in bday_rows:
        for year in (today.year, today.year - 1):  # a birthday just before New Year is still recent in January
            try:
                when = date(year, int(e["dob"][5:7]), int(e["dob"][8:10]))
            except (ValueError, IndexError):
                break
            if 0 <= (today - when).days <= 7:
                items.append(dict(key="bday:%s:%d" % (when.isoformat(), e["id"]), kind="birthday", group="Events",
                                  # end of that day, so a birthday sits above the other items of the same day
                                  id=e["id"], author=e["name"], body="", created_at=when.isoformat() + " 23:59:59",
                                  location=e["location"], department=e["department"], designation=e["designation"]))
                break

    counts = {}
    for r in react_rows:
        counts.setdefault(r["item_key"], {})[r["emoji"]] = r["c"]
    mine = {r["item_key"]: r["emoji"] for r in mine_rows}
    for it in items:
        it["reactions"] = counts.get(it["key"], {})
        it["my_reaction"] = mine.get(it["key"])

    items.sort(key=lambda x: str(x["created_at"]), reverse=True)
    return jsonify(items[:200])


@app.post("/api/react")
@auth()
def react(u):
    """Set, change or (with an empty emoji) remove the caller's reaction on a feed item."""
    j = body("key")
    key, emoji = str(j["key"]), j.get("emoji")
    if not _REACT_KEY.match(key): raise ValueError("Invalid item")
    if emoji in (None, ""):
        run("DELETE FROM reactions WHERE item_key=? AND emp_id=?", (key, u["id"]))
        return jsonify(ok=True)
    if emoji not in REACTION_EMOJIS: raise ValueError("Invalid reaction")
    run("REPLACE INTO reactions(item_key,emp_id,emoji) VALUES(?,?,?)", (key, u["id"], emoji))
    return jsonify(ok=True)


@app.post("/api/feed")
@auth()
def post_feed(u):
    j = body("body")
    t = j.get("type", "post")
    opts = None
    if t == "poll":
        o = [x.strip() for x in j.get("options", []) if x.strip()]
        if not 2 <= len(o) <= 7: raise ValueError("A poll needs 2 to 7 options")
        opts = "|".join(o)
    return jsonify(id=run("INSERT INTO posts(author_id,type,body,options) VALUES(?,?,?,?)", (u["id"], t, j["body"], opts)))


@app.post("/api/feed/<int:pid>/vote")
@auth()
def vote(u, pid):
    j = body("option")
    p = q("SELECT * FROM posts WHERE id=? AND type='poll'", (pid,), one=True)
    if not p or j["option"] not in (p["options"] or "").split("|"): raise ValueError("Invalid poll option")
    run("REPLACE INTO poll_votes(post_id,emp_id,`option`) VALUES(?,?,?)", (pid, u["id"], j["option"]))
    return jsonify(ok=True)


@app.get("/api/kudos")
@auth()
def kudos_list(u):
    return jsonify(q("SELECT k.*, a.name from_name, b.name to_name FROM kudos k JOIN employees a ON a.id=k.from_id JOIN employees b ON b.id=k.to_id ORDER BY k.id DESC"))


@app.post("/api/kudos")
@auth()
def kudos_give(u):
    j = body("to_id", "value", "message")
    if int(j["to_id"]) == u["id"]: raise ValueError("You cannot give kudos to yourself")
    if not q("SELECT id FROM employees WHERE id=?", (j["to_id"],), one=True): raise ValueError("Employee not found")
    rid = run("INSERT INTO kudos(from_id,to_id,value,message) VALUES(?,?,?,?)", (u["id"], j["to_id"], j["value"], j["message"]))
    notify(int(j["to_id"]), "%s gave you kudos for %s" % (u["name"], j["value"]))
    return jsonify(id=rid)


@app.get("/api/feedback")
@auth()
def feedback_list(u):
    return jsonify(dict(
        received=q("SELECT f.id,f.message,f.created_at FROM feedback f WHERE to_id=? ORDER BY id DESC", (u["id"],)),  # sender hidden
        given=q("SELECT f.*, b.name to_name FROM feedback f JOIN employees b ON b.id=f.to_id WHERE from_id=? ORDER BY f.id DESC", (u["id"],))))


@app.post("/api/feedback")
@auth()
def feedback_give(u):
    j = body("to_id", "message")
    to_id = int(j["to_id"])
    if to_id == u["id"]: raise ValueError("You cannot give feedback to yourself")
    if not q("SELECT id FROM employees WHERE id=? AND active=1", (to_id,), one=True): raise ValueError("Employee not found")
    run("INSERT INTO feedback(from_id,to_id,message) VALUES(?,?,?)", (u["id"], to_id, j["message"]))
    if j.get("request_id"):  # answering someone's feedback request
        run("UPDATE feedback_requests SET status='answered', answered_at=? WHERE id=? AND to_id=? AND from_id=? AND status='pending'",
            (datetime.now().isoformat(), int(j["request_id"]), u["id"], to_id))
    notify(to_id, "You received new feedback")
    return jsonify(ok=True)


@app.get("/api/feedback-requests")
@auth()
def feedback_requests_list(u):
    return jsonify(
        sent=q("SELECT r.*, e.name to_name FROM feedback_requests r JOIN employees e ON e.id=r.to_id WHERE r.from_id=? ORDER BY r.id DESC", (u["id"],)),
        received=q("SELECT r.*, e.name from_name FROM feedback_requests r JOIN employees e ON e.id=r.from_id WHERE r.to_id=? ORDER BY r.id DESC", (u["id"],)))


@app.post("/api/feedback-requests")
@auth()
def feedback_request_add(u):
    j = body("to_id", "message")
    to_id = int(j["to_id"])
    if to_id == u["id"]: raise ValueError("You cannot request feedback from yourself")
    if not q("SELECT id FROM employees WHERE id=? AND active=1", (to_id,), one=True): raise ValueError("Employee not found")
    if q("SELECT id FROM feedback_requests WHERE from_id=? AND to_id=? AND status='pending'", (u["id"], to_id), one=True):
        raise ValueError("You already have a pending request with this person")
    rid = run("INSERT INTO feedback_requests(from_id,to_id,message) VALUES(?,?,?)", (u["id"], to_id, j["message"]))
    notify(to_id, "%s requested your feedback" % u["name"])
    return jsonify(id=rid)


# ---------- tasks ----------
@app.get("/api/tasks")
@auth()
def tasks(u): return jsonify(q("SELECT * FROM tasks WHERE emp_id=? ORDER BY done, due_date", (u["id"],)))


@app.post("/api/tasks")
@auth()
def task_add(u):
    j = body("title")
    return jsonify(id=run("INSERT INTO tasks(emp_id,title,description,priority,due_date) VALUES(?,?,?,?,?)", (u["id"], j["title"], j.get("description"), j.get("priority", "medium"), j.get("due_date"))))


@app.patch("/api/tasks/<int:tid>")
@auth()
def task_upd(u, tid):
    j = body()
    run("UPDATE tasks SET done=? WHERE id=? AND emp_id=?", (1 if j.get("done") else 0, tid, u["id"]))
    return jsonify(ok=True)


@app.delete("/api/tasks/<int:tid>")
@auth()
def task_del(u, tid):
    run("DELETE FROM tasks WHERE id=? AND emp_id=?", (tid, u["id"]))
    return jsonify(ok=True)


# ---------- review (approvals) + request hub ----------
def approver_ids(u):
    t = date.today().isoformat()
    ids = [u["id"]] + [r["from_id"] for r in q("SELECT from_id FROM delegates WHERE to_id=? AND from_date<=? AND to_date>=?", (u["id"], t, t))]
    return ids


def pending_review_count(u):
    """How many requests wait for this person (same rule as pending_reviews, but one query)."""
    t = date.today().isoformat()
    who = "SELECT ? UNION SELECT from_id FROM delegates WHERE to_id=? AND from_date<=? AND to_date>=?"
    one = "(SELECT COUNT(*) FROM %s WHERE status='pending' AND approver_id IN (" + who + "))"
    sql = "SELECT " + " + ".join(one % tb for tb in ("requests", "regularizations", "reimbursements", "loans")) + " n"
    return q(sql, [u["id"], u["id"], t, t] * 4, one=True)["n"]


def pending_reviews(u):
    ids = approver_ids(u); ph = ",".join("?" * len(ids))
    out = []
    kinds = (("requests", "request"), ("regularizations", "regularization"), ("reimbursements", "reimbursement"), ("loans", "loan"))
    for (t, n), rows in zip(kinds, par(*[lambda t=t: q("SELECT r.*, e.name emp_name FROM %s r JOIN employees e ON e.id=r.emp_id WHERE r.approver_id IN (%s) AND r.status='pending'" % (t, ph), ids) for t, _ in kinds])):
        for r in rows:
            r["type"] = n; out.append(r)
    return out


@app.get("/api/review")
@auth()
def review(u):
    """Review inbox. ?status=active (default) is what waits for the caller; ?status=closed is what the
    caller already decided. HR and leadership also see resignations and helpdesk tickets here."""
    if request.args.get("status") == "closed":
        return jsonify(closed_reviews(u))
    if u["role"] in ADMIN_ROLES:
        out, resign, tix = par(lambda: pending_reviews(u),
                               lambda: q("SELECT r.*, e.name emp_name, e.department, e.designation FROM resignations r JOIN employees e ON e.id=r.emp_id WHERE r.status='pending' ORDER BY r.id DESC"),
                               lambda: q("SELECT t.*, e.name emp_name FROM tickets t JOIN employees e ON e.id=t.emp_id WHERE t.status IN ('open','in_progress') ORDER BY t.id DESC"))
        for r in resign:
            r["type"] = "resignation"; out.append(r)
        for t in tix:
            t["type"] = "ticket"; out.append(t)
        return jsonify(out)
    return jsonify(pending_reviews(u))


def closed_reviews(u):
    ids = approver_ids(u); ph = ",".join("?" * len(ids)); out = []
    for r in q("SELECT r.*, e.name emp_name FROM requests r JOIN employees e ON e.id=r.emp_id WHERE r.approver_id IN (%s) AND r.status IN ('approved','rejected') ORDER BY r.id DESC LIMIT 200" % ph, ids):
        r["type"] = "request"; out.append(r)
    for r in q("SELECT r.*, e.name emp_name FROM regularizations r JOIN employees e ON e.id=r.emp_id WHERE r.approver_id IN (%s) AND r.status IN ('approved','rejected') ORDER BY r.id DESC LIMIT 200" % ph, ids):
        r["type"] = "regularization"; out.append(r)
    for t, n in (("reimbursements", "reimbursement"), ("loans", "loan")):
        for r in q("SELECT r.*, e.name emp_name FROM %s r JOIN employees e ON e.id=r.emp_id WHERE r.approver_id IN (%s) AND r.status IN ('approved','rejected') ORDER BY r.id DESC LIMIT 200" % (t, ph), ids):
            r["type"] = n; out.append(r)
    if u["role"] in ADMIN_ROLES:
        for r in q("SELECT r.*, e.name emp_name, e.department, e.designation FROM resignations r JOIN employees e ON e.id=r.emp_id WHERE r.status<>'pending' ORDER BY r.id DESC LIMIT 200"):
            r["type"] = "resignation"; out.append(r)
        for t in q("SELECT t.*, e.name emp_name FROM tickets t JOIN employees e ON e.id=t.emp_id WHERE t.status IN ('resolved','closed') ORDER BY t.id DESC LIMIT 200"):
            t["type"] = "ticket"; out.append(t)
    return out


@app.post("/api/admin/resignations/<int:rid>")
@auth(ADMIN_ROLES)
def a_resignation(u, rid):
    j = body("action")
    if j["action"] not in ("approve", "reject"): raise ValueError("Invalid action")
    r = q("SELECT r.*, e.role emp_role FROM resignations r JOIN employees e ON e.id=r.emp_id WHERE r.id=? AND r.status='pending'", (rid,), one=True)
    if not r: return jsonify(error="Resignation not found or already decided"), 404
    if r["emp_id"] == u["id"]: return jsonify(error="Cannot decide your own resignation"), 400
    if u["role"] in HR_LIKE_ROLES and r["emp_role"] in EXEC_ROLES: return jsonify(error="HR cannot decide executive requests"), 403
    st = "approved" if j["action"] == "approve" else "rejected"
    run("UPDATE resignations SET status=? WHERE id=?", (st, rid))
    notify(r["emp_id"], "Your resignation was %s by %s" % (st, u["name"]))
    return jsonify(status=st)


def execute_decision(table, typ, r, rid, action, decider):
    st = "approved" if action == "approve" else "rejected"
    now = datetime.now().isoformat()
    c = db.conn()
    decider_note = "Decided by %s (%s)" % (decider["name"], decider["role"].upper())
    if table == "requests":
        c.execute("UPDATE requests SET status=?,decided_at=?,approver_id=?,remark=? WHERE id=?", (st, now, decider["id"], decider_note, rid))
    elif table == "regularizations":
        c.execute("UPDATE regularizations SET status=?,decided_at=?,approver_id=? WHERE id=?", (st, now, decider["id"], rid))
    else:
        c.execute("UPDATE %s SET status=?,approver_id=? WHERE id=?" % table, (st, decider["id"], rid))
    if st == "approved":
        if table == "requests":
            if r["kind"] == "leave":
                d_, t_ = pdate(r["from_date"]), pdate(r["to_date"])
                while d_ <= t_:
                    c.execute("UPDATE attendance SET status=? WHERE emp_id=? AND date=? AND status NOT IN('H','O')", (r["code"] if r["code"] != "LOP" else "A", r["emp_id"], d_.isoformat()))
                    d_ += timedelta(days=1)
            elif r["kind"] == "compoff_grant":
                c.execute("UPDATE leave_grants SET granted=granted+? WHERE emp_id=? AND code='CO'", (r["days"], r["emp_id"]))
            elif r["kind"] == "cancel":
                c.execute("UPDATE requests SET status='cancelled',decided_at=? WHERE id=?", (now, r["ref_id"]))
                d_, t_ = pdate(r["from_date"]), pdate(r["to_date"])
                while d_ <= t_:    # leave cancelled: back to Present if there are punch times, else back to Leave (no punch)
                    c.execute("UPDATE attendance SET status='P' WHERE emp_id=? AND date=? AND status IN('CL','CO') AND first_in IS NOT NULL", (r["emp_id"], d_.isoformat()))
                    c.execute("UPDATE attendance SET status='L',source='auto' WHERE emp_id=? AND date=? AND status IN('CL','CO') AND first_in IS NULL", (r["emp_id"], d_.isoformat()))
                    d_ += timedelta(days=1)
        elif table == "regularizations" and r["kind"] == "regularize":
            # The approved times win over the machine: source is cleared so a later import never overwrites them.
            cur = c.execute("SELECT status FROM attendance WHERE emp_id=? AND date=?", (r["emp_id"], r["date"])).fetchone()
            if cur is None:
                c.execute("INSERT INTO attendance(emp_id,date,status,first_in,last_out,source) VALUES(?,?,'P',?,?,NULL)", (r["emp_id"], r["date"], r["in_time"], r["out_time"]))
            elif cur["status"] in ("H", "O"):          # worked on a holiday / weekly off: keep the holiday, record the time
                c.execute("UPDATE attendance SET first_in=?,last_out=?,source=NULL WHERE emp_id=? AND date=?", (r["in_time"], r["out_time"], r["emp_id"], r["date"]))
            else:
                c.execute("UPDATE attendance SET status='P',first_in=?,last_out=?,source=NULL WHERE emp_id=? AND date=?", (r["in_time"], r["out_time"], r["emp_id"], r["date"]))
    c.commit(); c.close()
    _SETTLED.clear()
    notify(r["emp_id"], "Your %s request was %s by %s" % (typ, st, decider["name"]))

    # When a manager/TL/lead decides a leave/request, notify HR in real-time
    r_emp = q("SELECT name FROM employees WHERE id=?", (r["emp_id"],), one=True)
    emp_name = r_emp["name"] if r_emp else "Employee"
    req_label = r.get("code") or r.get("kind") or typ
    dates_label = ("%s to %s" % (r["from_date"], r["to_date"])) if "from_date" in r and r.get("from_date") else r.get("date", "")
    if decider["role"] not in HR_LIKE_ROLES:
        hrs = q("SELECT id FROM employees WHERE role='hr' AND active=1 AND id!=?", (decider["id"],))
        for h in hrs:
            msg = "[Manager Action] %s %s %s's %s leave (%s)" % (
                decider["name"], st, emp_name, req_label, dates_label
            )
            notify(h["id"], msg)

    return jsonify(status=st)


@app.post("/api/review/<typ>/<int:rid>")
@auth()
def decide(u, typ, rid):
    j = body("action")
    if j["action"] not in ("approve", "reject"): raise ValueError("Invalid action")
    table = {"request": "requests", "regularization": "regularizations", "reimbursement": "reimbursements", "loan": "loans"}.get(typ)
    if not table: raise ValueError("Unknown type")
    ids = approver_ids(u)
    if u["role"] in ("ceo", "coo", "cpo", "executive"):
        r = q("SELECT * FROM %s WHERE id=? AND status='pending'" % table, (rid,), one=True)
    else:
        r = q("SELECT * FROM %s WHERE id=? AND approver_id IN (%s) AND status='pending'" % (table, ",".join("?" * len(ids))), [rid] + ids, one=True)
    if r and r["emp_id"] == u["id"]: r = None  # never self-approve, even via delegation
    if not r: return jsonify(error="Not found or not yours to decide"), 404
    return execute_decision(table, typ, r, rid, j["action"], u)


@app.post("/api/admin/review/<typ>/<int:rid>")
@auth(ADMIN_ROLES)
def admin_decide(u, typ, rid):
    j = body("action")
    if j["action"] not in ("approve", "reject"): raise ValueError("Invalid action")
    table = {"request": "requests", "regularization": "regularizations", "reimbursement": "reimbursements", "loan": "loans"}.get(typ)
    if not table: raise ValueError("Unknown type")
    r = q("SELECT * FROM %s WHERE id=? AND status='pending'" % table, (rid,), one=True)
    if not r: return jsonify(error="Request not found or not pending"), 404
    if r["emp_id"] == u["id"]:
        return jsonify(error="Cannot approve your own request"), 400
    if u["role"] in HR_LIKE_ROLES:
        target = q("SELECT role FROM employees WHERE id=?", (r["emp_id"],), one=True)
        if target and target["role"] in EXEC_ROLES:
            return jsonify(error="HR cannot decide executive requests"), 403
    return execute_decision(table, typ, r, rid, j["action"], u)


@app.get("/api/delegates")
@auth()
def delegates(u):
    return jsonify(
        given=q("SELECT d.*, e.name to_name FROM delegates d JOIN employees e ON e.id=d.to_id WHERE from_id=? ORDER BY d.id DESC", (u["id"],)),
        received=q("SELECT d.*, e.name from_name FROM delegates d JOIN employees e ON e.id=d.from_id WHERE to_id=? ORDER BY d.id DESC", (u["id"],)))


@app.post("/api/delegates")
@auth()
def delegate_add(u):
    j = body("to_id", "from_date", "to_date")
    if int(j["to_id"]) == u["id"]: raise ValueError("You cannot delegate to yourself")
    if not q("SELECT id FROM employees WHERE id=? AND active=1", (j["to_id"],), one=True): raise ValueError("Employee not found")
    if pdate(j["to_date"]) < pdate(j["from_date"]): raise ValueError("End date must be on/after start date")
    notify(int(j["to_id"]), "%s delegated approvals to you (%s to %s)" % (u["name"], j["from_date"], j["to_date"]))
    return jsonify(id=run("INSERT INTO delegates(from_id,to_id,from_date,to_date) VALUES(?,?,?,?)", (u["id"], j["to_id"], j["from_date"], j["to_date"])))


@app.delete("/api/delegates/<int:did>")
@auth()
def delegate_del(u, did):
    run("DELETE FROM delegates WHERE id=? AND from_id=?", (did, u["id"]))
    return jsonify(ok=True)


@app.get("/api/request-hub")
@auth()
def hub(u):
    out = []
    reqs, regs, reimb, loans_, tix, resign = par(*[lambda t=t: q("SELECT * FROM %s WHERE emp_id=?" % t, (u["id"],))
        for t in ("requests", "regularizations", "reimbursements", "loans", "tickets", "resignations")])
    for r in reqs:
        out.append(dict(type=r["kind"], summary="%s %s→%s" % (r["code"], r["from_date"], r["to_date"]), status=r["status"], created_at=r["created_at"]))
    for r in regs:
        out.append(dict(type=r["kind"], summary=r["date"], status=r["status"], created_at=r["created_at"]))
    for r in reimb:
        out.append(dict(type="reimbursement", summary="%s ₹%s" % (r["category"], r["amount"]), status=r["status"], created_at=r["created_at"]))
    for r in loans_:
        out.append(dict(type="loan", summary="₹%s / %s mo" % (r["amount"], r["tenure_months"]), status=r["status"], created_at=r["created_at"]))
    for r in tix:
        out.append(dict(type="helpdesk", summary=r["subject"], status=r["status"], created_at=r["created_at"]))
    for r in resign:
        out.append(dict(type="resignation", summary=r["last_day"], status=r["status"], created_at=r["created_at"]))
    return jsonify(sorted(out, key=lambda x: x["created_at"] or "", reverse=True))


# ---------- admin & executive control ----------  (role lists are defined once, near the top of this file)


@app.get("/api/admin/summary")
@auth(ADMIN_ROLES)
def a_summary(u):
    one = lambda sql: q(sql, one=True)["c"]
    return jsonify(employees=one("SELECT COUNT(*) c FROM employees WHERE active=1"), inactive=one("SELECT COUNT(*) c FROM employees WHERE active=0"),
                   pending_requests=one("SELECT COUNT(*) c FROM requests WHERE status='pending'") + one("SELECT COUNT(*) c FROM regularizations WHERE status='pending'"),
                   open_tickets=one("SELECT COUNT(*) c FROM tickets WHERE status IN('open','in_progress')"),
                   on_leave_today=one("SELECT COUNT(*) c FROM attendance WHERE date='%s' AND status IN('CL','CO','L')" % date.today().isoformat()),
                   pending_resignations=one("SELECT COUNT(*) c FROM resignations WHERE status='pending'"),
                    dept_counts=q("SELECT department, COUNT(*) c FROM employees WHERE active=1 GROUP BY department ORDER BY department"))


@app.get("/api/admin/employees")
@auth(ADMIN_ROLES)
def a_emps(u):
    cols = [
        "e.id", "e.emp_no", "e.name", "e.email", "e.role", "e.department",
        "e.designation", "e.location", "e.manager_id", "e.join_date", "e.dob",
        "e.skills", "e.shift", "e.active", "e.biometric_id",
    ] + ["e." + f for f in EMP_EXTRA_FIELDS] + ["m.name manager_name"]
    return jsonify(q(
        "SELECT %s FROM employees e LEFT JOIN employees m ON m.id=e.manager_id ORDER BY e.emp_no"
        % ",".join(cols)
    ))


@app.post("/api/admin/employees")
@auth(ADMIN_ROLES)
def a_emp_add(u):
    j = body("name", "email", "password", "department", "designation", "join_date")
    email = j["email"].strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]: raise ValueError("Invalid email")
    pemail = str(j.get("personal_email") or "").strip().lower()
    if pemail and ("@" not in pemail or "." not in pemail.split("@")[-1]):
        raise ValueError("Invalid personal email")
    if len(j["password"]) < 8: raise ValueError("Password must be at least 8 characters")
    role = j.get("role", "employee")
    if role not in ROLES: raise ValueError("Invalid role")
    if u["role"] in HR_LIKE_ROLES and (role in EXEC_ROLES or role == "admin"):
        raise ValueError("HR cannot create executive or admin accounts")
    pdate(j["join_date"])
    mgr = j.get("manager_id") or None
    if mgr and not q("SELECT id FROM employees WHERE id=? AND active=1", (mgr,), one=True): raise ValueError("Manager not found")
    if q("SELECT id FROM employees WHERE email=?", (email,), one=True): raise ValueError("Email already exists")
    n = (q("SELECT MAX(CAST(substr(emp_no,5) AS UNSIGNED)) m FROM employees", one=True)["m"] or 0) + 1
    while q("SELECT id FROM employees WHERE emp_no=?", ("3WAI%05d" % n,), one=True):
        n += 1  # a code may have been edited by hand, never reuse one
    emp_no = "3WAI%05d" % n
    extras = {f: str(j.get(f) or "").strip() for f in EMP_EXTRA_FIELDS}
    bio = clean_biometric_id(j.get("biometric_id"))
    cols = [
        "emp_no", "name", "email", "password_hash", "role", "department",
        "designation", "location", "manager_id", "join_date", "dob", "skills",
        "shift", "biometric_id",
    ] + list(EMP_EXTRA_FIELDS)
    vals = [
        emp_no, j["name"].strip(), email, generate_password_hash(j["password"]),
        role, j["department"], j["designation"], j.get("location") or "", mgr,
        j["join_date"], j.get("dob") or "", j.get("skills") or "",
        j.get("shift") or "Flexible", bio,
    ] + [extras[f] for f in EMP_EXTRA_FIELDS]
    eid = run(
        "INSERT INTO employees(%s) VALUES(%s)" % (
            ",".join(cols), ",".join("?" * len(cols))
        ),
        tuple(vals),
    )
    for code, g in (("CL", 0), ("CO", 0), ("LOP", 0)):  # every leave type starts at 0; HR grants days explicitly
        run("INSERT INTO leave_grants(emp_id,code,year,granted,opening_used) VALUES(?,?,?,?,0)", (eid, code, "2026-2027", g))
    if bio: rebuild_attendance(eid)  # punches already stored for this machine ID show up straight away
    notify(eid, "Welcome to 3Wheels AI! Your account is ready.")
    send_welcome_email(email, j["name"].strip(), emp_no, j["password"], role, j["designation"], j["department"])
    return jsonify(id=eid, emp_no=emp_no, email_sent=True)


@app.patch("/api/admin/employees/<int:eid>")
@auth(ADMIN_ROLES)
def a_emp_upd(u, eid):
    j = body()
    e = q("SELECT * FROM employees WHERE id=?", (eid,), one=True)
    if not e: raise ValueError("Employee not found")
    if u["role"] in HR_LIKE_ROLES and e["role"] in EXEC_ROLES:
        raise ValueError("HR cannot modify executive leadership")
    sets, vals = [], []
    if "emp_no" in j:
        code = str(j["emp_no"] or "").strip().upper()
        if code != e["emp_no"]:
            if not re.fullmatch(r"[A-Z0-9._/-]{2,20}", code):
                raise ValueError("Employee code must be 2 to 20 characters: letters, numbers or . _ / -")
            if q("SELECT id FROM employees WHERE emp_no=? AND id!=?", (code, eid), one=True):
                raise ValueError("Employee code %s is already used by someone else" % code)
            sets.append("emp_no=?"); vals.append(code)
    for f in ("department", "designation", "location", "shift", "dob", "skills") + EMP_EXTRA_FIELDS:
        if f in j: sets.append(f + "=?"); vals.append(j[f])
    if "name" in j:
        nm = str(j["name"] or "").strip()
        if not nm: raise ValueError("Name is required")
        sets.append("name=?"); vals.append(nm)
    if "biometric_id" in j:
        sets.append("biometric_id=?"); vals.append(clean_biometric_id(j["biometric_id"], eid))
    if "join_date" in j and j["join_date"]:
        pdate(j["join_date"])
        sets.append("join_date=?"); vals.append(j["join_date"])
    if "role" in j:
        if j["role"] not in ROLES: raise ValueError("Invalid role")
        if u["role"] in HR_LIKE_ROLES and (j["role"] in EXEC_ROLES or j["role"] == "admin"):
            raise ValueError("HR cannot assign executive roles")
        if eid == u["id"] and u["role"] in HR_LIKE_ROLES and j["role"] != u["role"]:
            raise ValueError("You cannot remove your own HR role")
        if eid == u["id"] and j["role"] != u["role"]:
            raise ValueError("You cannot change your own role")
        sets.append("role=?"); vals.append(j["role"])
    if "active" in j:
        if eid == u["id"] and not j["active"]: raise ValueError("You cannot deactivate yourself")
        sets.append("active=?"); vals.append(1 if j["active"] else 0)
    if "manager_id" in j:
        m = j["manager_id"] or None
        if m and int(m) == eid: raise ValueError("Manager cannot be the same person")
        if m and not q("SELECT id FROM employees WHERE id=? AND active=1", (m,), one=True): raise ValueError("Manager not found")
        sets.append("manager_id=?"); vals.append(m)
    if not sets: raise ValueError("Nothing to update")
    run("UPDATE employees SET %s WHERE id=?" % ",".join(sets), vals + [eid])
    if "biometric_id" in j: rebuild_attendance(eid)
    return jsonify(ok=True)


@app.post("/api/admin/employees/<int:eid>/password")
@auth(ADMIN_ROLES)
def a_pw(u, eid):
    j = body("password")
    if len(j["password"]) < 8: raise ValueError("Password must be at least 8 characters")
    e = q("SELECT id, role FROM employees WHERE id=?", (eid,), one=True)
    if not e: raise ValueError("Employee not found")
    if u["role"] in HR_LIKE_ROLES and e["role"] in EXEC_ROLES:
        raise ValueError("HR cannot modify executive leadership")
    run("UPDATE employees SET password_hash=? WHERE id=?", (generate_password_hash(j["password"]), eid))
    return jsonify(ok=True)


@app.post("/api/admin/leave-grant")
@auth(ADMIN_ROLES)
def a_grant(u):
    j = body("emp_id", "days")
    code = (j.get("code") or "CL").strip().upper()
    mode = str(j.get("mode") or "add").strip().lower()
    if mode not in ("add", "set"):
        raise ValueError("Mode must be 'add' or 'set'")
    try: days = float(j["days"])
    except (TypeError, ValueError): raise ValueError("Days must be a number")
    if mode == "add":
        if days == 0 or abs(days) > 365: raise ValueError("Days must be non-zero and at most 365")
    elif days < 0 or days > 365:
        raise ValueError("Granted days must be between 0 and 365")
    g = q("SELECT * FROM leave_grants WHERE emp_id=? AND code=?", (j["emp_id"], code), one=True)
    if not g:
        if not q("SELECT id FROM employees WHERE id=?", (j["emp_id"],), one=True):
            raise ValueError("Employee not found")
        if mode != "set":
            raise ValueError("This employee has no %s grant yet — use 'Set exact CL' to create it" % code)
        run("INSERT INTO leave_grants(emp_id,code,year,granted,opening_used) VALUES(?,?,?,?,0)",
            (int(j["emp_id"]), code, "2026-2027", days))
        g = q("SELECT * FROM leave_grants WHERE emp_id=? AND code=?", (j["emp_id"], code), one=True)
    new_granted = days if mode == "set" else g["granted"] + days
    if new_granted < g["opening_used"]: raise ValueError("That would take the grant below leave already used")
    run("UPDATE leave_grants SET granted=? WHERE id=?", (new_granted, g["id"]))
    used = q("SELECT COALESCE(SUM(days),0) s FROM requests WHERE emp_id=? AND code=? AND kind IN('leave','rh') AND status IN('approved','pending')", (j["emp_id"], code), one=True)["s"]
    consumed = g["opening_used"] + used
    new_bal = round(new_granted - consumed, 1)
    if mode == "set":
        msg = "%s set your %s grant to %.1f day(s). Your new %s balance is %.1f day(s)." % (u["role"].upper(), code, new_granted, code, new_bal)
    else:
        msg = "%s %s %s %s day(s). Your new %s balance is %.1f day(s)." % (u["role"].upper(), "added" if days > 0 else "deducted", abs(days), code, code, new_bal)
    notify(int(j["emp_id"]), msg)
    return jsonify(ok=True, new_balance=new_bal, granted=new_granted)


@app.post("/api/admin/leave-grant-bulk")
@auth(ADMIN_ROLES)
def a_grant_bulk(u):
    """Apply one leave value to every active employee at once (used for company-wide CL)."""
    j = body("days")
    code = (j.get("code") or "CL").strip().upper()
    mode = str(j.get("mode") or "set").strip().lower()
    if mode not in ("add", "set"):
        raise ValueError("Mode must be 'add' or 'set'")
    try: days = float(j["days"])
    except (TypeError, ValueError): raise ValueError("Days must be a number")
    if mode == "add":
        if days == 0 or abs(days) > 365: raise ValueError("Days must be non-zero and at most 365")
    elif days < 0 or days > 365:
        raise ValueError("Granted days must be between 0 and 365")
    emps = q("SELECT id, name FROM employees WHERE active=1 ORDER BY name")
    if not emps: raise ValueError("No active employees found")
    grants = {g["emp_id"]: g for g in q("SELECT * FROM leave_grants WHERE code=?", (code,))}
    updated, skipped = 0, []
    for e in emps:
        g = grants.get(e["id"])
        if not g:
            if mode != "set":
                skipped.append(e["name"]); continue
            run("INSERT INTO leave_grants(emp_id,code,year,granted,opening_used) VALUES(?,?,?,?,0)",
                (e["id"], code, "2026-2027", days))
            updated += 1
            notify(e["id"], "%s set %s grant for all employees. Your %s grant is now %.1f day(s)." % (
                u["role"].upper(), code, code, days))
            continue
        new_granted = days if mode == "set" else g["granted"] + days
        if new_granted < g["opening_used"]:
            skipped.append(e["name"]); continue
        run("UPDATE leave_grants SET granted=? WHERE id=?", (new_granted, g["id"]))
        updated += 1
        notify(e["id"], "%s %s %s grant for all employees. Your %s grant is now %.1f day(s)." % (
            u["role"].upper(), "set" if mode == "set" else "updated", code, code, new_granted))
    return jsonify(ok=True, updated=updated, skipped=skipped)


@app.get("/api/admin/leave-balances")
@auth(ADMIN_ROLES)
def a_leave_balances(u):
    code = request.args.get("code", "CL").strip().upper()
    emps = q("SELECT id, emp_no, name, email, department, designation FROM employees WHERE active=1 ORDER BY name")
    grants = {g["emp_id"]: g for g in q("SELECT * FROM leave_grants WHERE code=?", (code,))}
    used_map = {row["emp_id"]: row["s"] for row in q("SELECT emp_id, COALESCE(SUM(days),0) s FROM requests WHERE code=? AND kind IN('leave','rh') AND status IN('approved','pending') GROUP BY emp_id", (code,))}
    out = []
    for e in emps:
        g = grants.get(e["id"], {"granted": 0.0, "opening_used": 0.0})
        used = used_map.get(e["id"], 0.0)
        consumed = g["opening_used"] + used
        bal = round(g["granted"] - consumed, 1)
        out.append({
            "emp_id": e["id"],
            "emp_no": e["emp_no"],
            "name": e["name"],
            "department": e["department"],
            "designation": e["designation"],
            "code": code,
            "granted": g["granted"],
            "consumed": consumed,
            "balance": bal
        })
    return jsonify(out)


@app.get("/api/admin/outbox")
@auth(ADMIN_ROLES)
def a_outbox(u):
    return jsonify(q("SELECT * FROM email_outbox ORDER BY id DESC LIMIT 50"))


@app.get("/api/admin/attendance-overview")
@auth(ADMIN_ROLES)
def a_attendance_overview(u):
    """
    Returns a per-employee monthly attendance summary showing count of each
    status (P, A, CL, CO, LOP, H, O) plus total working days and working hours.
    Optionally filtered by ?month=YYYY-MM (defaults to current month).
    Optionally filtered by ?emp_id=N for a single employee (returns day-by-day detail).
    """
    month_param = request.args.get("month", date.today().strftime("%Y-%m"))
    emp_param = request.args.get("emp_id")

    # Validate month format
    try:
        datetime.strptime(month_param, "%Y-%m")
    except ValueError:
        raise ValueError("Invalid month format, expected YYYY-MM")
    settle_days(None, month_param)      # no punch = Leave, short day = Half Day

    # --- Single employee drill-down: return day-by-day rows ---
    if emp_param:
        emp_id = int(emp_param)
        rows = q("""
            SELECT a.date, a.status, a.first_in, a.last_out,
                   e.emp_no, e.name emp_name, e.designation, e.department, e.role
            FROM attendance a
            JOIN employees e ON e.id = a.emp_id
            WHERE a.emp_id = ? AND substr(a.date, 1, 7) = ?
            ORDER BY a.date ASC
        """, (emp_id, month_param))
        return jsonify(rows)

    # --- Company-wide summary: one row per employee with status counts ---
    # Pull all attendance rows for the month
    att_rows = q("""
        SELECT a.emp_id, a.date, a.status, a.first_in, a.last_out
        FROM attendance a
        JOIN employees e ON e.id = a.emp_id
        WHERE e.active = 1 AND substr(a.date, 1, 7) = ?
        ORDER BY a.emp_id, a.date
    """, (month_param,))

    # Pull all active employees
    emps = q("""
        SELECT e.id, e.emp_no, e.biometric_id, e.name, e.department, e.designation, e.role,
               m.name manager_name
        FROM employees e
        LEFT JOIN employees m ON m.id = e.manager_id
        WHERE e.active = 1
        ORDER BY e.emp_no
    """)

    STATUS_CODES = ["P", "A", "CL", "CO", "LOP", "H", "O", "L", "HD"]

    # Group attendance by emp_id
    from collections import defaultdict
    att_map = defaultdict(list)
    for row in att_rows:
        att_map[row["emp_id"]].append(row)

    result = []
    for emp in emps:
        emp_att = att_map.get(emp["id"], [])
        counts = {s: 0 for s in STATUS_CODES}
        total_working_mins = 0

        for rec in emp_att:
            st = rec["status"]
            if st in counts:
                counts[st] += 1
            # Compute working hours for Present days
            if st == "P" and rec["first_in"] and rec["last_out"]:
                try:
                    fi = datetime.strptime(rec["first_in"], "%H:%M")
                    lo = datetime.strptime(rec["last_out"], "%H:%M")
                    diff = (lo - fi).seconds // 60
                    if diff > 0:
                        total_working_mins += diff
                except Exception:
                    pass

        total_days = len(emp_att)
        working_hours = round(total_working_mins / 60, 1)

        result.append({
            "emp_id": emp["id"],
            "emp_no": emp["emp_no"],
            "biometric_id": emp["biometric_id"],
            "name": emp["name"],
            "department": emp["department"],
            "designation": emp["designation"],
            "role": emp["role"],
            "manager_name": emp["manager_name"] or "—",
            "total_days": total_days,
            "present": counts["P"],
            "absent": counts["A"],
            "casual_leave": counts["CL"],
            "comp_off": counts["CO"],
            "lop": counts["LOP"],
            "holiday": counts["H"],
            "weekly_off": counts["O"],
            "leave_no_punch": counts["L"],
            "half_day": counts["HD"],
            "working_hours": working_hours,
            "month": month_param
        })

    return jsonify(result)


# ---------- month-wise attendance Excel export (styled, 2 sheets) ----------
def _attendance_export_data(month):
    """Return one summary row per active employee with their day records."""
    try:
        datetime.strptime(month, "%Y-%m")
    except ValueError:
        raise ValueError("Invalid month format, expected YYYY-MM")
    settle_days(None, month)

    emps = q("""
        SELECT e.id, e.emp_no, e.name, e.department, e.designation, e.role,
               m.name manager_name
        FROM employees e
        LEFT JOIN employees m ON m.id = e.manager_id
        WHERE e.active = 1
        ORDER BY e.emp_no
    """)
    att_rows = q("""
        SELECT a.emp_id, a.date, a.status, a.first_in, a.last_out
        FROM attendance a
        JOIN employees e ON e.id = a.emp_id
        WHERE e.active = 1 AND substr(a.date, 1, 7) = ?
        ORDER BY a.emp_id, a.date
    """, (month,))

    by_emp = {}
    for row in att_rows:
        by_emp.setdefault(row["emp_id"], []).append(row)

    status_codes = ("P", "A", "CL", "CO", "LOP", "H", "O", "L", "HD")
    out = []
    for emp in emps:
        recs = by_emp.get(emp["id"], [])
        counts = {s: 0 for s in status_codes}
        total_working_mins = 0
        for rec in recs:
            if rec["status"] in counts:
                counts[rec["status"]] += 1
            if rec["status"] == "P" and rec["first_in"] and rec["last_out"]:
                try:
                    total_working_mins += biometric.work_minutes(rec["first_in"], rec["last_out"])
                except Exception:
                    pass
        out.append({
            "emp_id": emp["id"],
            "emp_no": emp["emp_no"],
            "name": emp["name"],
            "department": emp["department"],
            "designation": emp["designation"],
            "role": emp["role"],
            "manager_name": emp["manager_name"] or "—",
            "total_days": len(recs),
            "present": counts["P"],
            "absent": counts["A"],
            "casual_leave": counts["CL"],
            "comp_off": counts["CO"],
            "lop": counts["LOP"],
            "holiday": counts["H"],
            "weekly_off": counts["O"],
            "leave_no_punch": counts["L"],
            "half_day": counts["HD"],
            "working_hours": round(total_working_mins / 60, 1),
            "month": month,
            "days": recs,
        })
    return out


@app.get("/api/admin/attendance-export")
@auth(ADMIN_ROLES)
def a_attendance_export(u):
    month = request.args.get("month", date.today().strftime("%Y-%m"))
    data = _attendance_export_data(month)

    header_fill = PatternFill("solid", fgColor="1F4E78")
    header_font = Font(bold=True, color="FFFFFF")
    center = Alignment(horizontal="center", vertical="center")
    thin = Side(style="thin", color="D9D9D9")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    # P = green, A = light red, CL = light green, LOP = red,
    # H (holiday) / O (weekly off) / CO = light gray
    status_fills = {
        "P": PatternFill("solid", fgColor="C6EFCE"),
        "A": PatternFill("solid", fgColor="FFC7CE"),
        "CL": PatternFill("solid", fgColor="E2EFDA"),
        "LOP": PatternFill("solid", fgColor="FF0000"),
        "H": PatternFill("solid", fgColor="D9D9D9"),
        "O": PatternFill("solid", fgColor="F2F2F2"),
        "CO": PatternFill("solid", fgColor="EDEDED"),
        "L": PatternFill("solid", fgColor="E4D1F0"),
        "HD": PatternFill("solid", fgColor="FFE699"),
    }
    status_fonts = {
        "P": Font(color="006100"),
        "A": Font(color="9C0006"),
        "CL": Font(color="375623"),
        "LOP": Font(bold=True, color="FFFFFF"),
        "H": Font(color="595959"),
        "O": Font(color="808080"),
        "CO": Font(color="595959"),
        "L": Font(color="5B2C83"),
        "HD": Font(color="7F6000"),
    }

    wb = Workbook()

    # ---- Sheet 1: Monthly Summary ----
    ws = wb.active
    ws.title = "Monthly Summary"
    summary_headers = [
        "Emp ID", "Name", "Designation", "Department", "Role", "Manager",
        "Present (P)", "Absent (A)", "Casual Leave (CL)", "Comp Off (CO)",
        "Loss of Pay (LOP)", "Holiday (H)", "Weekly Off (O)", "Leave - no punch (L)", "Half Day (HD)",
        "Working Hours (hrs)", "Total Days Recorded", "Month",
    ]
    ws.append(summary_headers)
    for r in data:
        ws.append([
            r["emp_no"], r["name"], r["designation"] or "", r["department"] or "",
            (r["role"] or "").upper(), r["manager_name"],
            r["present"], r["absent"], r["casual_leave"], r["comp_off"],
            r["lop"], r["holiday"], r["weekly_off"], r["leave_no_punch"], r["half_day"],
            r["working_hours"], r["total_days"], r["month"],
        ])
    for cell in ws[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = center
        cell.border = border
    for row in ws.iter_rows(min_row=2, max_row=len(data) + 1):
        for cell in row:
            cell.border = border
    for i, width in enumerate(
        [10, 22, 24, 18, 10, 20, 12, 12, 16, 14, 16, 12, 14, 18, 14, 18, 20, 12], 1
    ):
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = "A1:R%d" % (len(data) + 1)

    # ---- Sheet 2: Attendance Grid (employees as rows, dates as columns) ----
    ws2 = wb.create_sheet("Attendance Grid")
    yy, mm = map(int, month.split("-"))
    days_in_month = calendar.monthrange(yy, mm)[1]
    date_labels = [
        "%02d %s" % (d, date(yy, mm, d).strftime("%a"))
        for d in range(1, days_in_month + 1)
    ]
    grid_headers = (
        ["Emp ID", "Name", "Designation", "Department"]
        + date_labels
        + ["Present", "Absent", "CL", "CO", "LOP", "Holiday", "Weekly Off", "Leave (L)", "Half Day",
           "Working Hours", "Total Days"]
    )
    ws2.append(grid_headers)
    for r in data:
        by_date = {x["date"]: x for x in r["days"]}
        row = [r["emp_no"], r["name"], r["designation"] or "", r["department"] or ""]
        for d in range(1, days_in_month + 1):
            rec = by_date.get("%s-%02d" % (month, d))
            row.append(rec["status"] if rec else "")
        row += [
            r["present"], r["absent"], r["casual_leave"], r["comp_off"],
            r["lop"], r["holiday"], r["weekly_off"], r["leave_no_punch"], r["half_day"],
            r["working_hours"], r["total_days"],
        ]
        ws2.append(row)

    for cell in ws2[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = center
        cell.border = border

    date_start_col = 5
    date_end_col = 4 + days_in_month
    summary_end_col = date_end_col + 11
    for row_idx in range(2, len(data) + 2):
        for col_idx in range(date_start_col, date_end_col + 1):
            cell = ws2.cell(row=row_idx, column=col_idx)
            value = str(cell.value or "")
            if value in status_fills:
                cell.fill = status_fills[value]
                cell.font = status_fonts[value]
            cell.alignment = center
            cell.border = border
        for col_idx in range(date_end_col + 1, summary_end_col + 1):
            cell = ws2.cell(row=row_idx, column=col_idx)
            cell.alignment = center
            cell.border = border

    ws2.column_dimensions["A"].width = 10
    ws2.column_dimensions["B"].width = 22
    ws2.column_dimensions["C"].width = 24
    ws2.column_dimensions["D"].width = 18
    for col_idx in range(date_start_col, date_end_col + 1):
        ws2.column_dimensions[get_column_letter(col_idx)].width = 7
    for offset, width in enumerate([9, 8, 6, 6, 6, 8, 10, 10, 10, 14, 10]):
        ws2.column_dimensions[get_column_letter(date_end_col + 1 + offset)].width = width
    ws2.freeze_panes = "E2"
    ws2.auto_filter.ref = "A1:%s%d" % (
        get_column_letter(summary_end_col), len(data) + 1
    )

    # Legend with colour swatches
    legend_row = len(data) + 3
    ws2.cell(row=legend_row, column=1, value="Legend:").font = Font(bold=True)
    legend = [
        ("P", "Present"), ("A", "Absent"), ("CL", "Casual Leave"),
        ("LOP", "Loss of Pay"), ("H", "Holiday"), ("O", "Weekly Off"),
        ("CO", "Comp Off"), ("L", "Leave (no punch)"), ("HD", "Half Day"),
    ]
    for idx, (code, label) in enumerate(legend):
        code_cell = ws2.cell(row=legend_row, column=2 + idx * 2, value=code)
        code_cell.fill = status_fills[code]
        code_cell.font = status_fonts[code]
        code_cell.alignment = center
        ws2.cell(row=legend_row, column=3 + idx * 2, value=label)

    # ---- Sheet 3: Daily (the in and out time of every day, written "HH:MM-HH:MM"; one punch so far shows just that time) ----
    ws3 = wb.create_sheet("Daily")
    ws3.append(["Employee ID", "Name"] + date_labels)
    for r in data:
        by_date = {x["date"]: x for x in r["days"]}
        row = [r["emp_no"], r["name"]]
        for d in range(1, days_in_month + 1):
            rec = by_date.get("%s-%02d" % (month, d))
            fi = rec["first_in"] if rec else None
            lo = rec["last_out"] if rec else None
            row.append(None if not fi else fi if (not lo or lo == fi) else "%s-%s" % (fi, lo))
        ws3.append(row)
    for cell in ws3[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = center
        cell.border = border
    ws3.column_dimensions["A"].width = 14
    ws3.column_dimensions["B"].width = 24
    for col_idx in range(3, 3 + days_in_month):
        ws3.column_dimensions[get_column_letter(col_idx)].width = 12
        for row_idx in range(2, len(data) + 2):
            ws3.cell(row=row_idx, column=col_idx).alignment = center
    ws3.freeze_panes = "C2"

    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    filename = "3WheelsAI_Attendance_%s.xlsx" % month
    return send_file(
        buf,
        as_attachment=True,
        download_name=filename,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.post("/api/admin/holidays")
@auth(ADMIN_ROLES)
def a_hol_add(u):
    j = body("date", "name")
    pdate(j["date"])
    run("REPLACE INTO holidays(date,name,restricted) VALUES(?,?,?)", (j["date"], j["name"].strip(), 1 if j.get("restricted") in (1, True, "1", "true", "on") else 0))
    return jsonify(ok=True)


@app.delete("/api/admin/holidays/<d>")
@auth(ADMIN_ROLES)
def a_hol_del(u, d):
    run("DELETE FROM holidays WHERE date=?", (d,))
    return jsonify(ok=True)


@app.get("/api/admin/tickets")
@auth(ADMIN_ROLES)
def a_tickets(u):
    return jsonify(q("SELECT t.*, e.name emp_name FROM tickets t JOIN employees e ON e.id=t.emp_id ORDER BY t.id DESC"))


@app.patch("/api/admin/tickets/<int:tid>")
@auth(ADMIN_ROLES)
def a_ticket(u, tid):
    j = body("status")
    if j["status"] not in ("open", "in_progress", "resolved", "closed"): raise ValueError("Invalid status")
    t = q("SELECT * FROM tickets WHERE id=?", (tid,), one=True)
    if not t: raise ValueError("Ticket not found")
    run("UPDATE tickets SET status=? WHERE id=?", (j["status"], tid))
    notify(t["emp_id"], "Your ticket #%d is now %s" % (tid, j["status"]))
    return jsonify(ok=True)


@app.post("/api/admin/documents")
@auth(ADMIN_ROLES)
def a_doc(u):
    j = body("title", "category", "body")
    emp = j.get("emp_id") or None
    if emp and not q("SELECT id FROM employees WHERE id=?", (emp,), one=True): raise ValueError("Employee not found")
    run("INSERT INTO documents(emp_id,title,category,body) VALUES(?,?,?,?)", (emp, j["title"], j["category"], j["body"]))
    if emp: notify(int(emp), "A new document was added: " + j["title"])
    return jsonify(ok=True)


@app.get("/api/admin/attendance")
@auth(ADMIN_ROLES)
def a_attendance_get(u):
    date_param = request.args.get("date")
    month_param = request.args.get("month", date.today().strftime("%Y-%m"))
    emp_param = request.args.get("emp_id")
    sql = """
        SELECT a.*, e.emp_no, e.name emp_name, e.department, e.designation, e.shift, e.role
        FROM attendance a
        JOIN employees e ON e.id = a.emp_id
        WHERE e.active = 1
    """
    args = []
    if date_param:
        sql += " AND a.date = ?"
        args.append(date_param)
    elif month_param:
        sql += " AND substr(a.date, 1, 7) = ?"
        args.append(month_param)
    if emp_param:
        sql += " AND a.emp_id = ?"
        args.append(int(emp_param))
    sql += " ORDER BY a.date DESC, e.emp_no ASC LIMIT 300"
    return jsonify(q(sql, args))


@app.post("/api/admin/attendance")
@auth(ADMIN_ROLES)
def a_attendance_mark(u):
    j = body("emp_id", "date", "status")
    emp_id = int(j["emp_id"])
    target = q("SELECT id, name, role, shift FROM employees WHERE id=?", (emp_id,), one=True)
    if not target: raise ValueError("Employee not found")
    if u["role"] in HR_LIKE_ROLES and target["role"] in EXEC_ROLES:
        raise ValueError("HR cannot modify executive attendance")
    pdate(j["date"])
    st = j["status"].strip().upper()
    if st not in ("P", "A", "H", "O", "CL", "CO", "LOP", "L", "HD"):
        raise ValueError("Invalid status (use P, A, H, O, CL, CO, LOP, L or HD)")
    fi = j.get("first_in")
    lo = j.get("last_out")
    if st == "P":
        sh = target["shift"] if re.match(r"^\d{1,2}:\d{2}-\d{1,2}:\d{2}$", target["shift"] or "") else "10:00-19:00"      # Flexible: use a normal day
        shift_parts = sh.split("-")
        if not fi: fi = shift_parts[0]
        if not lo: lo = shift_parts[1]
    else:
        fi, lo = None, None
    run("REPLACE INTO attendance(emp_id, date, status, first_in, last_out) VALUES (?, ?, ?, ?, ?)",
        (emp_id, j["date"], st, fi, lo))
    notify(emp_id, "Your attendance for %s was marked as %s by %s" % (j["date"], st, u["name"]))
    return jsonify(ok=True)


# ---------- biometric machine ----------
def clean_biometric_id(raw, eid=None):
    """The number the machine knows a person by. '000000005' and '5' are the same id."""
    bid = biometric.norm_id(raw)
    if not bid: return None
    if not re.fullmatch(r"[A-Za-z0-9]{1,20}", bid): raise ValueError("Biometric ID can only have letters and numbers")
    other = q("SELECT name FROM employees WHERE biometric_id=? AND id!=?", (bid, eid or 0), one=True)
    if other: raise ValueError("Biometric ID %s already belongs to %s" % (bid, other["name"]))
    return bid


def rebuild_attendance(emp_id=None):
    """Fill first in / last out from the stored punches for everyone who has a Biometric ID.
    Rows a person entered (leave, holiday, regularization, HR mark) are never overwritten."""
    where, args = "active=1 AND biometric_id IS NOT NULL AND biometric_id<>''", []
    if emp_id: where += " AND id=?"; args.append(emp_id)
    emps = q("SELECT id, biometric_id FROM employees WHERE " + where, args)
    stats = dict(employees=len(emps), inserted=0, updated=0, kept_manual=0)
    if not emps: return stats
    owner = {e["biometric_id"]: e["id"] for e in emps}
    times = {}
    for r in q("SELECT enno, punch_at FROM biometric_punches WHERE enno IN (%s) ORDER BY punch_at" % ",".join("?" * len(owner)), list(owner)):
        times.setdefault(r["enno"], []).append(r["punch_at"])
    have = {(r["emp_id"], r["date"]): r for r in q(
        "SELECT emp_id, date, status, first_in, source FROM attendance WHERE emp_id IN (%s)" % ",".join("?" * len(emps)), [e["id"] for e in emps])}
    ins, upd = [], []
    for enno, ts in times.items():
        eid = owner[enno]
        for day, (fi, lo) in biometric.derive_days(ts).items():
            cur = have.get((eid, day))
            judged = biometric.classify(fi, lo)      # today too: under 4.5 hours so far reads Leave, 4.5 to 9 Half Day, 9 or more Present
            if cur is None: ins.append((eid, day, judged, fi, lo, "bio"))
            elif cur["source"] in ("bio", "auto"):                                  # machine / system rows follow the machine
                upd.append((judged if cur["status"] in ("P", "HD", "L") else cur["status"], fi, lo, "bio", eid, day))
            elif cur["status"] in ("H", "O") and not cur["first_in"]: upd.append((cur["status"], fi, lo, "bio", eid, day))
            else: stats["kept_manual"] += 1
    c = db.conn()
    try:
        if ins: c.executemany("INSERT IGNORE INTO attendance(emp_id,date,status,first_in,last_out,source) VALUES(?,?,?,?,?,?)", ins)
        if upd: c.executemany("UPDATE attendance SET status=?,first_in=?,last_out=?,source=? WHERE emp_id=? AND date=?", upd)
        c.commit()
    finally:
        c.close()
    _SETTLED.clear()
    stats["inserted"], stats["updated"] = len(ins), len(upd)
    return stats


COMPANY_START = "2026-05-18"      # people with no joining date are counted from here


def settle_days(emp_ids=None, month=None):
    """Make the attendance table complete for the days of a month up to today:
      * a finished day without any punch becomes Leave ('L') (only from the day the machine was first used), or the approved leave that covers it;
      * Sundays and public holidays become 'H' when they have no row yet (e.g. for someone who joined later);
      * a day made from machine punches is judged Present / Half Day / Leave from its hours.
    Anything a person entered (source empty) is never changed. Safe to call again and again."""
    month = month or date.today().strftime("%Y-%m")
    y, m = int(month[:4]), int(month[5:7])
    first, last = date(y, m, 1), date(y, m, calendar.monthrange(y, m)[1])
    today_iso = date.today().isoformat()
    end = min(last, date.today())       # today is judged from the punches so far, but a person who has not punched yet is not made Leave
    if end < first: return 0
    key = (tuple(sorted(emp_ids)) if emp_ids else None, month, date.today().isoformat())
    if time.monotonic() - _SETTLED.get(key, -1e9) < SETTLE_TTL: return 0      # settled a moment ago; any write clears this memory
    where, args = "active=1", []
    if emp_ids: where += " AND id IN (%s)" % ",".join("?" * len(emp_ids)); args += list(emp_ids)
    emps = q("SELECT id, join_date FROM employees WHERE " + where, args)
    if not emps: return 0
    ids = [e["id"] for e in emps]; ph = ",".join("?" * len(ids))
    hol_rows, first_punch_row, have_rows, leave_rows = par(          # four independent reads, one trip's time
        lambda: q("SELECT date FROM holidays WHERE restricted=0 AND substr(date,1,7)=?", (month,)),
        lambda: q("SELECT MIN(punch_at) m FROM biometric_punches", one=True),
        lambda: q("SELECT emp_id, date, status, first_in, last_out, source FROM attendance WHERE substr(date,1,7)=? AND emp_id IN (%s)" % ph, [month] + ids),
        lambda: q("SELECT emp_id, code, from_date, to_date FROM requests WHERE kind='leave' AND status='approved' AND from_date<=? AND to_date>=? AND emp_id IN (%s)" % ph,
                  [last.isoformat(), first.isoformat()] + ids))
    hol = {h["date"] for h in hol_rows}
    first_punch = first_punch_row["m"]
    tracked_from = str(first_punch)[:10] if first_punch else None      # before the machine was in use a missing punch means nothing
    have = {(r["emp_id"], r["date"]): r for r in have_rows}
    leave = {}
    for r in leave_rows:
        d_ = max(pdate(r["from_date"]), first)
        while d_ <= min(pdate(r["to_date"]), last):
            leave[(r["emp_id"], d_.isoformat())] = r["code"] if r["code"] != "LOP" else "A"
            d_ += timedelta(days=1)
    ins, upd = [], []
    d_ = first
    while d_ <= end:
        iso = d_.isoformat(); off = d_.weekday() == 6 or iso in hol
        if tracked_from and iso < tracked_from:      # attendance starts with the first stored punch; nothing is made up before it
            d_ += timedelta(days=1); continue
        for e in emps:
            if iso < (e["join_date"] or COMPANY_START): continue
            cur = have.get((e["id"], iso))
            if cur is None:
                if off: ins.append((e["id"], iso, "H", None))
                elif (e["id"], iso) in leave: ins.append((e["id"], iso, leave[(e["id"], iso)], None))
                elif tracked_from and tracked_from <= iso < today_iso: ins.append((e["id"], iso, "L", "auto"))
            elif cur["source"] == "bio" and cur["status"] in ("P", "HD", "L") and cur["first_in"]:
                judged = biometric.classify(cur["first_in"], cur["last_out"] or cur["first_in"])
                if judged != cur["status"]: upd.append((judged, e["id"], iso))
        d_ += timedelta(days=1)
    c = db.conn()
    try:
        if ins: c.executemany("INSERT IGNORE INTO attendance(emp_id,date,status,first_in,last_out,source) VALUES(?,?,?,NULL,NULL,?)", ins)
        if upd: c.executemany("UPDATE attendance SET status=? WHERE emp_id=? AND date=?", upd)
        c.commit()
    finally:
        c.close()
    _SETTLED[key] = time.monotonic()
    return len(ins) + len(upd)


def bio_unmatched():
    """Machine users nobody in the portal is linked to yet, each with a name based guess."""
    rows = q("""SELECT p.enno, MAX(p.name) name, COUNT(*) punches, MIN(p.punch_at) first_seen, MAX(p.punch_at) last_seen
                FROM biometric_punches p LEFT JOIN employees e ON e.biometric_id = p.enno AND e.active = 1
                WHERE e.id IS NULL GROUP BY p.enno""")
    rows.sort(key=lambda r: (not r["enno"].isdigit(), int(r["enno"]) if r["enno"].isdigit() else 0, r["enno"]))
    free = q("SELECT id, name FROM employees WHERE active=1 AND (biometric_id IS NULL OR biometric_id='')")
    for r in rows:
        r["suggest_id"] = biometric.suggest_employee(r["name"], free)
        r["first_seen"], r["last_seen"] = str(r["first_seen"])[:10], str(r["last_seen"])[:10]
    claimed = {}
    for r in rows:
        if r["suggest_id"]: claimed[r["suggest_id"]] = claimed.get(r["suggest_id"], 0) + 1
    for r in rows:  # two machine users guessing the same person means we do not know
        if r["suggest_id"] and claimed[r["suggest_id"]] > 1: r["suggest_id"] = None
    return rows


def link_biometric(links):
    done = 0
    for l in links:
        eid = int(l["emp_id"])
        if not q("SELECT id FROM employees WHERE id=? AND active=1", (eid,), one=True): raise ValueError("Employee not found")
        run("UPDATE employees SET biometric_id=? WHERE id=?", (clean_biometric_id(l["enno"], eid), eid))
        done += 1
    return done


@app.get("/api/admin/biometric")
@auth(ADMIN_ROLES)
def a_bio_status(u):
    s = q("SELECT COUNT(*) punches, COUNT(DISTINCT enno) users, MIN(punch_at) date_from, MAX(punch_at) date_to FROM biometric_punches", one=True)
    return jsonify(punches=s["punches"], users=s["users"], date_from=str(s["date_from"] or "")[:10], date_to=str(s["date_to"] or "")[:16],
                   linked=q("SELECT COUNT(*) c FROM employees WHERE active=1 AND biometric_id IS NOT NULL AND biometric_id<>''", one=True)["c"],
                   unmatched=bio_unmatched())


@app.post("/api/admin/biometric/import")
@auth(ADMIN_ROLES)
def a_bio_import(u):
    j = body("text")
    punches, bad = biometric.parse_glog(j["text"])
    if not punches:
        raise ValueError("No punches found. Upload the GLog file from the machine (tab separated: No, Mchn, EnNo, Name, Mode, IOMd, DateTime).")
    before = q("SELECT COUNT(*) c FROM biometric_punches", one=True)["c"]
    c = db.conn()
    try:
        c.executemany("INSERT IGNORE INTO biometric_punches(enno,punch_at,name,machine) VALUES(?,?,?,?)",
                      [(p["enno"], p["at"], p["name"][:120], p["machine"][:10]) for p in punches])
        c.commit()
    finally:
        c.close()
    new = q("SELECT COUNT(*) c FROM biometric_punches", one=True)["c"] - before
    stats = rebuild_attendance()
    return jsonify(read=len(punches), new=new, duplicates=len(punches) - new, bad_lines=bad, machine_users=len({p["enno"] for p in punches}),
                   date_from=min(p["at"] for p in punches).strftime("%Y-%m-%d"), date_to=max(p["at"] for p in punches).strftime("%Y-%m-%d"),
                   unmatched=len(bio_unmatched()), **stats)


@app.post("/api/biometric/ingest")
def bio_ingest():
    """Live punches from the connector that runs next to the machine. Authenticated by a shared secret
    (env BIOMETRIC_TOKEN), not by a login. Body: {"punches":[{"enno":"5","name":"..","at":"2026-11-23 10:58:00","machine":"2"}]}"""
    import hmac
    secret = os.environ.get("BIOMETRIC_TOKEN", "")
    if len(secret) < 16: return jsonify(error="Live punch intake is not enabled"), 503
    auth_h = request.headers.get("Authorization", "")
    given = auth_h[7:] if auth_h.startswith("Bearer ") else ""
    if not hmac.compare_digest(given.encode(), secret.encode()): return jsonify(error="Bad token"), 401
    rows = (request.get_json(silent=True) or {}).get("punches")
    if not isinstance(rows, list) or not rows or len(rows) > 1000: return jsonify(error="Send 1 to 1000 punches"), 400
    clean = []
    for p in rows:
        try:
            at = datetime.strptime(str(p["at"])[:19], "%Y-%m-%d %H:%M:%S")
            enno = biometric.norm_id(p["enno"])
        except (KeyError, ValueError, TypeError):
            continue
        if enno: clean.append((enno, at, str(p.get("name") or "")[:120], str(p.get("machine") or "")[:10]))
    if not clean: return jsonify(error="No valid punches"), 400
    before = q("SELECT COUNT(*) c FROM biometric_punches", one=True)["c"]
    c = db.conn()
    try:
        c.executemany("INSERT IGNORE INTO biometric_punches(enno,punch_at,name,machine) VALUES(?,?,?,?)", clean)
        c.commit()
    finally:
        c.close()
    new = q("SELECT COUNT(*) c FROM biometric_punches", one=True)["c"] - before
    if new:
        ids = list({x[0] for x in clean})
        for e in q("SELECT id FROM employees WHERE active=1 AND biometric_id IN (%s)" % ",".join("?" * len(ids)), ids):
            rebuild_attendance(e["id"])
    return jsonify(received=len(clean), new=new)


@app.post("/api/admin/biometric/link")
@auth(ADMIN_ROLES)
def a_bio_link(u):
    j = request.get_json(silent=True) or {}
    links = j.get("links") or []
    if not links: raise ValueError("Nothing to link")
    done = link_biometric(links)
    return jsonify(linked=done, **rebuild_attendance())


@app.post("/api/admin/biometric/automatch")
@auth(ADMIN_ROLES)
def a_bio_automatch(u):
    links = [{"enno": r["enno"], "emp_id": r["suggest_id"]} for r in bio_unmatched() if r["suggest_id"]]
    done = link_biometric(links)
    return jsonify(linked=done, **rebuild_attendance())


@app.get("/api/admin/requests")
@auth(ADMIN_ROLES)
def a_requests(u):
    leaves = q("""
        SELECT r.*, e.emp_no, e.name emp_name, e.department, e.designation, e.role emp_role
        FROM requests r
        JOIN employees e ON e.id = r.emp_id
        WHERE r.status = 'pending'
        ORDER BY r.id DESC
    """)
    regs = q("""
        SELECT r.*, e.emp_no, e.name emp_name, e.department, e.designation, e.role emp_role
        FROM regularizations r
        JOIN employees e ON e.id = r.emp_id
        WHERE r.status = 'pending'
        ORDER BY r.id DESC
    """)
    reimbursements = q("""
        SELECT r.*, e.emp_no, e.name emp_name, e.department, e.designation, e.role emp_role
        FROM reimbursements r
        JOIN employees e ON e.id = r.emp_id
        WHERE r.status = 'pending'
        ORDER BY r.id DESC
    """)
    loans = q("""
        SELECT r.*, e.emp_no, e.name emp_name, e.department, e.designation, e.role emp_role
        FROM loans r
        JOIN employees e ON e.id = r.emp_id
        WHERE r.status = 'pending'
        ORDER BY r.id DESC
    """)
    history = q("""
        SELECT r.*,
               e.emp_no, e.name emp_name, e.department, e.designation, e.role emp_role,
               m.name decider_name, m.designation decider_designation, m.role decider_role
        FROM requests r
        JOIN employees e ON e.id = r.emp_id
        LEFT JOIN employees m ON m.id = r.approver_id
        WHERE r.status IN ('approved', 'rejected')
        ORDER BY r.decided_at DESC
        LIMIT 100
    """)
    reg_history = q("""
        SELECT r.*,
               e.emp_no, e.name emp_name, e.department, e.designation, e.role emp_role,
               m.name decider_name, m.designation decider_designation, m.role decider_role
        FROM regularizations r
        JOIN employees e ON e.id = r.emp_id
        LEFT JOIN employees m ON m.id = r.approver_id
        WHERE r.status IN ('approved', 'rejected')
        ORDER BY r.decided_at DESC
        LIMIT 100
    """)
    if u["role"] in HR_LIKE_ROLES:
        leaves = [x for x in leaves if x["emp_role"] not in EXEC_ROLES]
        regs = [x for x in regs if x["emp_role"] not in EXEC_ROLES]
        reimbursements = [x for x in reimbursements if x["emp_role"] not in EXEC_ROLES]
        loans = [x for x in loans if x["emp_role"] not in EXEC_ROLES]
    return jsonify(leaves=leaves, regularizations=regs, reimbursements=reimbursements, loans=loans, history=history, reg_history=reg_history)


# ---------- executive suite (CEO / COO / CPO) ----------
@app.get("/api/executive/summary")
@auth(EXEC_ROLES)
def exec_summary(u):
    today = date.today().isoformat()
    this_month = today[:7]

    dept_stats = q("""
        SELECT department,
               COUNT(*) total,
               SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) active,
               SUM(CASE WHEN role='hr' THEN 1 ELSE 0 END) hr_count,
               SUM(CASE WHEN role='manager' THEN 1 ELSE 0 END) manager_count
        FROM employees
        GROUP BY department
    """)

    payroll = q("""
        SELECT month,
               COUNT(*) payslips_count,
               COALESCE(SUM(basic), 0) total_basic,
               COALESCE(SUM(hra), 0) total_hra,
               COALESCE(SUM(allowances), 0) total_allowances,
               COALESCE(SUM(pf), 0) total_pf,
               COALESCE(SUM(tax), 0) total_tax,
               COALESCE(SUM(net), 0) total_net
        FROM payslips
        GROUP BY month
        ORDER BY month DESC LIMIT 1
    """, one=True) or {"month": this_month, "payslips_count": 0, "total_basic": 0, "total_hra": 0, "total_allowances": 0, "total_pf": 0, "total_tax": 0, "total_net": 0}

    dept_payroll = q("""
        SELECT e.department,
               COUNT(p.id) employee_count,
               COALESCE(SUM(p.basic + p.hra + p.allowances), 0) gross_spend,
               COALESCE(SUM(p.net), 0) net_payout
        FROM employees e
        JOIN payslips p ON p.emp_id = e.id
        WHERE p.month = (SELECT MAX(month) FROM payslips)
        GROUP BY e.department
    """)

    att_today = q("SELECT status, COUNT(*) count FROM attendance WHERE date=? GROUP BY status", (today,))
    att_map = {r["status"]: r["count"] for r in att_today}

    hr_team = q("""
        SELECT e.id, e.emp_no, e.name, e.email, e.designation, e.department, e.location, e.active, e.join_date,
               m.name manager_name
        FROM employees e
        LEFT JOIN employees m ON m.id = e.manager_id
        WHERE e.role = 'hr'
        ORDER BY e.emp_no
    """)

    resignations = q("""
        SELECT r.*, e.name emp_name, e.department, e.designation
        FROM resignations r
        JOIN employees e ON e.id = r.emp_id
        ORDER BY r.id DESC
    """)

    pending_leaves = q("""
        SELECT r.*, e.name emp_name, e.department, e.role emp_role
        FROM requests r
        JOIN employees e ON e.id = r.emp_id
        WHERE r.status = 'pending'
        ORDER BY r.id DESC
    """)
    pending_regs = q("""
        SELECT r.*, e.name emp_name, e.department, e.role emp_role
        FROM regularizations r
        JOIN employees e ON e.id = r.emp_id
        WHERE r.status = 'pending'
        ORDER BY r.id DESC
    """)
    pending_reimbursements = q("""
        SELECT r.*, e.name emp_name, e.department
        FROM reimbursements r
        JOIN employees e ON e.id = r.emp_id
        WHERE r.status = 'pending'
        ORDER BY r.id DESC
    """)
    pending_loans = q("""
        SELECT r.*, e.name emp_name, e.department
        FROM loans r
        JOIN employees e ON e.id = r.emp_id
        WHERE r.status = 'pending'
        ORDER BY r.id DESC
    """)

    leave_overview = q("""
        SELECT lt.code, lt.name,
               COALESCE(SUM(lg.granted), 0) total_granted,
               COALESCE(SUM(lg.opening_used), 0) total_consumed
        FROM leave_types lt
        LEFT JOIN leave_grants lg ON lg.code = lt.code
        GROUP BY lt.code
    """)

    tickets = q("""
        SELECT category, status, COUNT(*) count
        FROM tickets
        GROUP BY category, status
    """)

    locations = q("""
        SELECT location, COUNT(*) count
        FROM employees
        WHERE active=1
        GROUP BY location
    """)

    return jsonify(
        user_role=u["role"],
        dept_stats=dept_stats,
        payroll=payroll,
        dept_payroll=dept_payroll,
        attendance_today=att_map,
        hr_team=hr_team,
        resignations=resignations,
        pending_leaves=pending_leaves,
        pending_regs=pending_regs,
        pending_reimbursements=pending_reimbursements,
        pending_loans=pending_loans,
        leave_overview=leave_overview,
        tickets=tickets,
        locations=locations
    )


@app.post("/api/attendance/punch")
@auth()
def attendance_punch(u):
    j = body("emp_id", "date", "status")
    run("INSERT INTO attendance(emp_id, date, status) VALUES(?,?,?)", (int(j["emp_id"]), j["date"], j["status"]))
    return jsonify(ok=True)

@app.post("/api/device/push")
def device_push():
    data = request.get_json(silent=True) or {}
    # Log raw payload for protocol analysis
    import logging
    logging.info("DEVICE PUSH: %s", data)
    # realtime_glog contains base64 attendance block
    if data.get("request_code") == "realtime_glog":
        try:
            import base64
            blk = base64.b64decode(data.get("block", ""))
            logging.info("GLOG BLOCK: %s", blk)
        except Exception as e:
            logging.warning("glog decode failed: %s", e)
    return jsonify(ok=True)

@app.get("/api/health")
def health():
    """Cheap liveness check used by the frontend to show a maintenance screen.
    A database failure raises OperationalError, which is answered with a 503."""
    q("SELECT 1 ok", one=True)
    return jsonify(ok=True)


@app.get("/")
def index(): return send_from_directory(ROOT, "index.html")


if __name__ == "__main__":
    db.init()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))

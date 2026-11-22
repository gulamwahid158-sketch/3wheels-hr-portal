import os, functools, smtplib, calendar
from io import BytesIO
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

EXEC_ROLES = ("ceo", "coo", "cpo", "superadmin")
ADMIN_ROLES = ("hr", "ceo", "coo", "cpo", "superadmin")
ROLES = ("employee", "manager", "hr", "ceo", "coo", "cpo", "superadmin")
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
    return lid


def me():
    return q("SELECT * FROM employees WHERE id=? AND active=1", (session.get("uid"),), one=True) if session.get("uid") else None


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


def balances(emp_id):
    out = []
    for t in q("SELECT * FROM leave_types"):
        g = q("SELECT * FROM leave_grants WHERE emp_id=? AND code=?", (emp_id, t["code"]), one=True) or {"granted": 0, "opening_used": 0}
        used = q("SELECT COALESCE(SUM(days),0) s FROM requests WHERE emp_id=? AND code=? AND kind IN('leave','rh') AND status IN('approved','pending')", (emp_id, t["code"]), one=True)["s"]
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
    mgr = q("SELECT name FROM employees WHERE id=?", (u["manager_id"],), one=True)
    u["manager_name"] = mgr["name"] if mgr else None
    u["unread"] = q("SELECT COUNT(*) c FROM notifications WHERE emp_id=? AND is_read=0", (u["id"],), one=True)["c"]
    u["pending_reviews"] = len(pending_reviews(u))
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
        WHERE active=1 AND id!=? AND role IN ('hr','ceo','coo','cpo')
        ORDER BY CASE role WHEN 'hr' THEN 0 WHEN 'ceo' THEN 1 WHEN 'coo' THEN 2 WHEN 'cpo' THEN 3 ELSE 4 END, name
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
    return jsonify(
        holidays=q("SELECT * FROM holidays WHERE date>=? ORDER BY date LIMIT 3", (today,)),
        balances=balances(u["id"]),
        pending_reviews=len(pending_reviews(u)),
        payslip=q("SELECT * FROM payslips WHERE emp_id=? ORDER BY month DESC LIMIT 1", (u["id"],), one=True),
        tasks=q("SELECT * FROM tasks WHERE emp_id=? AND done=0 ORDER BY due_date LIMIT 5", (u["id"],)),
        birthdays=q("SELECT name,dob FROM employees WHERE substr(dob,6,5)=? AND active=1", (date.today().strftime("%m-%d"),)),
        tracking=q("SELECT kind,status,created_at FROM requests WHERE emp_id=? ORDER BY id DESC LIMIT 3", (u["id"],)))


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
    rid = run("INSERT INTO requests(emp_id,kind,code,from_date,to_date,from_session,to_session,days,reason,approver_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
              (u["id"], "leave", j["code"], j["from_date"], j["to_date"], fs, ts, days, j["reason"], approver))
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
              (u["id"], "rh", "RH", j["date"], j["date"], 0, j["reason"], approver_of(u)))
    return jsonify(id=rid)


@app.post("/api/leave/compoff")
@auth()
def compoff_grant(u):
    j = body("date", "reason")
    a = q("SELECT * FROM attendance WHERE emp_id=? AND date=?", (u["id"], j["date"]), one=True)
    if not a or a["status"] not in ("O", "H") or not a["first_in"]:
        raise ValueError("Comp-off needs work recorded on an off day or holiday")
    rid = run("INSERT INTO requests(emp_id,kind,code,from_date,to_date,days,reason,approver_id) VALUES(?,?,?,?,?,?,?,?)",
              (u["id"], "compoff_grant", "CO", j["date"], j["date"], 1, j["reason"], approver_of(u)))
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
              (u["id"], "cancel", r["code"], r["from_date"], r["to_date"], r["days"], j["reason"], r["id"], approver_of(u)))
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
    rows = q("SELECT * FROM attendance WHERE emp_id=? AND substr(date,1,7)=? ORDER BY date", (u["id"], m))
    work = [r for r in rows if r["status"] == "P"]

    def mins(t): h, mi = t.split(":"); return int(h) * 60 + int(mi)
    avg_in = sum(mins(r["first_in"]) for r in work) / len(work) if work else 0
    avg_out = sum(mins(r["last_out"]) for r in work) / len(work) if work else 0
    fmt = lambda x: "%02d:%02d" % divmod(int(x), 60)
    shift_start = mins(u["shift"].split("-")[0])
    summary = dict(present=len(work), absent=sum(r["status"] == "A" for r in rows), leave=sum(r["status"] in ("CL", "L", "CO") for r in rows),
                   holidays=sum(r["status"] == "H" for r in rows), late_in=sum(mins(r["first_in"]) > shift_start + 15 for r in work),
                   avg_first_in=fmt(avg_in) if work else "-", avg_last_out=fmt(avg_out) if work else "-",
                   avg_work_hrs=("%.2f" % ((avg_out - avg_in) / 60)) if work else "-")
    exc = [r["date"] for r in rows if r["status"] == "A"]
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
def regs(u): return jsonify(q("SELECT * FROM regularizations WHERE emp_id=? ORDER BY id DESC", (u["id"],)))


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
    if u["role"] not in ("accounts", "hr", "ceo", "coo", "cpo", "superadmin"):
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
    if u["role"] not in ("accounts", "hr", "ceo", "coo", "cpo", "superadmin"):
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
    rows = q("SELECT id,emp_no,name,email,department,designation,location,join_date,substr(dob,6) dob,skills,manager_id,role FROM employees WHERE active=1 AND (name LIKE ? OR department LIKE ? OR emp_no LIKE ?) ORDER BY name", (s, s, s))
    
    # Pre-fetch all direct reports for team counts and members
    all_reports = q("SELECT id, name, manager_id FROM employees WHERE active=1 AND manager_id IS NOT NULL")
    report_map = {}
    for r in all_reports:
        report_map.setdefault(r["manager_id"], []).append(r["name"])

    # Pre-fetch Casual Leave (CL) balances for each member
    cl_grants = {g["emp_id"]: g for g in q("SELECT * FROM leave_grants WHERE code='CL'")}
    cl_used = {u_row["emp_id"]: u_row["s"] for u_row in q("SELECT emp_id, COALESCE(SUM(days),0) s FROM requests WHERE code='CL' AND kind IN('leave','rh') AND status IN('approved','pending') GROUP BY emp_id")}

    for r in rows:
        mgr = q("SELECT name FROM employees WHERE id=?", (r["manager_id"],), one=True)
        r["manager_name"] = mgr["name"] if mgr else None
        team = report_map.get(r["id"], [])
        r["team_size"] = len(team)
        r["team_members"] = team

        g = cl_grants.get(r["id"])
        granted = g["granted"] if g else 16.0
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
def org(u): return jsonify(q("SELECT id,name,designation,manager_id,role,department FROM employees WHERE active=1"))


# ---------- engage ----------
@app.get("/api/feed")
@auth()
def feed(u):
    posts = q("SELECT p.*, e.name author FROM posts p JOIN employees e ON e.id=p.author_id ORDER BY p.id DESC")
    for p in posts:
        if p["type"] == "poll":
            votes = q("SELECT `option`, COUNT(*) c FROM poll_votes WHERE post_id=? GROUP BY `option`", (p["id"],))
            p["results"] = {v["option"]: v["c"] for v in votes}
            mv = q("SELECT `option` FROM poll_votes WHERE post_id=? AND emp_id=?", (p["id"], u["id"]), one=True)
            p["my_vote"] = mv["option"] if mv else None
    return jsonify(posts)


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
    run("INSERT INTO feedback(from_id,to_id,message) VALUES(?,?,?)", (u["id"], j["to_id"], j["message"]))
    notify(int(j["to_id"]), "You received new feedback")
    return jsonify(ok=True)


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


def pending_reviews(u):
    ids = approver_ids(u); ph = ",".join("?" * len(ids))
    out = []
    for r in q("SELECT r.*, e.name emp_name FROM requests r JOIN employees e ON e.id=r.emp_id WHERE r.approver_id IN (%s) AND r.status='pending'" % ph, ids):
        r["type"] = "request"; out.append(r)
    for r in q("SELECT r.*, e.name emp_name FROM regularizations r JOIN employees e ON e.id=r.emp_id WHERE r.approver_id IN (%s) AND r.status='pending'" % ph, ids):
        r["type"] = "regularization"; out.append(r)
    for t, n in (("reimbursements", "reimbursement"), ("loans", "loan")):
        for r in q("SELECT r.*, e.name emp_name FROM %s r JOIN employees e ON e.id=r.emp_id WHERE r.approver_id IN (%s) AND r.status='pending'" % (t, ph), ids):
            r["type"] = n; out.append(r)
    return out


@app.get("/api/review")
@auth()
def review(u): return jsonify(pending_reviews(u))


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
                while d_ <= t_:
                    c.execute("UPDATE attendance SET status='P' WHERE emp_id=? AND date=? AND status IN('CL','CO')", (r["emp_id"], d_.isoformat()))
                    d_ += timedelta(days=1)
        elif table == "regularizations" and r["kind"] == "regularize":
            c.execute("UPDATE attendance SET status='P',first_in=?,last_out=? WHERE emp_id=? AND date=?", (r["in_time"], r["out_time"], r["emp_id"], r["date"]))
    c.commit(); c.close()
    notify(r["emp_id"], "Your %s request was %s by %s" % (typ, st, decider["name"]))

    # When a manager/TL/lead decides a leave/request, notify HR in real-time
    r_emp = q("SELECT name FROM employees WHERE id=?", (r["emp_id"],), one=True)
    emp_name = r_emp["name"] if r_emp else "Employee"
    req_label = r.get("code") or r.get("kind") or typ
    dates_label = ("%s to %s" % (r["from_date"], r["to_date"])) if "from_date" in r and r.get("from_date") else r.get("date", "")
    if decider["role"] != "hr":
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
    if u["role"] in ("ceo", "coo", "cpo"):
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
    if u["role"] == "hr":
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
    for r in q("SELECT * FROM requests WHERE emp_id=?", (u["id"],)):
        out.append(dict(type=r["kind"], summary="%s %s→%s" % (r["code"], r["from_date"], r["to_date"]), status=r["status"], created_at=r["created_at"]))
    for r in q("SELECT * FROM regularizations WHERE emp_id=?", (u["id"],)):
        out.append(dict(type=r["kind"], summary=r["date"], status=r["status"], created_at=r["created_at"]))
    for r in q("SELECT * FROM reimbursements WHERE emp_id=?", (u["id"],)):
        out.append(dict(type="reimbursement", summary="%s ₹%s" % (r["category"], r["amount"]), status=r["status"], created_at=r["created_at"]))
    for r in q("SELECT * FROM loans WHERE emp_id=?", (u["id"],)):
        out.append(dict(type="loan", summary="₹%s / %s mo" % (r["amount"], r["tenure_months"]), status=r["status"], created_at=r["created_at"]))
    for r in q("SELECT * FROM tickets WHERE emp_id=?", (u["id"],)):
        out.append(dict(type="helpdesk", summary=r["subject"], status=r["status"], created_at=r["created_at"]))
    for r in q("SELECT * FROM resignations WHERE emp_id=?", (u["id"],)):
        out.append(dict(type="resignation", summary=r["last_day"], status=r["status"], created_at=r["created_at"]))
    return jsonify(sorted(out, key=lambda x: x["created_at"] or "", reverse=True))


# ---------- admin & executive control ----------
EXEC_ROLES = ("ceo", "coo", "cpo", "superadmin")
ADMIN_ROLES = ("hr", "ceo", "coo", "cpo", "superadmin")
ROLES = ("employee", "manager", "hr", "ceo", "coo", "cpo", "superadmin")


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
        "e.skills", "e.shift", "e.active",
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
    if u["role"] == "hr" and role in EXEC_ROLES: raise ValueError("HR cannot create executive accounts")
    pdate(j["join_date"])
    mgr = j.get("manager_id") or None
    if mgr and not q("SELECT id FROM employees WHERE id=? AND active=1", (mgr,), one=True): raise ValueError("Manager not found")
    if q("SELECT id FROM employees WHERE email=?", (email,), one=True): raise ValueError("Email already exists")
    n = (q("SELECT MAX(CAST(substr(emp_no,5) AS UNSIGNED)) m FROM employees", one=True)["m"] or 0) + 1
    emp_no = "3WAI%05d" % n
    extras = {f: str(j.get(f) or "").strip() for f in EMP_EXTRA_FIELDS}
    cols = [
        "emp_no", "name", "email", "password_hash", "role", "department",
        "designation", "location", "manager_id", "join_date", "dob", "skills",
        "shift",
    ] + list(EMP_EXTRA_FIELDS)
    vals = [
        emp_no, j["name"].strip(), email, generate_password_hash(j["password"]),
        role, j["department"], j["designation"], j.get("location") or "", mgr,
        j["join_date"], j.get("dob") or "", j.get("skills") or "",
        j.get("shift") or "11:00-20:00",
    ] + [extras[f] for f in EMP_EXTRA_FIELDS]
    eid = run(
        "INSERT INTO employees(%s) VALUES(%s)" % (
            ",".join(cols), ",".join("?" * len(cols))
        ),
        tuple(vals),
    )
    for code, g in (("CL", 16), ("CO", 0), ("LOP", 0)):
        run("INSERT INTO leave_grants(emp_id,code,year,granted,opening_used) VALUES(?,?,?,?,0)", (eid, code, "2026-2027", g))
    notify(eid, "Welcome to 3Wheels AI! Your account is ready.")
    send_welcome_email(email, j["name"].strip(), emp_no, j["password"], role, j["designation"], j["department"])
    return jsonify(id=eid, emp_no=emp_no, email_sent=True)


@app.patch("/api/admin/employees/<int:eid>")
@auth(ADMIN_ROLES)
def a_emp_upd(u, eid):
    j = body()
    e = q("SELECT * FROM employees WHERE id=?", (eid,), one=True)
    if not e: raise ValueError("Employee not found")
    if u["role"] == "hr" and e["role"] in EXEC_ROLES:
        raise ValueError("HR cannot modify executive leadership")
    sets, vals = [], []
    for f in ("department", "designation", "location", "shift", "dob", "skills") + EMP_EXTRA_FIELDS:
        if f in j: sets.append(f + "=?"); vals.append(j[f])
    if "name" in j:
        nm = str(j["name"] or "").strip()
        if not nm: raise ValueError("Name is required")
        sets.append("name=?"); vals.append(nm)
    if "join_date" in j and j["join_date"]:
        pdate(j["join_date"])
        sets.append("join_date=?"); vals.append(j["join_date"])
    if "role" in j:
        if j["role"] not in ROLES: raise ValueError("Invalid role")
        if u["role"] == "hr" and j["role"] in EXEC_ROLES:
            raise ValueError("HR cannot assign executive roles")
        if eid == u["id"] and j["role"] != "hr" and u["role"] == "hr":
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
    return jsonify(ok=True)


@app.post("/api/admin/employees/<int:eid>/password")
@auth(ADMIN_ROLES)
def a_pw(u, eid):
    j = body("password")
    if len(j["password"]) < 8: raise ValueError("Password must be at least 8 characters")
    e = q("SELECT id, role FROM employees WHERE id=?", (eid,), one=True)
    if not e: raise ValueError("Employee not found")
    if u["role"] == "hr" and e["role"] in EXEC_ROLES:
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
        g = grants.get(e["id"], {"granted": 16.0, "opening_used": 0.0})
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
        SELECT e.id, e.emp_no, e.name, e.department, e.designation, e.role,
               m.name manager_name
        FROM employees e
        LEFT JOIN employees m ON m.id = e.manager_id
        WHERE e.active = 1
        ORDER BY e.emp_no
    """)

    STATUS_CODES = ["P", "A", "CL", "CO", "LOP", "H", "O"]

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

    status_codes = ("P", "A", "CL", "CO", "LOP", "H", "O")
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
                    fi = datetime.strptime(rec["first_in"], "%H:%M")
                    lo = datetime.strptime(rec["last_out"], "%H:%M")
                    diff = int((lo - fi).total_seconds() // 60)
                    if diff > 0:
                        total_working_mins += diff
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
    }
    status_fonts = {
        "P": Font(color="006100"),
        "A": Font(color="9C0006"),
        "CL": Font(color="375623"),
        "LOP": Font(bold=True, color="FFFFFF"),
        "H": Font(color="595959"),
        "O": Font(color="808080"),
        "CO": Font(color="595959"),
    }

    wb = Workbook()

    # ---- Sheet 1: Monthly Summary ----
    ws = wb.active
    ws.title = "Monthly Summary"
    summary_headers = [
        "Emp ID", "Name", "Designation", "Department", "Role", "Manager",
        "Present (P)", "Absent (A)", "Casual Leave (CL)", "Comp Off (CO)",
        "Loss of Pay (LOP)", "Holiday (H)", "Weekly Off (O)",
        "Working Hours (hrs)", "Total Days Recorded", "Month",
    ]
    ws.append(summary_headers)
    for r in data:
        ws.append([
            r["emp_no"], r["name"], r["designation"] or "", r["department"] or "",
            (r["role"] or "").upper(), r["manager_name"],
            r["present"], r["absent"], r["casual_leave"], r["comp_off"],
            r["lop"], r["holiday"], r["weekly_off"],
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
        [10, 22, 24, 18, 10, 20, 12, 12, 16, 14, 16, 12, 14, 18, 20, 12], 1
    ):
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = "A1:P%d" % (len(data) + 1)

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
        + ["Present", "Absent", "CL", "CO", "LOP", "Holiday", "Weekly Off",
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
            r["lop"], r["holiday"], r["weekly_off"], r["working_hours"],
            r["total_days"],
        ]
        ws2.append(row)

    for cell in ws2[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = center
        cell.border = border

    date_start_col = 5
    date_end_col = 4 + days_in_month
    summary_end_col = date_end_col + 9
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
    for offset, width in enumerate([9, 8, 6, 6, 6, 8, 10, 14, 10]):
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
        ("CO", "Comp Off"),
    ]
    for idx, (code, label) in enumerate(legend):
        code_cell = ws2.cell(row=legend_row, column=2 + idx * 2, value=code)
        code_cell.fill = status_fills[code]
        code_cell.font = status_fonts[code]
        code_cell.alignment = center
        ws2.cell(row=legend_row, column=3 + idx * 2, value=label)

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
    if u["role"] == "hr" and target["role"] in EXEC_ROLES:
        raise ValueError("HR cannot modify executive attendance")
    pdate(j["date"])
    st = j["status"].strip().upper()
    if st not in ("P", "A", "H", "O", "CL", "CO", "LOP"):
        raise ValueError("Invalid status (use P, A, H, O, CL, CO, or LOP)")
    fi = j.get("first_in")
    lo = j.get("last_out")
    if st == "P":
        shift_parts = (target["shift"] or "10:00-19:00").split("-")
        if not fi: fi = shift_parts[0]
        if not lo: lo = shift_parts[1] if len(shift_parts) > 1 else "19:00"
    else:
        fi, lo = None, None
    run("REPLACE INTO attendance(emp_id, date, status, first_in, last_out) VALUES (?, ?, ?, ?, ?)",
        (emp_id, j["date"], st, fi, lo))
    notify(emp_id, "Your attendance for %s was marked as %s by %s" % (j["date"], st, u["name"]))
    return jsonify(ok=True)


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
    if u["role"] == "hr":
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


@app.get("/")
def index(): return send_from_directory(ROOT, "index.html")


if __name__ == "__main__":
    db.init()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))

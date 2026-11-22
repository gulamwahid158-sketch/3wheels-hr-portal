"""MySQL data layer for PeopleDesk / 3Wheels AI.

Connection settings come from environment variables (or a ``.env`` file in the
project root):

    MYSQL_HOST      default 127.0.0.1
    MYSQL_PORT      default 3306
    MYSQL_USER      default root
    MYSQL_PASSWORD  default ""
    MYSQL_DB        default peopledesk

The ``conn()`` wrapper keeps the small sqlite-style API that ``app.py`` relies
on (``execute(sql, args)``, ``fetchall()``, ``fetchone()``, ``lastrowid``,
``commit()``, ``close()``) while translating ``?`` placeholders to MySQL's
``%s`` and normalising result values (Decimal -> number, datetime -> string).
"""
import os, random
from datetime import date, datetime, timedelta
from decimal import Decimal

import pymysql
from pymysql.cursors import DictCursor
from werkzeug.security import generate_password_hash

from designations import LEGACY_DESIGNATION_MAP, LEGACY_DEPARTMENT_MAP

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _load_dotenv(path=os.path.join(PROJECT_ROOT, ".env")):
    """Minimal .env loader: KEY=VALUE lines, '#' comments, no override of real env."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)


_load_dotenv()


def config():
    return dict(
        host=os.environ.get("MYSQL_HOST", "127.0.0.1"),
        port=int(os.environ.get("MYSQL_PORT", "3306")),
        user=os.environ.get("MYSQL_USER", "root"),
        password=os.environ.get("MYSQL_PASSWORD", ""),
        database=os.environ.get("MYSQL_DB", "peopledesk"),
    )


DB = config()["database"]  # kept for backwards compatibility (name of the database)


# ---------------------------------------------------------------- schema ----
# Every statement gets ENGINE=InnoDB / utf8mb4 appended in init().
SCHEMA = """
CREATE TABLE IF NOT EXISTS employees(
 id INT AUTO_INCREMENT PRIMARY KEY, emp_no VARCHAR(20) UNIQUE, name VARCHAR(120), email VARCHAR(190) UNIQUE, password_hash VARCHAR(255),
 role VARCHAR(20) DEFAULT 'employee', department VARCHAR(100), designation VARCHAR(120), location VARCHAR(100),
 manager_id INT, join_date VARCHAR(10), dob VARCHAR(10), skills TEXT, shift VARCHAR(20) DEFAULT '11:00-20:00', active TINYINT DEFAULT 1,
 INDEX idx_emp_manager(manager_id), INDEX idx_emp_role(role));
CREATE TABLE IF NOT EXISTS leave_types(code VARCHAR(10) PRIMARY KEY, name VARCHAR(60), quota DOUBLE, kind VARCHAR(20));
CREATE TABLE IF NOT EXISTS leave_grants(id INT AUTO_INCREMENT PRIMARY KEY, emp_id INT, code VARCHAR(10), year VARCHAR(12), granted DOUBLE, opening_used DOUBLE DEFAULT 0,
 INDEX idx_grant_emp(emp_id, code));
CREATE TABLE IF NOT EXISTS requests(
 id INT AUTO_INCREMENT PRIMARY KEY, emp_id INT, kind VARCHAR(20), code VARCHAR(10), from_date VARCHAR(10), to_date VARCHAR(10),
 from_session INT DEFAULT 1, to_session INT DEFAULT 2, days DOUBLE, reason TEXT, status VARCHAR(20) DEFAULT 'pending',
 ref_id INT, approver_id INT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, decided_at VARCHAR(40), remark TEXT,
 INDEX idx_req_emp(emp_id), INDEX idx_req_approver(approver_id, status));
CREATE TABLE IF NOT EXISTS holidays(date VARCHAR(10) PRIMARY KEY, name VARCHAR(100), restricted TINYINT DEFAULT 0);
CREATE TABLE IF NOT EXISTS attendance(emp_id INT, date VARCHAR(10), status VARCHAR(5), first_in VARCHAR(5), last_out VARCHAR(5), PRIMARY KEY(emp_id, date));
CREATE TABLE IF NOT EXISTS regularizations(
 id INT AUTO_INCREMENT PRIMARY KEY, emp_id INT, kind VARCHAR(20), date VARCHAR(10), in_time VARCHAR(5), out_time VARCHAR(5), reason TEXT,
 status VARCHAR(20) DEFAULT 'pending', approver_id INT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, decided_at VARCHAR(40),
 INDEX idx_reg_emp(emp_id), INDEX idx_reg_approver(approver_id, status));
CREATE TABLE IF NOT EXISTS payslips(id INT AUTO_INCREMENT PRIMARY KEY, emp_id INT, month VARCHAR(7), basic DOUBLE, hra DOUBLE, allowances DOUBLE, pf DOUBLE, tax DOUBLE, pt DOUBLE, net DOUBLE,
 INDEX idx_payslip_emp(emp_id, month));
CREATE TABLE IF NOT EXISTS payslip_requests(id INT AUTO_INCREMENT PRIMARY KEY, emp_id INT, month VARCHAR(7), status VARCHAR(20) DEFAULT 'pending',
 created_at DATETIME DEFAULT CURRENT_TIMESTAMP, file_path VARCHAR(500), downloaded TINYINT DEFAULT 0, INDEX idx_psr_emp(emp_id));
CREATE TABLE IF NOT EXISTS it_declarations(id INT AUTO_INCREMENT PRIMARY KEY, emp_id INT, fy VARCHAR(10), section VARCHAR(20), description TEXT, amount DOUBLE, status VARCHAR(20) DEFAULT 'declared');
CREATE TABLE IF NOT EXISTS poi(id INT AUTO_INCREMENT PRIMARY KEY, emp_id INT, fy VARCHAR(10), section VARCHAR(20), description TEXT, amount DOUBLE, proof_note TEXT, status VARCHAR(20) DEFAULT 'submitted');
CREATE TABLE IF NOT EXISTS reimbursements(id INT AUTO_INCREMENT PRIMARY KEY, emp_id INT, category VARCHAR(50), amount DOUBLE, bill_date VARCHAR(10), description TEXT, status VARCHAR(20) DEFAULT 'pending', approver_id INT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS loans(id INT AUTO_INCREMENT PRIMARY KEY, emp_id INT, amount DOUBLE, tenure_months INT, reason TEXT, status VARCHAR(20) DEFAULT 'pending', approver_id INT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS salary_revisions(id INT AUTO_INCREMENT PRIMARY KEY, emp_id INT, effective_from VARCHAR(10), old_ctc DOUBLE, new_ctc DOUBLE, note TEXT);
CREATE TABLE IF NOT EXISTS documents(id INT AUTO_INCREMENT PRIMARY KEY, emp_id INT, title VARCHAR(200), category VARCHAR(50), body TEXT, status VARCHAR(20) DEFAULT 'issued', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS tickets(id INT AUTO_INCREMENT PRIMARY KEY, emp_id INT, category VARCHAR(50), subject VARCHAR(200), body TEXT, status VARCHAR(20) DEFAULT 'open', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS kudos(id INT AUTO_INCREMENT PRIMARY KEY, from_id INT, to_id INT, value VARCHAR(50), message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS feedback(id INT AUTO_INCREMENT PRIMARY KEY, from_id INT, to_id INT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS posts(id INT AUTO_INCREMENT PRIMARY KEY, author_id INT, type VARCHAR(10) DEFAULT 'post', body TEXT, options TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS poll_votes(post_id INT, emp_id INT, `option` VARCHAR(100), PRIMARY KEY(post_id, emp_id));
CREATE TABLE IF NOT EXISTS tasks(id INT AUTO_INCREMENT PRIMARY KEY, emp_id INT, title VARCHAR(200), description TEXT, priority VARCHAR(10) DEFAULT 'medium', due_date VARCHAR(10), done TINYINT DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS notifications(id INT AUTO_INCREMENT PRIMARY KEY, emp_id INT, text TEXT, is_read TINYINT DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX idx_notif_emp(emp_id, is_read));
CREATE TABLE IF NOT EXISTS delegates(id INT AUTO_INCREMENT PRIMARY KEY, from_id INT, to_id INT, from_date VARCHAR(10), to_date VARCHAR(10), created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS resignations(id INT AUTO_INCREMENT PRIMARY KEY, emp_id INT, last_day VARCHAR(10), reason TEXT, status VARCHAR(20) DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS email_outbox(id INT AUTO_INCREMENT PRIMARY KEY, to_email VARCHAR(190), subject VARCHAR(255), body TEXT, sent_at DATETIME DEFAULT CURRENT_TIMESTAMP);
"""

# Extra onboarding/profile columns added to employees. New databases get them
# through ensure_columns(); existing databases are upgraded in place.
EMPLOYEE_EXTRA_COLUMNS = [
    ("personal_email", "VARCHAR(190)"),
    ("alternate_phone", "VARCHAR(20)"),
    ("phone", "VARCHAR(20)"),
    ("father_name", "VARCHAR(120)"),
    ("mother_name", "VARCHAR(120)"),
    ("gender", "VARCHAR(30)"),
    ("marital_status", "VARCHAR(30)"),
    ("blood_group", "VARCHAR(10)"),
    ("nationality", "VARCHAR(60)"),
    ("current_address", "TEXT"),
    ("permanent_address", "TEXT"),
    ("emergency_contact_name", "VARCHAR(120)"),
    ("emergency_contact_phone", "VARCHAR(20)"),
    ("emergency_contact_relation", "VARCHAR(30)"),
    ("aadhaar_no", "VARCHAR(20)"),
    ("pan_no", "VARCHAR(20)"),
    ("uan_no", "VARCHAR(20)"),
    ("esi_no", "VARCHAR(20)"),
    ("bank_name", "VARCHAR(120)"),
    ("bank_account_no", "VARCHAR(40)"),
    ("ifsc_code", "VARCHAR(20)"),
    ("branch_name", "VARCHAR(120)"),
    ("qualification", "VARCHAR(120)"),
    ("previous_company", "VARCHAR(120)"),
    ("previous_experience", "VARCHAR(60)"),
    ("employment_type", "VARCHAR(30)"),
    ("work_mode", "VARCHAR(30)"),
]


# ----------------------------------------------------------- connection ----
def _clean(v):
    """Normalise MySQL driver values so JSON/arithmetic behave like before."""
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, timedelta):
        total = int(v.total_seconds())
        return "%02d:%02d:%02d" % (total // 3600, total % 3600 // 60, total % 60)
    if isinstance(v, (bytes, bytearray)):
        return v.decode("utf-8", "replace")
    return v


def _clean_row(row):
    return {k: _clean(v) for k, v in row.items()} if row is not None else None


def _translate(sql, args):
    """``?`` placeholders -> ``%s``; literal ``%`` escaped when params are used."""
    if args:
        return sql.replace("%", "%%").replace("?", "%s")
    return sql


class _Result:
    def __init__(self, cur):
        self._cur = cur
        self.lastrowid = cur.lastrowid
        self.rowcount = cur.rowcount

    def fetchall(self):
        return [_clean_row(r) for r in self._cur.fetchall()]

    def fetchone(self):
        return _clean_row(self._cur.fetchone())

    def __iter__(self):
        return iter(self.fetchall())


class Conn:
    """Thin wrapper giving pymysql a sqlite3-like surface."""

    def __init__(self, raw):
        self._raw = raw

    def execute(self, sql, args=()):
        cur = self._raw.cursor()
        cur.execute(_translate(sql, args), tuple(args) if args else None)
        return _Result(cur)

    def executemany(self, sql, seq):
        seq = [tuple(a) for a in seq]
        cur = self._raw.cursor()
        if seq:
            cur.executemany(_translate(sql, seq[0]), seq)
        return _Result(cur)

    def executescript(self, script):
        for stmt in script.split(";"):
            if stmt.strip():
                self.execute(stmt.strip())

    def commit(self):
        self._raw.commit()

    def rollback(self):
        self._raw.rollback()

    def close(self):
        try:
            self._raw.close()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        if exc[0] is None:
            self.commit()
        else:
            self.rollback()
        self.close()


def _connect(database=None):
    cfg = config()
    if database is not None:
        cfg["database"] = database
    if not cfg["database"]:
        cfg.pop("database")
    return pymysql.connect(cursorclass=DictCursor, charset="utf8mb4", autocommit=False, **cfg)


def conn():
    """Open a new connection to the configured database."""
    return Conn(_connect())


def columns(table):
    """Column names of ``table`` (replaces sqlite's PRAGMA table_info)."""
    c = conn()
    try:
        return [r["Field"] for r in c.execute("SHOW COLUMNS FROM `%s`" % table).fetchall()]
    finally:
        c.close()


def ensure_columns(c):
    existing = {r["Field"] for r in c.execute("SHOW COLUMNS FROM employees").fetchall()}
    for name, typ in EMPLOYEE_EXTRA_COLUMNS:
        if name not in existing:
            c.execute("ALTER TABLE employees ADD COLUMN %s %s" % (name, typ))


def init(reset=False):
    """Create the database/tables if missing and seed demo data on first run."""
    name = config()["database"]
    admin = Conn(_connect(database=""))
    try:
        if reset:
            admin.execute("DROP DATABASE IF EXISTS `%s`" % name)
        admin.execute("CREATE DATABASE IF NOT EXISTS `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" % name)
        admin.commit()
    finally:
        admin.close()

    c = conn()
    try:
        for stmt in SCHEMA.split(";"):
            if stmt.strip():
                c.execute(stmt.strip() + " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci")
        ensure_columns(c)
        if c.execute("SELECT COUNT(*) c FROM employees").fetchone()["c"] == 0:
            seed(c)
        migrate(c)
        c.commit()
    finally:
        c.close()


def migrate(c):
    """Bring older demo records in line with the designation master list."""
    for old, new in LEGACY_DESIGNATION_MAP.items():
        c.execute("UPDATE employees SET designation=? WHERE designation=?", (new, old))
    for old, new in LEGACY_DEPARTMENT_MAP.items():
        c.execute("UPDATE employees SET department=? WHERE department=?", (new, old))


def d(s): return date.fromisoformat(s)


# ------------------------------------------------------------------ seed ----
def seed(c):
    pw = generate_password_hash("demo123")
    people = [  # emp_no, name, email, role, dept, designation, location, manager_no
        ("PD0001", "Rhea Kapoor", "hr@example.com", "hr", "Human Resources", "HR Head", "Lucknow", None),
        ("PD0002", "Vikram Sen", "manager@example.com", "manager", "Technical", "Technical Manager", "Lucknow", None),
        ("PD0003", "Komal Tiwari", "komal@example.com", "employee", "Technical", "Software Engineer", "Lucknow", "PD0002"),
        ("PD0004", "Aarav Mehta", "aarav@example.com", "employee", "Technical", "Frontend Developer", "Lucknow", "PD0002"),
        ("PD0005", "Isha Nair", "isha@example.com", "employee", "Technical", "Software Engineer", "Noida", "PD0002"),
        ("PD0006", "Kabir Rao", "kabir@example.com", "employee", "Technical", "CAD Designer", "Noida", "PD0002"),
        ("PD0007", "Meera Joshi", "meera@example.com", "employee", "Human Resources", "HR Recruiter", "Lucknow", "PD0001"),
        ("PD0008", "Neil D'Souza", "neil@example.com", "employee", "Accounts & Finance", "Accountant", "Lucknow", "PD0001"),
        ("PD0009", "Rajesh Singhania", "ceo@example.com", "ceo", "Executive", "Chief Executive Officer", "Lucknow", None),
        ("PD0010", "Ananya Verma", "coo@example.com", "coo", "Operations", "Chief Operating Officer", "Lucknow", None),
        ("PD0011", "Priya Sharma", "cpo@example.com", "cpo", "Human Resources", "Chief People Officer", "Lucknow", None),
    ]
    ids = {}
    for n, name, em, role, dept, des, loc, mgr in people:
        cur = c.execute("INSERT INTO employees(emp_no,name,email,password_hash,role,department,designation,location,manager_id,join_date,dob,skills) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (n, name, em, pw, role, dept, des, loc, ids.get(mgr), "2025-%02d-10" % (len(ids) % 12 + 1), "1998-%02d-%02d" % (len(ids) % 12 + 1, len(ids) + 5), "Leadership, Strategy" if role in ("ceo", "coo", "cpo") else "JavaScript, HTML, CSS"))
        ids[n] = cur.lastrowid
    komal = ids["PD0003"]
    # Co-equal C-Suite: CEO, COO, CPO have manager_id = None (Equal top roots)
    # HR Head (Rhea Kapoor) reports to CPO (Priya Sharma)
    c.execute("UPDATE employees SET manager_id=? WHERE emp_no='PD0001'", (ids["PD0011"],))
    # Engineering Manager (Vikram Sen) reports to COO (Ananya Verma)
    c.execute("UPDATE employees SET manager_id=? WHERE emp_no='PD0002'", (ids["PD0010"],))

    c.executemany("INSERT INTO leave_types(code,name,quota,kind) VALUES(?,?,?,?)", [
        ("CL", "Casual Leave", 16, "leave"), ("CO", "Compensatory Off", 0, "compoff"), ("LOP", "Loss Of Pay", 0, "lop")])
    for e in ids.values():
        c.execute("INSERT INTO leave_grants(emp_id,code,year,granted,opening_used) VALUES(?,?,?,?,?)", (e, "CL", "2026-2027", 16, 14 if e == komal else 3))
        c.execute("INSERT INTO leave_grants(emp_id,code,year,granted,opening_used) VALUES(?,?,?,?,?)", (e, "CO", "2026-2027", 3.5 if e == komal else 0, 2 if e == komal else 0))
        c.execute("INSERT INTO leave_grants(emp_id,code,year,granted,opening_used) VALUES(?,?,?,?,?)", (e, "LOP", "2026-2027", 0, 0))

    c.executemany("INSERT INTO holidays(date,name,restricted) VALUES(?,?,?)", [
        ("2026-05-28", "Eid-ul-Azha", 0), ("2026-08-15", "Independence Day", 0), ("2026-08-28", "Rakshabandhan", 0),
        ("2026-10-02", "Gandhi Jayanti", 0), ("2026-10-20", "Dussehra", 0), ("2026-11-09", "Diwali", 0),
        ("2026-12-25", "Christmas", 0), ("2027-01-14", "Makar Sankranti", 1), ("2027-03-03", "Holi", 1)])
    hol = {r["date"] for r in c.execute("SELECT date FROM holidays WHERE restricted=0").fetchall()}

    # attendance 1 Oct - 21 Nov 2026 (mirrors the dump: CL on 10-12 Nov, absent 20 Nov)
    cl = {"2026-11-10", "2026-11-11", "2026-11-12"}
    rnd = random.Random(7)
    day = date(2026, 10, 1)
    rows = []
    while day <= date(2026, 11, 21):
        s = day.isoformat()
        for e in ids.values():
            if day.weekday() == 6 or (day.weekday() == 5 and day.day in range(1, 8)):  # Sunday / 1st Saturday
                st, fi, lo = "O", None, None
            elif s in hol: st, fi, lo = "H", None, None
            elif e == komal and s in cl: st, fi, lo = "CL", None, None
            elif e == komal and s == "2026-11-20": st, fi, lo = "A", None, None
            else:
                st = "P"; fi = "%02d:%02d" % (9, rnd.randint(30, 59)); lo = "%02d:%02d" % (18, rnd.randint(10, 59))
            rows.append((e, s, st, fi, lo))
        day += timedelta(days=1)
    c.executemany("INSERT INTO attendance(emp_id,date,status,first_in,last_out) VALUES(?,?,?,?,?)", rows)

    for e in ids.values():
        for m in ("2026-08", "2026-09", "2026-10"):
            basic = 40000.0; hra = 16000.0; al = 9000.0; pf = 4800.0; tax = 3200.0; pt = 200.0
            c.execute("INSERT INTO payslips(emp_id,month,basic,hra,allowances,pf,tax,pt,net) VALUES(?,?,?,?,?,?,?,?,?)", (e, m, basic, hra, al, pf, tax, pt, basic + hra + al - pf - tax - pt))
    c.execute("INSERT INTO salary_revisions(emp_id,effective_from,old_ctc,new_ctc,note) VALUES(?,?,?,?,?)", (komal, "2026-04-01", 720000, 780000, "Annual appraisal"))
    c.execute("INSERT INTO it_declarations(emp_id,fy,section,description,amount) VALUES(?,?,?,?,?)", (komal, "2026-27", "80C", "ELSS mutual funds", 60000))
    c.execute("INSERT INTO reimbursements(emp_id,category,amount,bill_date,description,status) VALUES(?,?,?,?,?,?)", (komal, "Internet", 999, "2026-10-28", "Broadband bill", "approved"))

    c.execute("INSERT INTO documents(emp_id,title,category,body) VALUES(?,?,?,?)", (komal, "Offer Letter", "Letters", "Offer of employment as Software Engineer."))
    c.execute("INSERT INTO documents(emp_id,title,category,body) VALUES(?,?,?,?)", (None, "Leave Policy 2026", "Policies", "Casual leave: 16 days per year. Comp-off valid for 60 days."))
    c.execute("INSERT INTO documents(emp_id,title,category,body) VALUES(?,?,?,?)", (None, "Code of Conduct", "Policies", "Be respectful. Protect company data."))

    c.execute("INSERT INTO posts(author_id,type,body) VALUES(?,?,?)", (ids["PD0001"], "post", "Welcome to 3Wheels AI! Say hi to our new joiners."))
    c.execute("INSERT INTO posts(author_id,type,body,options) VALUES(?,?,?,?)", (ids["PD0001"], "poll", "Team outing destination?", "Goa|Manali|Jaipur"))
    c.execute("INSERT INTO kudos(from_id,to_id,value,message) VALUES(?,?,?,?)", (ids["PD0002"], komal, "Ownership", "Great job closing the release on time!"))
    c.execute("INSERT INTO tasks(emp_id,title,priority,due_date) VALUES(?,?,?,?)", (komal, "Submit IT declaration", "high", "2026-12-15"))
    c.execute("INSERT INTO notifications(emp_id,text) VALUES(?,?)", (komal, "Payroll for November will be released on 30 Nov."))
    c.execute("INSERT INTO tickets(emp_id,category,subject,body) VALUES(?,?,?,?)", (komal, "IT", "Laptop charger", "Charger stopped working."))

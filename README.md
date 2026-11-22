# 3Wheels AI — HR self-service & executive portal

Employee self-service and enterprise governance app (leave, attendance, salary, people, engagement, helpdesk, team view, casual leave management, email credential dispatching) with full manager, HR, and C-Suite executive control (CEO, COO, CPO).
Branded as **3Wheels AI**.

## Run
Needs a MySQL 8.x server. Copy `.env.example` to `.env` and fill in `MYSQL_*` (the app
creates the database and tables on first start, and seeds demo data if `employees` is empty).
```
pip install -r requirements.txt
python backend/app.py      # http://localhost:5000
python -m pytest tests     # uses a separate `peopledesk_test` database (dropped each run)
```
One-time setup on a fresh MySQL (as root):
```sql
CREATE USER 'peopledesk'@'localhost' IDENTIFIED BY 'change-me';
GRANT ALL PRIVILEGES ON peopledesk.* TO 'peopledesk'@'localhost';
GRANT ALL PRIVILEGES ON peopledesk_test.* TO 'peopledesk'@'localhost';
```
Moving from the old SQLite file: `python migrate_sqlite_to_mysql.py` (copies `backend/peopledesk.db` into MySQL; re-runnable).

## Deploy
Production entry point is `backend/wsgi.py` (`gunicorn --chdir backend wsgi:app`). A Render blueprint
(`render.yaml`) and a `Procfile` are included; step-by-step instructions for **Render + Hostinger MySQL +
`hr.3wheels.ai` subdomain** are in [docs/DEPLOY.md](docs/DEPLOY.md). Shared PHP hosting cannot run this app.
Demo logins (password `demo123`):
- **Executives (Co-Equal C-Suite Leadership & Full HR Control):** `ceo@example.com` (CEO), `coo@example.com` (COO), `cpo@example.com` (CPO)
- **HR & Staff:** `hr@example.com` (HR Head), `manager@example.com` (Manager), `komal@example.com` (Employee).
Set `SECRET_KEY` env var for any real use; the seeded demo passwords are for local testing only.

## Layout
- `backend/db.py` — MySQL schema (PyMySQL) + seed (balances/holidays/attendance mirror the dump: CL 14/16 used, Comp Off 1.5 left, 20 Nov absent). `.env` is read here.
- `migrate_sqlite_to_mysql.py` — copies an old `peopledesk.db` into MySQL
- `backend/app.py` — REST API (auth, leave, attendance, salary, people, engage, tasks, review/approvals, request hub)
- `frontend/` — plain JS single-page app, no build step. One renderer per screen in `app.js` (`P.<route>`)
- `docs/PAGE_MAP.md` — which dump file became which screen
- `reference/` — original saved HTML (`raw_html/`) and extracted text (`text/`)

## Rules implemented
Leave: working-day counting (skips Sundays/public holidays, half-day sessions), balance check, overlap check, approve → attendance updated, cancel needs approval (pending leave cancels instantly), comp-off grant adds balance on approval, restricted holiday limit 2.
Attendance: monthly summary, exception days, regularization/permission → approval updates the day.
Workflow Delegates: hand your approvals to a colleague for a date range (never self-approve). Only the assigned approver (or active delegate) can decide a request; feedback sender is hidden from the receiver.

## Not built yet
Real file uploads (POI/documents), email notifications, payroll generation, admin screens (create employees, grant leave), password change. Passwords are hashed; add rate limiting + HTTPS before any real deployment.

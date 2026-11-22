# Deploying the HR portal (Render + Hostinger MySQL)

The app is Flask (Python) + MySQL. Hostinger **shared hosting only runs PHP/static files**, so the
Git deploy there (`public_html/hr`) will not start the backend. Instead:

| Piece | Where | Why |
|---|---|---|
| Python app | **Render** (free web service) | runs `gunicorn`, auto-deploys from GitHub |
| MySQL | **Hostinger** database (already in your plan) | no extra cost; enable *Remote MySQL* |
| Domain | `hr.3wheels.ai` CNAME → Render | nice URL, free TLS from Render |

## 1. MySQL on Hostinger
1. hPanel → **Databases → Management** → *Create new database*: name `u123456_hr`, user `u123456_hr`, strong password. Note all three (Hostinger prefixes them with your account id).
2. hPanel → **Databases → Remote MySQL** → add host `%` (any host) for that database. Note the **hostname** shown there (e.g. `srv1234.hstgr.io`), not `localhost`.
3. Optional: test from your PC — `mysql -h srv1234.hstgr.io -u u123456_hr -p u123456_hr`.

The app creates all tables itself on first start and seeds the demo users when the `employees` table
is empty. To bring your existing local data instead, run on your PC with the Hostinger values in `.env`:
`python migrate_sqlite_to_mysql.py --wipe` (from SQLite) — or dump/restore your local MySQL with
`mysqldump peopledesk | mysql -h <host> -u <user> -p <db>`.

## 2. App on Render
1. https://render.com → sign up with GitHub → **New + → Blueprint** → choose `3wheels-hr-portal`.
2. Render reads `render.yaml`. When prompted, enter:
   - `MYSQL_HOST` = Hostinger hostname (step 1.2)
   - `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DB` = from step 1.1
   - `SECRET_KEY` is generated automatically; `PORTAL_URL` defaults to `https://hr.3wheels.ai` (change if you use another domain).
3. Click **Apply**. First build takes ~2 min. Open the `*.onrender.com` URL and log in with a demo account
   (`ceo@example.com` / `demo123`) — then change those passwords from Admin.

Every `git push` to `main` redeploys automatically.

## 3. Subdomain `hr.3wheels.ai`
1. Render → your service → **Settings → Custom Domains → Add** `hr.3wheels.ai`. Render shows a CNAME target like `3wheels-hr-portal.onrender.com`.
2. hPanel → **Domains → DNS / Nameservers** → add record: Type `CNAME`, Name `hr`, Target `<that>.onrender.com`, TTL default.
3. Wait for DNS (5–30 min). Render issues the TLS certificate automatically; the site is then live at `https://hr.3wheels.ai`.

## Notes / limits
- **Free Render tier sleeps** after 15 min idle; the first request afterwards takes ~30 s. Upgrade to Starter ($7/mo) to avoid that.
- **Uploaded payslip PDFs** are stored on local disk (`backend/uploads/`), which is wiped on every Render deploy/restart. For real use move them to object storage (S3/Backblaze) or a Render persistent disk (paid).
- **Email**: set `SMTP_HOST/PORT/USER/PASS/FROM` in Render → Environment to actually send welcome and payslip mails (Hostinger email SMTP works: `smtp.hostinger.com`, port 587).
- Connections: the app opens a short MySQL connection per query. Hostinger shared MySQL allows a limited number of concurrent connections; the `--workers 2 --threads 4` gunicorn setting keeps that well within limits.
- You can delete the Git deployment on Hostinger (`public_html/hr`) — it serves no purpose for this app.

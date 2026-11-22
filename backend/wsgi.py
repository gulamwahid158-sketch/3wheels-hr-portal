"""WSGI entry point for production servers (gunicorn / waitress).

    gunicorn --chdir backend wsgi:app

Creates tables (and seeds demo data on an empty database) once at startup,
same as running ``python backend/app.py`` locally.
"""
import pymysql

import db
from app import app  # noqa: F401  (re-exported for the WSGI server)

try:
    db.init()
except pymysql.err.OperationalError as e:
    # Database temporarily unreachable (e.g. hourly connection limit on hosted
    # MySQL). Keep the server up: requests answer 503 until the database is back,
    # instead of the whole deploy failing its health check.
    print("[startup] db.init() skipped, database unavailable:", e)

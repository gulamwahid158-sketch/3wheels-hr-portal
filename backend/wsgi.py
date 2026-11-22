"""WSGI entry point for production servers (gunicorn / waitress).

    gunicorn --chdir backend wsgi:app

Creates tables (and seeds demo data on an empty database) once at startup,
same as running ``python backend/app.py`` locally.
"""
import db
from app import app  # noqa: F401  (re-exported for the WSGI server)

db.init()

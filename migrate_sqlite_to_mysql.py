"""One-off: copy data from the old SQLite file into MySQL.

Usage (from the project root, with MYSQL_* set in .env or the environment):

    python migrate_sqlite_to_mysql.py                      # uses backend/peopledesk.db
    python migrate_sqlite_to_mysql.py --sqlite path/to.db  # another file
    python migrate_sqlite_to_mysql.py --wipe               # empty MySQL tables first

Rows are written with REPLACE INTO, so re-running is safe (existing ids are
overwritten, nothing is duplicated). Only columns that exist on both sides are
copied, and tables missing in SQLite are skipped.
"""
import argparse, os, sqlite3, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "backend"))
import db  # noqa: E402

TABLES = [
    "employees", "leave_types", "leave_grants", "requests", "holidays", "attendance",
    "regularizations", "payslips", "payslip_requests", "it_declarations", "poi",
    "reimbursements", "loans", "salary_revisions", "documents", "tickets", "kudos",
    "feedback", "posts", "poll_votes", "tasks", "notifications", "delegates",
    "resignations", "email_outbox",
]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sqlite", default=os.path.join(HERE, "backend", "peopledesk.db"))
    ap.add_argument("--wipe", action="store_true", help="TRUNCATE each MySQL table before copying")
    a = ap.parse_args()

    if not os.path.exists(a.sqlite):
        sys.exit("SQLite file not found: %s" % a.sqlite)

    print("MySQL target :", "%(user)s@%(host)s:%(port)s/%(database)s" % db.config())
    print("SQLite source:", a.sqlite)
    db.init()  # make sure database + tables exist (seeds only if employees is empty)

    src = sqlite3.connect(a.sqlite)
    src.row_factory = sqlite3.Row
    have = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'")}

    dst = db.conn()
    try:
        if a.wipe:
            for t in TABLES:
                dst.execute("TRUNCATE TABLE `%s`" % t)
            dst.commit()
            print("Wiped all MySQL tables.")

        total = 0
        for t in TABLES:
            if t not in have:
                print("%-18s skipped (not in SQLite)" % t); continue
            rows = src.execute("SELECT * FROM %s" % t).fetchall()
            if not rows:
                print("%-18s 0 rows" % t); continue
            src_cols = rows[0].keys()
            dst_cols = set(db.columns(t))
            cols = [c for c in src_cols if c in dst_cols]
            if not cols:
                print("%-18s skipped (no common columns)" % t); continue
            col_sql = ",".join("`%s`" % c for c in cols)
            sql = "REPLACE INTO `%s`(%s) VALUES(%s)" % (t, col_sql, ",".join("?" * len(cols)))
            dst.executemany(sql, [tuple(r[c] for c in cols) for r in rows])
            dst.commit()
            total += len(rows)
            print("%-18s %5d rows" % (t, len(rows)))
        print("\nDone. %d rows copied." % total)
    finally:
        dst.close()
        src.close()


if __name__ == "__main__":
    main()

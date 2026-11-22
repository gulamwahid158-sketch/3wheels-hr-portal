import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend"))
import db

print("MySQL:", "%(user)s@%(host)s:%(port)s/%(database)s" % db.config())
c = db.conn()
tables = [list(r.values())[0] for r in c.execute("SHOW TABLES").fetchall()]
print("Tables:", tables)

emps = c.execute("SELECT id, name, role FROM employees ORDER BY id").fetchall()
print("Employees:")
for r in emps:
    print(" ", r["id"], r["name"], r["role"])
c.close()

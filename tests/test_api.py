import os, sys
# Tests run against a throw-away MySQL database (dropped and recreated each run).
# Connection settings come from MYSQL_* env vars / .env; only the DB name is forced.
os.environ["MYSQL_DB"] = os.environ.get("MYSQL_TEST_DB", "peopledesk_test")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
import db, app as A
db.init(reset=True)
def login(em):
    c = A.app.test_client(); r = c.post("/api/login", json={"email": em, "password": "demo123"}); assert r.status_code == 200; return c

def test_auth():
    c = A.app.test_client()
    assert c.get("/api/me").status_code == 401
    assert c.post("/api/login", json={"email": "komal@example.com", "password": "x"}).status_code == 401

def test_balances_match_dump():
    c = login("komal@example.com")
    b = {x["code"]: x for x in c.get("/api/leave/balances").get_json()}
    assert b["CL"]["granted"] == 16 and b["CL"]["balance"] == 2 and b["CO"]["balance"] == 1.5

def test_leave_flow():
    k, m = login("komal@example.com"), login("manager@example.com")
    r = k.post("/api/leave/apply", json={"code": "CL", "from_date": "2026-12-01", "to_date": "2026-12-02", "reason": "trip"})
    assert r.status_code == 200 and r.get_json()["days"] == 2
    assert k.post("/api/leave/apply", json={"code": "CL", "from_date": "2026-12-01", "to_date": "2026-12-01", "reason": "x"}).status_code == 400  # overlap
    assert k.post("/api/leave/apply", json={"code": "CL", "from_date": "2026-12-10", "to_date": "2026-12-11", "reason": "x"}).status_code == 400  # insufficient (0 left)
    rid = r.get_json()["id"]
    assert k.post("/api/review/request/%d" % rid, json={"action": "approve"}).status_code == 404  # not approver
    assert m.post("/api/review/request/%d" % rid, json={"action": "approve"}).status_code == 200
    c = k.post("/api/leave/cancel", json={"request_id": rid, "reason": "plans changed"}).get_json()
    assert m.post("/api/review/request/%d" % c["id"], json={"action": "approve"}).status_code == 200
    assert next(x for x in k.get("/api/leave/balances").get_json() if x["code"] == "CL")["balance"] == 2

def test_validation():
    k = login("komal@example.com")
    assert k.post("/api/leave/apply", json={"code": "CL", "from_date": "2026-12-05", "to_date": "2026-12-01", "reason": "x"}).status_code == 400
    assert k.post("/api/reimbursement", json={"category": "Taxi", "amount": -5, "bill_date": "2026-11-01"}).status_code == 400
    assert k.post("/api/kudos", json={"to_id": 3, "value": "x", "message": "y"}).status_code == 400  # self

def test_regularization_and_attendance():
    k, m = login("komal@example.com"), login("manager@example.com")
    a = k.get("/api/attendance?month=2026-11").get_json()
    # demo data ends on 21 Nov; days after it with no punch are Leave now, so only check what the demo itself sets
    assert "2026-11-20" in a["exceptions"] and a["summary"]["absent"] == 1 and a["summary"]["leave"] >= 3
    r = k.post("/api/regularization", json={"kind": "regularize", "date": "2026-11-20", "in_time": "11:00", "out_time": "20:00", "reason": "forgot"}).get_json()
    assert m.post("/api/review/regularization/%d" % r["id"], json={"action": "approve"}).status_code == 200
    assert k.get("/api/attendance?month=2026-11").get_json()["summary"]["absent"] == 0

def test_no_punch_half_day_and_regularize_from_exception():
    import biometric
    # the working day is 9 hours: 9 h or more = Present, 4.5 to 9 h = Half Day, under 4.5 h or one punch = Leave
    assert [biometric.classify(a, b) for a, b in (("10:00", "19:00"), ("10:00", "14:30"), ("11:00", "11:00"), ("10:00", "14:29"), ("20:10", "05:02"), ("10:00", "18:59"), ("20:00", "05:00"), ("12:11", "15:39"))] == ["P", "HD", "L", "L", "HD", "HD", "P", "L"]
    ceo = login("ceo@example.com")
    nia = ceo.post("/api/admin/employees", json={"department": "Technical", "designation": "AI Engineer", "join_date": "2026-05-18", "password": "longenough1",
                   "role": "employee", "name": "Nia Noon", "email": "nia@example.com", "biometric_id": "8801"}).get_json()["id"]
    def punch(day, *times):
        for t in times: A.run("INSERT IGNORE INTO biometric_punches(enno,punch_at,name,machine) VALUES('8801',?,'nia','2')", ("%s %s:00" % (day, t),))
    punch("2026-09-01", "10:00", "19:00"); punch("2026-09-02", "10:00", "14:30"); punch("2026-09-03", "11:00")      # full day, half day, one punch only
    A.run("INSERT INTO requests(emp_id,kind,code,from_date,to_date,days,reason,status) VALUES(?,?,?,?,?,?,?,?)", (nia, "leave", "CL", "2026-09-07", "2026-09-07", 1, "trip", "approved"))
    A.rebuild_attendance(nia)
    n = A.app.test_client(); assert n.post("/api/login", json={"email": "nia@example.com", "password": "longenough1"}).status_code == 200
    a = n.get("/api/attendance?month=2026-09").get_json()
    st = {d["date"]: d["status"] for d in a["days"]}
    assert (st["2026-09-01"], st["2026-09-02"], st["2026-09-03"]) == ("P", "HD", "L")
    assert st["2026-09-04"] == "L"                      # Friday, nobody punched: Leave
    assert st["2026-09-06"] == "H"                      # Sunday
    assert st["2026-09-07"] == "CL"                     # approved leave is kept, not turned into Leave (no punch)
    assert a["summary"]["half_day"] == 1 and {"2026-09-02", "2026-09-03", "2026-09-04"} <= set(a["exceptions"]) and "2026-09-07" not in a["exceptions"]
    ov = next(r for r in ceo.get("/api/admin/attendance-overview?month=2026-09").get_json() if r["emp_id"] == nia)
    assert ov["half_day"] == 1 and ov["leave_no_punch"] >= 2 and ov["present"] == 1
    # regularize a no-punch day, a half day and a one-punch day: the approved times replace what the machine said
    for day in ("2026-09-02", "2026-09-03", "2026-09-04"):
        r = n.post("/api/regularization", json={"kind": "regularize", "date": day, "in_time": "10:00", "out_time": "19:00", "reason": "was in office"}).get_json()
        assert ceo.post("/api/review/regularization/%d" % r["id"], json={"action": "approve"}).status_code == 200
    A.rebuild_attendance(nia)                           # importing again must not undo an approved regularization
    rows = {d["date"]: d for d in n.get("/api/attendance?month=2026-09").get_json()["days"]}
    for day in ("2026-09-02", "2026-09-03", "2026-09-04"):
        assert (rows[day]["status"], rows[day]["first_in"], rows[day]["last_out"]) == ("P", "10:00", "19:00"), day
    assert n.get("/api/attendance?month=2026-09").get_json()["summary"]["half_day"] == 0
    A.run("DELETE FROM biometric_punches WHERE enno='8801'")          # other tests count the stored punches
    A.run("UPDATE employees SET biometric_id=NULL WHERE id=?", (nia,))   # ... and the linked employees


def test_pending_count_matches_list_and_me_cache_follows_changes():
    k = login("komal@example.com"); m = login("manager@example.com")
    k.post("/api/leave/apply", json={"code": "CL", "from_date": "2026-12-14", "to_date": "2026-12-14", "reason": "x"})
    mgr = A.q("SELECT * FROM employees WHERE email='manager@example.com'", one=True)
    assert A.pending_review_count(mgr) == len(A.pending_reviews(mgr)) >= 1
    assert m.get("/api/me").get_json()["pending_reviews"] == A.pending_review_count(mgr)
    # the remembered user row must not hide a change: role edits and deactivation show up at once
    ceo = login("ceo@example.com")
    assert m.get("/api/me").get_json()["role"] == "manager"
    assert ceo.patch("/api/admin/employees/%d" % mgr["id"], json={"role": "employee"}).status_code == 200
    assert m.get("/api/me").get_json()["role"] == "employee"
    assert ceo.patch("/api/admin/employees/%d" % mgr["id"], json={"role": "manager"}).status_code == 200
    assert ceo.patch("/api/admin/employees/%d" % mgr["id"], json={"active": False}).status_code == 200
    assert m.get("/api/me").status_code == 401
    assert ceo.patch("/api/admin/employees/%d" % mgr["id"], json={"active": True}).status_code == 200


def test_misc_endpoints():
    k = login("komal@example.com")
    for p in ["home", "holidays", "payslips", "ytd", "it-statement", "people", "orgchart", "feed", "kudos", "feedback", "tasks", "review", "request-hub", "documents", "salary-revisions", "leave/calendar", "notifications", "loans", "tickets"]:
        assert k.get("/api/" + p).status_code == 200, p

def test_delegation():
    k, m, h = login("komal@example.com"), login("manager@example.com"), login("hr@example.com")
    rid = k.post("/api/leave/apply", json={"code": "LOP", "from_date": "2027-02-01", "to_date": "2027-02-01", "reason": "x"}).get_json()["id"]
    assert h.post("/api/review/request/%d" % rid, json={"action": "approve"}).status_code == 404
    mid = next(p["id"] for p in m.get("/api/people").get_json() if p["email"] == "hr@example.com")
    assert m.post("/api/delegates", json={"to_id": mid, "from_date": "2020-01-01", "to_date": "2099-01-01"}).status_code == 200
    assert any(x["id"] == rid for x in h.get("/api/review").get_json())
    assert h.post("/api/review/request/%d" % rid, json={"action": "approve"}).status_code == 200
    assert m.post("/api/delegates", json={"to_id": 2, "from_date": "2026-01-01", "to_date": "2026-01-02"}).status_code == 400  # self
    assert m.post("/api/delegates", json={"to_id": mid, "from_date": "2026-02-02", "to_date": "2026-02-01"}).status_code == 400

def test_admin():
    h, k = login("hr@example.com"), login("komal@example.com")
    for p in ["summary", "employees", "tickets"]:
        assert k.get("/api/admin/" + p).status_code == 403 and h.get("/api/admin/" + p).status_code == 200
    new = {
        "name": "Test User", "email": "t@example.com", "password": "longenough1",
        "department": "QA", "designation": "Tester", "join_date": "2026-11-22",
        "personal_email": "test.user@personal.com", "phone": "9876543210",
        "alternate_phone": "9876543211", "father_name": "Test Father",
        "mother_name": "Test Mother", "gender": "Male", "marital_status": "Single",
        "blood_group": "O+", "nationality": "Indian",
        "current_address": "12 Test Street", "permanent_address": "12 Test Street",
        "emergency_contact_name": "Test Father", "emergency_contact_phone": "9876543211",
        "emergency_contact_relation": "Father", "aadhaar_no": "123412341234",
        "pan_no": "ABCDE1234F", "uan_no": "100000000000", "esi_no": "3100000000",
        "bank_name": "Test Bank", "bank_account_no": "000111222333",
        "ifsc_code": "TEST0000001", "branch_name": "Main",
        "qualification": "B.Tech", "previous_company": "Old Co",
        "previous_experience": "3 years", "employment_type": "Full-time",
        "work_mode": "Hybrid", "shift": "09:00-18:00", "skills": "Python, SQL",
    }
    assert k.post("/api/admin/employees", json=new).status_code == 403
    assert h.post("/api/admin/employees", json={**new, "password": "short"}).status_code == 400
    assert h.post("/api/admin/employees", json={**new, "email": "badmail@example.com", "personal_email": "bad"}).status_code == 400
    r = h.post("/api/admin/employees", json=new); assert r.status_code == 200
    eid = r.get_json()["id"]
    created = next(e for e in h.get("/api/admin/employees").get_json() if e["id"] == eid)
    assert created["personal_email"] == "test.user@personal.com"
    assert created["father_name"] == "Test Father"
    assert created["pan_no"] == "ABCDE1234F"
    assert created["employment_type"] == "Full-time"
    assert h.patch("/api/admin/employees/%d" % eid, json={"phone": "9999999999"}).status_code == 200
    assert next(e for e in h.get("/api/admin/employees").get_json() if e["id"] == eid)["phone"] == "9999999999"
    # employee code is editable: normalised to upper case, must be unique and well formed
    assert h.patch("/api/admin/employees/%d" % eid, json={"emp_no": "3wai09999"}).status_code == 200
    assert next(e for e in h.get("/api/admin/employees").get_json() if e["id"] == eid)["emp_no"] == "3WAI09999"
    assert h.patch("/api/admin/employees/%d" % eid, json={"emp_no": "PD0001"}).status_code == 400   # already taken
    assert h.patch("/api/admin/employees/%d" % eid, json={"emp_no": "bad code!"}).status_code == 400
    assert h.post("/api/admin/employees", json=new).status_code == 400  # duplicate email
    n = A.app.test_client(); assert n.post("/api/login", json={"email": "t@example.com", "password": "longenough1"}).status_code == 200
    assert all(x["granted"] == 0 and x["balance"] == 0 for x in n.get("/api/leave/balances").get_json())  # new employees start with 0 leave
    assert next(p for p in h.get("/api/people").get_json() if p["id"] == eid)["cl_balance"] == 0
    assert h.patch("/api/admin/employees/%d" % eid, json={"active": False}).status_code == 200
    assert n.get("/api/me").status_code == 401  # deactivated -> existing session dead
    assert A.app.test_client().post("/api/login", json={"email": "t@example.com", "password": "longenough1"}).status_code == 401
    hid = next(p["id"] for p in h.get("/api/people").get_json() if p["email"] == "hr@example.com")
    assert h.patch("/api/admin/employees/%d" % hid, json={"active": False}).status_code == 400
    assert h.patch("/api/admin/employees/%d" % hid, json={"role": "employee"}).status_code == 400
    assert h.post("/api/admin/leave-grant", json={"emp_id": 3, "code": "CL", "days": 2}).status_code == 200
    assert next(x for x in k.get("/api/leave/balances").get_json() if x["code"] == "CL")["granted"] == 18
    assert h.post("/api/admin/leave-grant", json={"emp_id": 3, "code": "CL", "days": -100}).status_code == 400
    assert h.post("/api/admin/leave-grant", json={"emp_id": 3, "code": "CO", "days": 1}).status_code == 200  # comp off can be granted too
    assert next(x for x in k.get("/api/leave/balances").get_json() if x["code"] == "CO")["granted"] == 4.5
    assert h.post("/api/admin/holidays", json={"date": "2027-08-15", "name": "Independence Day"}).status_code == 200
    assert h.post("/api/admin/holidays", json={"date": "bad", "name": "x"}).status_code == 400

def test_executive_and_hr_control():
    ceo = login("ceo@example.com")
    coo = login("coo@example.com")
    cpo = login("cpo@example.com")
    hr = login("hr@example.com")
    emp = login("komal@example.com")

    # Executive dashboard permissions
    assert ceo.get("/api/executive/summary").status_code == 200
    assert coo.get("/api/executive/summary").status_code == 200
    assert cpo.get("/api/executive/summary").status_code == 200
    assert hr.get("/api/executive/summary").status_code == 403
    assert emp.get("/api/executive/summary").status_code == 403

    # Executives can access admin
    assert ceo.get("/api/admin/summary").status_code == 200
    assert cpo.get("/api/admin/employees").status_code == 200

    # HR cannot modify Executive accounts
    ceoid = next(p["id"] for p in hr.get("/api/people").get_json() if p["email"] == "ceo@example.com")
    hrid = next(p["id"] for p in hr.get("/api/people").get_json() if p["email"] == "hr@example.com")
    assert hr.patch("/api/admin/employees/%d" % ceoid, json={"active": False}).status_code == 400
    assert hr.patch("/api/admin/employees/%d" % ceoid, json={"role": "employee"}).status_code == 400
    assert hr.post("/api/admin/employees/%d/password" % ceoid, json={"password": "hackedpassword1"}).status_code == 400
    assert hr.post("/api/admin/employees", json={"name": "Fake CPO", "email": "fakecpo@example.com", "password": "securepwd123", "department": "Executive", "designation": "CPO", "role": "cpo", "join_date": "2026-11-22"}).status_code == 400

    # Executives control HR
    assert ceo.patch("/api/admin/employees/%d" % hrid, json={"designation": "Senior HR Head"}).status_code == 200
    assert cpo.post("/api/admin/employees/%d/password" % hrid, json={"password": "newhrpassword1"}).status_code == 200

    # Master approval: HR applies for leave, CPO/CEO approves
    # First login hr with new password
    hr_client = A.app.test_client()
    assert hr_client.post("/api/login", json={"email": "hr@example.com", "password": "newhrpassword1"}).status_code == 200
    hr_req = hr_client.post("/api/leave/apply", json={"code": "CL", "from_date": "2027-04-01", "to_date": "2027-04-01", "reason": "family trip"}).get_json()
    assert "id" in hr_req
    hr_rid = hr_req["id"]
    # HR cannot self-approve
    assert hr_client.post("/api/review/request/%d" % hr_rid, json={"action": "approve"}).status_code == 404
    # CPO or CEO can approve HR's leave request
    assert cpo.post("/api/review/request/%d" % hr_rid, json={"action": "approve"}).status_code == 200

def test_hr_member_management_attendance_and_leave_approval():
    hr = A.app.test_client()
    assert hr.post("/api/login", json={"email": "hr@example.com", "password": "newhrpassword1"}).status_code == 200
    emp = login("komal@example.com")

    # 1. HR adds new member with custom designation
    new_emp = {
        "name": "Sameer Joshi",
        "email": "sameer@example.com",
        "password": "sameerpass123",
        "department": "Engineering",
        "designation": "Staff AI Engineer",
        "role": "employee",
        "join_date": "2026-11-22"
    }
    r_add = hr.post("/api/admin/employees", json=new_emp)
    assert r_add.status_code == 200
    sameer_id = r_add.get_json()["id"]

    # 2. HR updates designation of employee
    r_upd = hr.patch("/api/admin/employees/%d" % sameer_id, json={"designation": "Principal AI Architect"})
    assert r_upd.status_code == 200
    sameer_info = next(p for p in hr.get("/api/admin/employees").get_json() if p["id"] == sameer_id)
    assert sameer_info["designation"] == "Principal AI Architect"

    # 2b. HR can also edit name and joining date from the Edit Employee view
    r_upd2 = hr.patch("/api/admin/employees/%d" % sameer_id, json={"name": "Sameer R. Joshi", "join_date": "2026-11-01"})
    assert r_upd2.status_code == 200
    sameer_info = next(p for p in hr.get("/api/admin/employees").get_json() if p["id"] == sameer_id)
    assert sameer_info["name"] == "Sameer R. Joshi" and sameer_info["join_date"] == "2026-11-01"
    assert hr.patch("/api/admin/employees/%d" % sameer_id, json={"join_date": "not-a-date"}).status_code == 400

    # 3. HR marks attendance for an employee
    r_att = hr.post("/api/admin/attendance", json={
        "emp_id": sameer_id,
        "date": "2026-11-22",
        "status": "P",
        "first_in": "09:15",
        "last_out": "18:45"
    })
    assert r_att.status_code == 200

    # Verify attendance sheet shows it
    att_list = hr.get("/api/admin/attendance?date=2026-11-22").get_json()
    sameer_att = next(a for a in att_list if a["emp_id"] == sameer_id)
    assert sameer_att["status"] == "P" and sameer_att["first_in"] == "09:15"

    # HR marks another employee absent
    assert hr.post("/api/admin/attendance", json={"emp_id": 3, "date": "2026-11-23", "status": "A"}).status_code == 200
    komal_att = next(a for a in hr.get("/api/admin/attendance?date=2026-11-23").get_json() if a["emp_id"] == 3)
    assert komal_att["status"] == "A"

    # 4. HR approves and rejects employee leaves
    # Komal applies for leave
    l_req = emp.post("/api/leave/apply", json={"code": "CL", "from_date": "2027-05-10", "to_date": "2027-05-11", "reason": "vacation"}).get_json()
    assert "id" in l_req
    l_id = l_req["id"]

    # HR checks pending requests endpoint
    pending_list = hr.get("/api/admin/requests").get_json()
    assert any(x["id"] == l_id for x in pending_list["leaves"])

    # HR approves Komal's leave
    r_dec = hr.post("/api/admin/review/request/%d" % l_id, json={"action": "approve"})
    assert r_dec.status_code == 200 and r_dec.get_json()["status"] == "approved"

    # Komal applies for another leave and HR rejects it
    l_req2 = emp.post("/api/leave/apply", json={"code": "CL", "from_date": "2027-06-01", "to_date": "2027-06-01", "reason": "day off"}).get_json()
    l_id2 = l_req2["id"]
    r_dec2 = hr.post("/api/admin/review/request/%d" % l_id2, json={"action": "reject"})
    assert r_dec2.status_code == 200 and r_dec2.get_json()["status"] == "rejected"

    # 5. When Manager approves a leave, HR gets notified and sees it in Decision Log
    mgr = login("manager@example.com")
    l_req3 = emp.post("/api/leave/apply", json={"code": "LOP", "from_date": "2027-07-01", "to_date": "2027-07-01", "reason": "medical"}).get_json()
    l_id3 = l_req3["id"]
    # Manager approves
    assert mgr.post("/api/review/request/%d" % l_id3, json={"action": "approve"}).status_code == 200

    # HR checks notifications
    hr_notifs = hr.get("/api/notifications").get_json()
    assert any("[Manager Action]" in n["text"] and "approved" in n["text"] for n in hr_notifs)

    # HR checks requests history/audit log
    admin_reqs = hr.get("/api/admin/requests").get_json()
    history_item = next(h for h in admin_reqs["history"] if h["id"] == l_id3)
    assert history_item["status"] == "approved"
    assert history_item["decider_name"] == "Vikram Sen"

def test_leave_contact_and_chosen_approver():
    k = login("komal@example.com")
    mid = next(p["id"] for p in k.get("/api/people").get_json() if p["email"] == "manager@example.com")
    r = k.post("/api/leave/apply", json={"code": "LOP", "from_date": "2027-03-01", "to_date": "2027-03-01", "reason": "x", "contact": "9999", "approver_id": mid})
    assert r.status_code == 200
    row = next(x for x in k.get("/api/leave/requests").get_json() if x["id"] == r.get_json()["id"])
    assert row["contact"] == "9999" and row["approver_id"] == mid
    assert k.post("/api/leave/rh", json={"date": "2027-03-03", "reason": "Holi", "approver_id": mid}).status_code == 200  # restricted holiday can name its approver too

def test_review_inbox_active_closed_resignations_and_tickets():
    A.RESIGNATION_OPEN = True
    k, m, ceo = login("komal@example.com"), login("manager@example.com"), login("ceo@example.com")
    rid = k.post("/api/leave/apply", json={"code": "LOP", "from_date": "2027-04-05", "to_date": "2027-04-05", "reason": "x"}).get_json()["id"]
    k.post("/api/resignation", json={"last_day": "2027-06-30", "reason": "Moving on"})
    k.post("/api/tickets", json={"category": "IT", "subject": "Mouse", "body": "Broken mouse"})
    active = m.get("/api/review").get_json()
    assert any(i["type"] == "request" and i["id"] == rid for i in active)
    assert not any(i["type"] in ("resignation", "ticket") for i in active)          # manager is not an admin
    assert not any(i["type"] == "request" and i["id"] == rid for i in m.get("/api/review?status=closed").get_json())
    assert m.post("/api/review/request/%d" % rid, json={"action": "approve"}).status_code == 200
    assert any(i["type"] == "request" and i["id"] == rid and i["status"] == "approved" for i in m.get("/api/review?status=closed").get_json())
    admin_view = ceo.get("/api/review").get_json()
    res = next(i for i in admin_view if i["type"] == "resignation" and i["emp_name"] == "Komal Tiwari")
    assert any(i["type"] == "ticket" and i["subject"] == "Mouse" for i in admin_view)
    assert m.post("/api/admin/resignations/%d" % res["id"], json={"action": "approve"}).status_code == 403   # needs an admin role
    assert ceo.post("/api/admin/resignations/%d" % res["id"], json={"action": "approve"}).status_code == 200
    assert ceo.post("/api/admin/resignations/%d" % res["id"], json={"action": "approve"}).status_code == 404  # already decided
    assert any(i["type"] == "resignation" and i["status"] == "approved" for i in ceo.get("/api/review?status=closed").get_json())
    assert not any(i["type"] == "resignation" for i in ceo.get("/api/review").get_json())

def test_feedback_requests():
    k, m = login("komal@example.com"), login("manager@example.com")
    mid = next(p["id"] for p in k.get("/api/people").get_json() if p["email"] == "manager@example.com")
    kid = next(p["id"] for p in m.get("/api/people").get_json() if p["email"] == "komal@example.com")
    assert k.post("/api/feedback-requests", json={"to_id": kid, "message": "x"}).status_code == 400   # not yourself
    r = k.post("/api/feedback-requests", json={"to_id": mid, "message": "How was my release?"}); assert r.status_code == 200
    assert k.post("/api/feedback-requests", json={"to_id": mid, "message": "again"}).status_code == 400   # one pending at a time
    req = k.get("/api/feedback-requests").get_json()
    assert req["sent"][0]["to_name"] == "Vikram Sen" and req["sent"][0]["status"] == "pending"
    got = m.get("/api/feedback-requests").get_json()["received"][0]
    assert got["from_name"] == "Komal Tiwari" and got["message"] == "How was my release?"
    assert m.post("/api/feedback", json={"to_id": kid, "message": "Solid work", "request_id": got["id"]}).status_code == 200
    assert m.get("/api/feedback-requests").get_json()["received"][0]["status"] == "answered"
    assert any(f["message"] == "Solid work" for f in k.get("/api/feedback").get_json()["received"])
    assert m.post("/api/feedback", json={"to_id": mid, "message": "me"}).status_code == 400   # not to yourself

def test_engage_feed_reactions_and_birthdays():
    import datetime
    k = login("komal@example.com")
    # kudos appear in the single feed
    kid = k.post("/api/kudos", json={"to_id": 4, "value": "Teamwork", "message": "Thanks"}).get_json()["id"]
    feed = k.get("/api/feed").get_json()
    kudos = next(i for i in feed if i["key"] == "kudos:%d" % kid)
    assert kudos["kind"] == "kudos" and kudos["group"] == "Recognition" and kudos["to_name"] and kudos["reactions"] == {}
    # a birthday today becomes an automatic post
    today = datetime.date.today()
    A.run("UPDATE employees SET dob=? WHERE id=5", ("1995-%02d-%02d" % (today.month, today.day),))
    feed = k.get("/api/feed").get_json()
    assert any(i["key"] == "bday:%s:5" % today.isoformat() and i["kind"] == "birthday" for i in feed)
    assert feed[0]["kind"] == "birthday"  # today's birthday is the latest item, above today's kudos
    # newest first
    stamps = [str(i["created_at"]) for i in feed]
    assert stamps == sorted(stamps, reverse=True)
    # reactions: set, change, count, remove, and bad input
    key = "kudos:%d" % kid
    assert k.post("/api/react", json={"key": key, "emoji": "👍"}).status_code == 200
    item = next(i for i in k.get("/api/feed").get_json() if i["key"] == key)
    assert item["reactions"] == {"👍": 1} and item["my_reaction"] == "👍"
    assert k.post("/api/react", json={"key": key, "emoji": "🎉"}).status_code == 200
    item = next(i for i in k.get("/api/feed").get_json() if i["key"] == key)
    assert item["reactions"] == {"🎉": 1} and item["my_reaction"] == "🎉"
    assert k.post("/api/react", json={"key": key, "emoji": None}).status_code == 200
    assert next(i for i in k.get("/api/feed").get_json() if i["key"] == key)["reactions"] == {}
    assert k.post("/api/react", json={"key": key, "emoji": "💩"}).status_code == 400
    assert k.post("/api/react", json={"key": "nonsense", "emoji": "👍"}).status_code == 400
    assert A.app.test_client().post("/api/react", json={"key": key, "emoji": "👍"}).status_code == 401

def test_new_roles_admin_and_executive():
    ceo = login("ceo@example.com")
    base = {"department": "Technical", "designation": "AI Engineer", "join_date": "2026-11-22", "password": "longenough1"}
    # own HR user, because an earlier test changes the demo HR password
    assert ceo.post("/api/admin/employees", json={**base, "name": "Hera HR", "email": "hera@example.com", "role": "hr"}).status_code == 200
    hr = A.app.test_client(); assert hr.post("/api/login", json={"email": "hera@example.com", "password": "longenough1"}).status_code == 200
    # HR may not hand out admin or executive roles; leadership may
    assert hr.post("/api/admin/employees", json={**base, "name": "A", "email": "adm@example.com", "role": "admin"}).status_code == 400
    assert hr.post("/api/admin/employees", json={**base, "name": "E", "email": "exe@example.com", "role": "executive"}).status_code == 400
    assert ceo.post("/api/admin/employees", json={**base, "name": "Adam Admin", "email": "adm@example.com", "role": "admin"}).status_code == 200
    assert ceo.post("/api/admin/employees", json={**base, "name": "Eve Exec", "email": "exe@example.com", "role": "executive"}).status_code == 200
    def sign_in(email):
        c = A.app.test_client(); assert c.post("/api/login", json={"email": email, "password": "longenough1"}).status_code == 200; return c
    adm, exe = sign_in("adm@example.com"), sign_in("exe@example.com")
    # admin = HR level: HR Admin area yes, executive dashboard no, and executives are off limits
    assert adm.get("/api/admin/summary").status_code == 200
    assert adm.get("/api/executive/summary").status_code == 403
    ceo_id = next(p["id"] for p in ceo.get("/api/people").get_json() if p["email"] == "ceo@example.com")
    assert adm.patch("/api/admin/employees/%d" % ceo_id, json={"location": "X"}).status_code == 400
    # executive = leadership tier: executive dashboard and HR Admin area
    assert exe.get("/api/executive/summary").status_code == 200
    assert exe.get("/api/admin/summary").status_code == 200
    # the Leadership department is listed once
    assert login("komal@example.com").get("/api/designations").get_json()["departments"].count("Leadership") == 1

def test_biometric_import_links_and_overnight():
    import biometric
    ceo = login("ceo@example.com")
    base = {"department": "Technical", "designation": "AI Engineer", "join_date": "2026-01-05", "password": "longenough1", "role": "employee"}
    dan = ceo.post("/api/admin/employees", json={**base, "name": "Dan Day", "email": "dan@example.com", "biometric_id": "000000902"}).get_json()["id"]
    nina = ceo.post("/api/admin/employees", json={**base, "name": "Nina Night", "email": "nina@example.com"}).get_json()["id"]
    assert A.q("SELECT biometric_id b FROM employees WHERE id=?", (dan,), one=True)["b"] == "902"  # machine padding is dropped
    head = "No\tMchn\tEnNo\tName\tMode\tIOMd\tDateTime\n"
    rows = [("902", "dan day", "2026/05/04  10:58:00"), ("902", "dan day", "2026/05/04  10:58:01"), ("902", "dan day", "2026/05/04  20:05:00"),
            ("901", "nina night", "2026/05/04  20:10:00"), ("901", "nina night", "2026/05/05  05:02:00"), ("901", "nina night", "2026/05/05  20:00:00"),
            ("903", "zed unknown", "2026/05/05  11:00:00")]
    text = head + "".join("%06d\t2\t%09d\t%s\t33\t0\t%s\n" % (i + 1, int(e), n, t) for i, (e, n, t) in enumerate(rows))
    # only HR level can import
    assert login("komal@example.com").post("/api/admin/biometric/import", json={"text": text}).status_code == 403
    assert ceo.post("/api/admin/biometric/import", json={"text": "not a punch file"}).status_code == 400
    r = ceo.post("/api/admin/biometric/import", json={"text": text}).get_json()
    assert (r["read"], r["new"], r["machine_users"], r["date_from"], r["date_to"]) == (7, 7, 3, "2026-05-04", "2026-05-05")
    assert r["inserted"] == 1 and r["unmatched"] == 2  # Dan is linked, Nina and Zed are not
    assert [(d["date"], d["first_in"], d["last_out"], d["source"]) for d in A.q("SELECT * FROM attendance WHERE emp_id=?", (dan,))] == [("2026-05-04", "10:58", "20:05", "bio")]
    # the machine names are only a guess: Nina matches by name, Zed matches nobody
    st = ceo.get("/api/admin/biometric").get_json()
    guess = {u["enno"]: u["suggest_id"] for u in st["unmatched"]}
    assert guess == {"901": nina, "903": None} and st["punches"] == 7 and st["linked"] == 1
    assert ceo.post("/api/admin/biometric/automatch").get_json()["linked"] == 1
    # a shift that ends after midnight stays on the day it started
    assert [(d["date"], d["first_in"], d["last_out"]) for d in A.q("SELECT * FROM attendance WHERE emp_id=? ORDER BY date", (nina,))] == [
        ("2026-05-04", "20:10", "05:02"), ("2026-05-05", "20:00", "20:00")]
    assert biometric.work_minutes("20:10", "05:02") == 532 and biometric.work_minutes("10:00", "19:00") == 540
    # importing the same file again changes nothing, and what a person entered is never overwritten
    again = ceo.post("/api/admin/biometric/import", json={"text": text}).get_json()
    assert again["new"] == 0 and again["duplicates"] == 7 and again["inserted"] == 0
    A.run("UPDATE attendance SET status='CL', source=NULL WHERE emp_id=? AND date='2026-05-04'", (dan,))
    kept = ceo.post("/api/admin/biometric/import", json={"text": text}).get_json()
    assert kept["kept_manual"] == 1
    assert A.q("SELECT status s FROM attendance WHERE emp_id=? AND date='2026-05-04'", (dan,), one=True)["s"] == "CL"
    # one machine id belongs to one person
    assert ceo.patch("/api/admin/employees/%d" % nina, json={"biometric_id": "902"}).status_code == 400
    assert ceo.patch("/api/admin/employees/%d" % nina, json={"biometric_id": "0901"}).status_code == 200


def test_biometric_live_ingest():
    ceo = login("ceo@example.com")
    emp = ceo.post("/api/admin/employees", json={"department": "Technical", "designation": "AI Engineer", "join_date": "2026-01-05", "password": "longenough1",
                   "role": "employee", "name": "Liv Live", "email": "liv@example.com", "biometric_id": "0777"}).get_json()["id"]
    c = A.app.test_client()
    body = {"punches": [{"enno": "000000777", "at": "2026-06-10 10:00:00", "machine": "2"}, {"enno": "777", "at": "2026-06-10 19:30:00"}, {"enno": "", "at": "x"}]}
    assert c.post("/api/biometric/ingest", json=body).status_code == 503          # off until a token is configured
    os.environ["BIOMETRIC_TOKEN"] = "test-secret-1234567890"
    try:
        assert c.post("/api/biometric/ingest", json=body).status_code == 401
        assert c.post("/api/biometric/ingest", json=body, headers={"Authorization": "Bearer wrong-wrong-wrong-1"}).status_code == 401
        h = {"Authorization": "Bearer test-secret-1234567890"}
        assert c.post("/api/biometric/ingest", json={"punches": []}, headers=h).status_code == 400
        r = c.post("/api/biometric/ingest", json=body, headers=h).get_json()
        assert r == {"received": 2, "new": 2}
        assert c.post("/api/biometric/ingest", json=body, headers=h).get_json()["new"] == 0   # machine repeats punches
        assert [(d["date"], d["first_in"], d["last_out"]) for d in A.q("SELECT * FROM attendance WHERE emp_id=?", (emp,))] == [("2026-06-10", "10:00", "19:30")]
    finally:
        os.environ.pop("BIOMETRIC_TOKEN")


def test_regularization_limit_three_per_month():
    a = login("aarav@example.com")
    body = lambda day, kind="regularize": {"kind": kind, "date": day, "in_time": "10:00", "out_time": "19:00", "reason": "forgot"}
    for day in ("2026-08-03", "2026-08-04", "2026-08-05"):
        assert a.post("/api/regularization", json=body(day)).status_code == 200
    r = a.post("/api/regularization", json=body("2026-08-06"))                     # the 4th in the same month is refused
    assert r.status_code == 400 and "Reporting Manager or HR" in r.get_json()["error"]
    assert a.post("/api/regularization", json=body("2026-07-06")).status_code == 200      # another month is counted on its own
    assert a.post("/api/regularization", json=body("2026-08-06", "permission")).status_code == 200   # permission requests do not use the limit


def test_change_own_password():
    c = login("isha@example.com")
    change = lambda cur, new: c.post("/api/me/password", json={"current_password": cur, "new_password": new})
    assert change("wrong-one", "brandnew123").status_code == 400
    assert change("demo123", "short").status_code == 400
    assert change("demo123", "brandnew123").status_code == 200
    fresh = A.app.test_client()
    assert fresh.post("/api/login", json={"email": "isha@example.com", "password": "demo123"}).status_code == 401
    assert fresh.post("/api/login", json={"email": "isha@example.com", "password": "brandnew123"}).status_code == 200
    assert change("brandnew123", "demo123aa").status_code == 200                     # the new one is the current one now
    assert A.app.test_client().post("/api/me/password", json={"current_password": "x", "new_password": "yyyyyyyyy"}).status_code == 401
    A.run("UPDATE employees SET password_hash=? WHERE email='isha@example.com'", (A.generate_password_hash("demo123"),))


def test_security_rules():
    k = login("komal@example.com")
    assert k.post("/api/attendance/punch", json={"emp_id": 1, "date": "2026-01-01", "status": "P"}).status_code in (404, 405)
    assert A.app.test_client().post("/api/device/push", json={}).status_code in (404, 405)
    ids = {p["email"]: p["id"] for p in k.get("/api/people").get_json()}
    leave = lambda aid: k.post("/api/leave/apply", json={"code": "LOP", "from_date": "2027-05-03", "to_date": "2027-05-03", "reason": "x", "approver_id": aid})
    assert leave(ids["aarav@example.com"]).status_code == 400 and leave(ids["komal@example.com"]).status_code == 400      # a colleague / oneself cannot approve
    assert k.post("/api/feed", json={"body": "fake announcement"}).status_code == 403
    r = k.get("/api/me")
    assert r.headers["X-Frame-Options"] == "DENY" and r.headers["X-Content-Type-Options"] == "nosniff" and r.headers["Cache-Control"] == "no-store"
    c = A.app.test_client(); bad = lambda: c.post("/api/login", json={"email": "meera@example.com", "password": "nope"}).status_code
    assert [bad() for _ in range(8)] == [401] * 8 and bad() == 429
    assert c.post("/api/login", json={"email": "meera@example.com", "password": "demo123"}).status_code == 429          # locked even with the right one, for a while
    assert c.post("/api/login", json={"email": "neil@example.com", "password": "demo123"}).status_code == 200          # others are not affected
    A._FAILS.clear()


def test_resignation_notifies_manager_hr_manager_and_leadership():
    A.RESIGNATION_OPEN = True
    A.run("UPDATE employees SET designation='HR Manager' WHERE email='hr@example.com'")
    k = login("kabir@example.com")
    last = A.q("SELECT COALESCE(MAX(id),0) m FROM notifications", one=True)["m"]
    assert k.post("/api/resignation", json={"last_day": "2027-01-31", "reason": "moving"}).status_code == 200
    got = {r["email"] for r in A.q("SELECT e.email FROM notifications n JOIN employees e ON e.id=n.emp_id WHERE n.id>? AND n.text LIKE '%resignation%'", (last,))}
    want = {r["email"] for r in A.q("SELECT email FROM employees WHERE active=1 AND (designation='HR Manager' OR role IN ('ceo','coo','cpo'))")} | {"manager@example.com"}
    assert got == want and "kabir@example.com" not in got
    assert A.q("SELECT COUNT(*) c FROM notifications WHERE id>?", (last,), one=True)["c"] == len(want)      # one each


def test_resignation_is_switched_off():
    A.RESIGNATION_OPEN = False
    r = login("kabir@example.com").post("/api/resignation", json={"last_day": "2027-02-28", "reason": "x"})
    assert r.status_code == 403 and "turned off" in r.get_json()["error"]


def test_my_team_only_shows_people_below_the_manager():
    m = login("manager@example.com"); k = login("komal@example.com")
    me = m.get("/api/me").get_json()
    direct = m.get("/api/team").get_json()["members"]
    assert me["team_size"] == len(direct) > 0 and all(x["manager_id"] == me["id"] for x in direct)
    assert not {"aadhaar_no", "pan_no", "bank_account_no", "password_hash", "phone", "dob"} & set(direct[0])
    deep = m.get("/api/team?scope=all&month=2026-11").get_json()
    assert {x["id"] for x in direct} <= {x["id"] for x in deep["members"]} and me["id"] not in {x["id"] for x in deep["members"]}
    kid = k.get("/api/me").get_json()["id"]
    assert m.get("/api/team/%d/attendance?month=2026-11" % kid).status_code == 200
    assert k.get("/api/team").get_json()["members"] == [] and k.get("/api/me").get_json()["team_size"] == 0
    assert k.get("/api/team/%d/attendance" % me["id"]).status_code == 403          # nobody outside one's own team
    assert m.get("/api/team/%d/attendance" % me["id"]).status_code == 403
    assert A.app.test_client().get("/api/team").status_code == 401


def test_designation_master_list():
    c = login("komal@example.com")
    d = c.get("/api/designations").get_json()
    assert len(d["flat"]) == len(set(d["flat"])) + 1            # only "Leadership" appears twice
    assert {"Data Operations Executive", "Data Procurement Team Lead", "Associate AI Engineer", "AI Engineer Intern", "Office Boy", "VP"} <= set(d["flat"])
    assert "Technical Manager" in d["flat"]
    assert "AI Engineer" in d["flat"]
    assert "HR Recruiter" in d["flat"]
    assert "Accounts & Finance" in d["departments"]
    assert "Executive" in d["departments"]

def test_3wheels_ai_five_features():
    ceo = login("ceo@example.com")
    coo = login("coo@example.com")
    cpo = login("cpo@example.com")
    hr = A.app.test_client()
    assert hr.post("/api/login", json={"email": "hr@example.com", "password": "newhrpassword1"}).status_code == 200
    emp = login("komal@example.com")

    # 1. Co-Equal C-Suite in Org Chart
    chart = emp.get("/api/orgchart").get_json()
    # Roots in chart should include CEO, COO, CPO
    c_suite_roles = {node["role"] for node in chart if node.get("role") in ["ceo", "coo", "cpo"]}
    assert {"ceo", "coo", "cpo"}.issubset(c_suite_roles)
    for node in chart:
        if node.get("role") in ["ceo", "coo", "cpo"]:
            assert node.get("manager_id") is None

    # 2. People & Team Options: list who reports to whom and count
    teams = emp.get("/api/people/teams").get_json()
    assert len(teams) > 0
    # Vikram Sen (Manager) should have team members including Komal
    vikram = next(t for t in teams if t["email"] == "manager@example.com")
    assert vikram["team_size"] >= 1
    assert any(m["email"] == "komal@example.com" for m in vikram["members"])

    # Directory also returns manager_name, team_size, team_members, cl_balance for all
    people = emp.get("/api/people").get_json()
    emp_komal = next(p for p in people if p["email"] == "komal@example.com")
    assert "cl_balance" in emp_komal
    assert emp_komal["manager_name"] == "Vikram Sen"

    # 3. HR Casual Leave (CL) management and universal visibility
    # Get current Komal CL
    initial_cl = next(x for x in emp.get("/api/leave/balances").get_json() if x["code"] == "CL")["balance"]
    # HR grants 3 CL to Komal
    r_grant = hr.post("/api/admin/leave-grant", json={"emp_id": emp_komal["id"], "code": "CL", "days": 3})
    assert r_grant.status_code == 200
    assert r_grant.get_json()["new_balance"] == initial_cl + 3

    # Visible to all employees in /api/people
    people_updated = emp.get("/api/people").get_json()
    komal_upd = next(p for p in people_updated if p["id"] == emp_komal["id"])
    assert komal_upd["cl_balance"] == initial_cl + 3

    # HR can also deduct 1 CL
    r_deduct = hr.post("/api/admin/leave-grant", json={"emp_id": emp_komal["id"], "code": "CL", "days": -1})
    assert r_deduct.status_code == 200
    assert r_deduct.get_json()["new_balance"] == initial_cl + 2

    # 3b. HR can set an exact CL value (Edit CL option)
    r_set = hr.post("/api/admin/leave-grant", json={"emp_id": emp_komal["id"], "code": "CL", "days": 20, "mode": "set"})
    assert r_set.status_code == 200
    assert r_set.get_json()["granted"] == 20
    assert hr.post("/api/admin/leave-grant", json={"emp_id": emp_komal["id"], "code": "CL", "days": 5, "mode": "nope"}).status_code == 400

    # 3c. HR can give the same CL to all employees in one call
    r_bulk = hr.post("/api/admin/leave-grant-bulk", json={"code": "CL", "days": 18, "mode": "set"})
    assert r_bulk.status_code == 200
    active_count = len([p for p in hr.get("/api/admin/employees").get_json() if p["active"]])
    assert r_bulk.get_json()["updated"] == active_count
    cl_after_bulk = hr.get("/api/admin/leave-balances?code=CL").get_json()
    assert cl_after_bulk and all(x["granted"] == 18 for x in cl_after_bulk)

    # 3d. Bulk apply also creates grant rows where none exist yet
    r_bulk_new = hr.post("/api/admin/leave-grant-bulk", json={"code": "SL", "days": 10, "mode": "set"})
    assert r_bulk_new.status_code == 200
    assert r_bulk_new.get_json()["updated"] == active_count
    assert all(x["granted"] == 10 for x in hr.get("/api/admin/leave-balances?code=SL").get_json())

    # 4. Welcome email dispatched on adding new member
    new_user = {
        "name": "Aarav Sharma",
        "email": "aarav.sharma@example.com",
        "password": "SecurePassword123!",
        "department": "AI Labs",
        "designation": "AI Research Scientist",
        "role": "employee",
        "join_date": "2026-11-22"
    }
    r_add = hr.post("/api/admin/employees", json=new_user)
    assert r_add.status_code == 200
    added_emp = r_add.get_json()

    # Outbox should have the dispatched email
    outbox = hr.get("/api/admin/outbox").get_json()
    welcome_mail = next(m for m in outbox if m["to_email"] == "aarav.sharma@example.com")
    assert "Welcome to 3Wheels AI" in welcome_mail["subject"]
    assert added_emp["emp_no"] in welcome_mail["body"]
    assert "aarav.sharma@example.com" in welcome_mail["body"]
    assert "SecurePassword123!" in welcome_mail["body"]

    # 5. Feed shows 3Wheels AI welcome branding
    feed = emp.get("/api/feed").get_json()
    assert any("3Wheels AI" in post["body"] for post in feed)


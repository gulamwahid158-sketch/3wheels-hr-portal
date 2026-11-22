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
    assert a["exceptions"] == ["2026-11-20"] and a["summary"]["absent"] == 1 and a["summary"]["leave"] == 3
    r = k.post("/api/regularization", json={"kind": "regularize", "date": "2026-11-20", "in_time": "11:00", "out_time": "20:00", "reason": "forgot"}).get_json()
    assert m.post("/api/review/regularization/%d" % r["id"], json={"action": "approve"}).status_code == 200
    assert k.get("/api/attendance?month=2026-11").get_json()["summary"]["absent"] == 0

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

def test_designation_master_list():
    c = login("komal@example.com")
    d = c.get("/api/designations").get_json()
    assert len(d["flat"]) == 59
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


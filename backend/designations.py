"""Final designation master list for 3Wheels AI.

Single source of truth used by the backend API and the seed/migration logic.
The frontend loads this through GET /api/designations so the onboarding and
"edit title" dropdowns always match the official list.
"""

DESIGNATION_GROUPS = [
    {
        "department": "Data Procurement",
        "groups": [
            {
                "name": "Data Procurement",
                "items": [
                    "Data Procurement Head",
                    "Data Procurement Manager",
                    "Data Procurement Executive",
                ],
            },
        ],
    },
    {
        "department": "Technical",
        "groups": [
            {
                "name": "Technical Management",
                "items": [
                    "Technical Head",
                    "Technical Manager",
                ],
            },
            {
                "name": "AI & Machine Learning",
                "items": [
                    "AI Engineer",
                    "AI Engineer Executive",
                    "AI Developer",
                    "Senior AI Engineer",
                    "Junior AI Engineer",
                    "Machine Learning Engineer",
                    "Deep Learning Engineer",
                    "Data Scientist",
                    "Data Analyst",
                    "AI Research Engineer",
                    "Generative AI Engineer",
                ],
            },
            {
                "name": "CAD & Designing",
                "items": [
                    "CAD Engineer",
                    "CAD Engineer Executive",
                    "Senior CAD Engineer",
                    "Junior CAD Engineer",
                    "CAD Designer",
                    "Senior CAD Designer",
                    "Junior CAD Designer",
                    "2D CAD Designer",
                    "3D CAD Designer",
                ],
            },
            {
                "name": "Software & Development",
                "items": [
                    "Software Developer",
                    "Senior Software Developer",
                    "Junior Software Developer",
                    "Software Engineer",
                    "Web Developer",
                    "Frontend Developer",
                    "Backend Developer",
                    "Full Stack Developer",
                ],
            },
        ],
    },
    {
        "department": "Operations",
        "groups": [
            {
                "name": "Operations",
                "items": [
                    "Operations Head",
                    "Operations Manager",
                    "Operations Executive",
                ],
            },
        ],
    },
    {
        "department": "Sales",
        "groups": [
            {
                "name": "Sales",
                "items": [
                    "Sales Head",
                    "Sales Manager",
                    "Sales Executive",
                ],
            },
        ],
    },
    {
        "department": "Human Resources",
        "groups": [
            {
                "name": "Human Resources",
                "items": [
                    "HR Head",
                    "HR Manager",
                    "Senior HR Executive",
                    "HR Executive",
                    "Junior HR Executive",
                    "Senior HR Recruiter",
                    "HR Recruiter",
                    "Junior HR Recruiter",
                ],
            },
        ],
    },
    {
        "department": "Accounts & Finance",
        "groups": [
            {
                "name": "Accounts Management",
                "items": [
                    "Accounts Head",
                    "Accounts Manager",
                    "Assistant Accounts Manager",
                    "Accounts Team Leader",
                ],
            },
            {
                "name": "Accounting",
                "items": [
                    "Senior Accountant",
                    "Accountant",
                    "Junior Accountant",
                    "Accounts Executive",
                    "Senior Accounts Executive",
                    "Junior Accounts Executive",
                ],
            },
            {
                "name": "Finance",
                "items": [
                    "Finance Manager",
                    "Finance Executive",
                ],
            },
        ],
    },
    {
        "department": "Leadership",
        "groups": [
            {
                "name": "Leadership",
                "items": ["Leadership"],
            },
        ],
    },
]

DESIGNATIONS = [
    item
    for dept in DESIGNATION_GROUPS
    for group in dept["groups"]
    for item in group["items"]
] + ["Leadership"]

# Departments shown in onboarding. "Executive" is kept for the C-suite accounts.
# dict.fromkeys drops duplicates (Leadership is already a group above) and keeps the order.
DEPARTMENTS = list(dict.fromkeys([dept["department"] for dept in DESIGNATION_GROUPS] + ["Executive", "Leadership"]))

# Older demo records used these titles/departments. Migrate them once on startup
# so existing databases stay consistent with the master list.
LEGACY_DESIGNATION_MAP = {
    "Engineering Manager": "Technical Manager",
    "QA Engineer": "Software Engineer",
    "UI Designer": "CAD Designer",
    "Recruiter": "HR Recruiter",
}

LEGACY_DEPARTMENT_MAP = {
    "People Ops": "Human Resources",
    "Engineering": "Technical",
    "Design": "Technical",
    "Finance": "Accounts & Finance",
}

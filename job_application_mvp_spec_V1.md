# Job Application & Interview Manager — MVP Spec (Revised)

## 1. Product Goal
Build a **minimal working web app** for **pre-apply document generation**.

The MVP should help the user:
- create and maintain a base profile manually
- select a base profile
- provide a job description and optional apply form
- generate a tailored resume
- generate a tailored CV
- generate answers to application questions
- save all outputs on the server side
- reopen generated results later from a simple logs page

This MVP is **not** a CRM, tracker, or full copilot workspace.

---

## 2. MVP Scope

### In scope
- Manual profile creation and editing
- Company-based profile data model
- Resume generation
- CV generation
- Application question extraction
- Application answer generation
- Basic job metadata extraction
- Server-side file storage
- Reusable result view
- Simple application logs page
- Local-first development
- No database
- One predefined output style
- Prompt editing in config

### Out of scope
- Importing an existing resume to create a profile
- Role-based experience model inside each company
- Interview tracking
- CRM pipeline
- Follow-up Q&A
- ATS keyword gap analysis
- Tailoring plan panel
- Background multi-job queue UI
- Cover letter generation
- Recruiter message generation
- Cloud sync
- Multi-user auth

---

## 3. Pages

## 3.1 Profiles Page
Main page for creating and editing reusable base profiles.

This is the source of truth for resume content.

### Purpose
Let the user manually enter and maintain the information needed to generate:
- tailored resume
- tailored CV
- answers to application questions

### MVP profile philosophy
For now, profile creation is **fully manual**.  
Do not support auto-import from an existing resume in MVP.

### Required sections
- Basic info
- Experience
- Skills
- Education
- Optional summary

### Experience model
For MVP, use a **company-based** model.

For each company, store:
- company name
- start date
- end date
- title
- bullet lines and/or paragraph notes
- optional project name
- optional raw resume lines or freeform notes

This model can remain flexible inside each company entry, but the top-level grouping should be by company.

### Notes
- Keep this fully manual for now
- Do not introduce nested role models in MVP
- Do not introduce resume import in MVP

---

## 3.2 Job Apply Page
Main page for creating a new generation request.

### Inputs
- Resume profile
- Job link
- Job description
- Optional apply form
- Theme / template

### Main action
- **Generate All**

For MVP, keep only one generation button.

---

## 3.3 Result View Page
Dedicated page for viewing one generated application package.

This page must be reusable and easy to reopen later.

### Show
- Company name
- Role name
- Generation timestamp
- Job link
- Resume profile used
- Theme used
- Output folder path
- Role summary
- Key requirement bullets
- Extracted questions
- Generated answers
- Copy button per answer
- Success/failure status for artifacts
- Quick reference summary

---

## 3.4 Application Logs Page
Simple page that lists all previously generated application packages.

Purpose:
- reopen past generated results
- review generation history
- find output folders again

### Show columns
- Created time
- Company
- Role
- Resume profile
- Generation status
- Output folder
- Open Result action

### Optional small features
- Search by company or role
- Sort newest first

This page is **not** a full tracker.  
It is only a reusable log of generated application packages.

---

## 3.5 Config Page
Stores default configuration.

### Required config
- Default output path
- Default theme per profile
- Prompt config
- Profile defaults if needed

### Prompt config
Allow editing of the core prompts used by the app:
- extraction prompt
- resume generation prompt
- CV generation prompt
- answers generation prompt

### Prompt UX
Each prompt should have:
- editable text area
- default value
- reset to default action

### Keep config minimal for MVP
Do not overbuild settings.

---

## 4. Profile Data Model

## 4.1 Basic Info
Each profile should support:
- full name
- title (optional)
- email
- phone (optional)
- location
- summary (optional)
- LinkedIn (optional)
- GitHub (optional)
- portfolio (optional)

## 4.2 Experience
For MVP, each experience entry is company-based.

### Required fields
- company name
- title
- start date
- end date

### Content fields
Allow flexible content under each company:
- bullet lines
- one or more paragraphs
- optional project name
- optional raw resume lines
- optional freeform notes

The generation system can decide how to use this content later.

### Important
Even though content can be flexible, each entry must still have:
- company name
- title
- date range

## 4.3 Skills
Simple list of skills / keywords.

## 4.4 Education
Simple list of education entries:
- school
- degree
- field
- optional graduation year

---

## 5. End-to-End Flow

## 5.1 Build Profile
User manually creates or edits a base profile in the Profiles page.

## 5.2 Input
User provides:
- resume profile
- job link
- job description
- optional apply form
- theme

## 5.3 Generate
User clicks **Generate All**.

## 5.4 Extraction
System extracts:
- company name
- role name
- short role summary
- top requirements
- questions found in JD
- questions found in apply form
- warnings / ambiguity notes

## 5.5 Artifact Generation
System generates:
- tailored resume
- tailored CV
- answers to extracted questions

## 5.6 Save
System saves:
- generated files
- metadata
- result file
- application log entry

## 5.7 View
User can:
- view the result immediately
- reopen it later from the logs page

---

## 6. Inputs

```yaml
resume_selection: string
job_link: string
job_description: string
apply_form: string | null
template: string
```

Notes:
- `apply_form` is optional
- `job_description` is required
- `resume_selection` is required
- `template` should default from config if not explicitly changed

---

## 7. Extraction Requirements

The extraction step should produce:

- `company_name`
- `role_name`
- `role_summary`
- `key_requirements`
- `questions`
- `warnings`

### Rules
- `role_summary`: 2–3 short lines
- `key_requirements`: 5–8 bullets, concise
- `questions`: deduplicate across JD and apply form
- `warnings`: include ambiguity or missing-info notes when relevant

### Example structured output
```json
{
  "company_name": "string",
  "role_name": "string",
  "role_summary": "string",
  "key_requirements": ["string"],
  "questions": ["string"],
  "warnings": ["string"]
}
```

---

## 8. Generation Requirements

## 8.1 Resume
Generate a tailored resume using:
- selected base profile
- job description
- user-provided resume prompt/instruction set

### Output
- `resume.pdf`

## 8.2 CV
Generate a tailored CV using:
- selected base profile
- job description
- CV prompt/instruction set

### Output
- `cv.pdf`

## 8.3 Answers
Generate answers using:
- extracted questions
- tailored resume context
- base profile as fallback
- JD and apply form context

### Output
- `answers.json`
- `answers.md`

### Answer rules
- grounded in true profile content
- concise and usable in job applications
- no hallucinated claims
- one answer per extracted question

### Example structured output
```json
{
  "answers": [
    {
      "question": "string",
      "answer": "string"
    }
  ]
}
```

---

## 9. Style and Templates

For MVP, use **one predefined style only**.

### Rules
- no user-editable style builder
- no custom layout editor
- no per-profile visual customization
- no font/color customization UI

The app should generate outputs in one clean fixed style.

The selected theme field can remain in the UI if needed for future compatibility, but MVP behavior should effectively use one standard style.

---

## 10. Artifacts

For MVP, generate these artifacts:

- resume
- CV
- answers
- metadata
- result summary

### Output folder layout
```text
{output_root}/{company}_{role}_{timestamp}/
  resume.pdf
  cv.pdf
  answers.md
  answers.json
  metadata.json
  result.json
```

### Naming rules
- Keep file names fixed
- Put context in folder name
- Add timestamp to folder name to avoid collisions

---

## 11. Persistence Model

## 11.1 No Database
For MVP, do **not** use a database.

## 11.2 Server-Side Storage
The server should store everything locally:
- profiles
- generated artifacts
- metadata
- application logs
- prompt config

## 11.3 Profile Storage
Store profiles as JSON files on the server.

### Example location
```text
/data/profiles/
  ml_staff_profile.json
  fullstack_profile.json
```

## 11.4 Global Log File
Use a single JSON file on the server:

```text
/data/application_logs.json
```

This file stores the list of generated application entries.

### Example
```json
{
  "applications": [
    {
      "id": "app_20260406_001",
      "created_at": "2026-04-06T14:30:00",
      "company_name": "Meta",
      "role_name": "Staff Machine Learning Engineer",
      "resume_profile": "ml_staff_profile",
      "theme": "standard",
      "job_link": "https://example.com",
      "status": "completed",
      "output_folder": "/output/meta_staff_machine_learning_engineer_2026-04-06_143000/",
      "result_file": "/output/meta_staff_machine_learning_engineer_2026-04-06_143000/result.json"
    }
  ]
}
```

## 11.5 Per-Result File
Each generation folder must include a `result.json` file that powers the Result View page.

### Example
```json
{
  "id": "app_20260406_001",
  "created_at": "2026-04-06T14:30:00",
  "company_name": "Meta",
  "role_name": "Staff Machine Learning Engineer",
  "job_link": "https://example.com",
  "resume_profile": "ml_staff_profile",
  "theme": "standard",
  "output_folder": "/output/meta_staff_machine_learning_engineer_2026-04-06_143000/",
  "metadata": {
    "role_summary": "Short summary here",
    "key_requirements": [
      "Ranking systems experience",
      "Experimentation at scale"
    ],
    "questions": [
      "Why do you want this role?"
    ],
    "warnings": []
  },
  "artifacts": {
    "resume_pdf": "resume.pdf",
    "cv_pdf": "cv.pdf",
    "answers_json": "answers.json",
    "answers_md": "answers.md",
    "metadata_json": "metadata.json"
  },
  "answers": [
    {
      "question": "Why do you want this role?",
      "answer": "..."
    }
  ],
  "quick_reference": {
    "what_to_remember": [
      "Emphasize production ML leadership"
    ],
    "top_talking_points": [
      "Built ranking systems at scale"
    ]
  },
  "status": "completed"
}
```

---

## 12. Generation Status

Even without a tracker UI, keep a simple generation lifecycle state.

### Allowed values
- `generating`
- `completed`
- `failed`

Why:
- useful for logs page
- useful for debugging
- useful for future expansion

This is a generation status only, not an application tracking status.

---

## 13. UX Requirements

## 13.1 Profiles Page UX
Keep the profile editor practical and structured.

### Suggested sections
- Basic info
- Summary
- Experience
- Skills
- Education

### Experience editor guidance
Use repeated company cards or expandable sections.
Each company entry should be editable manually.

## 13.2 Job Apply Page UX
The page should feel simple:
- input form
- Generate All button
- loading state
- success or error message
- quick links to Result View and Application Logs

## 13.3 Result View UX
This page should feel:
- easy to scan
- easy to copy from
- trustworthy
- reusable later

### Important
The result should not be temporary client state only.  
It must be loaded from server-side saved data.

## 13.4 Logs Page UX
Keep it boring and useful:
- searchable list
- newest first
- easy open action

---

## 14. Recommended Local Development Layout

```text
/project-root/
  /client/
  /server/
  /data/
    application_logs.json
    /profiles/
      ml_staff_profile.json
    /prompts/
      extraction.txt
      resume.txt
      cv.txt
      answers.txt
  /output/
    /company_role_timestamp/
      resume.pdf
      cv.pdf
      answers.md
      answers.json
      metadata.json
      result.json
```

This local-first setup should be the default development mode.

---

## 15. Suggested API Shape

## Profiles
`GET /api/profiles`
- list profiles

`POST /api/profiles`
- create profile

`GET /api/profiles/:id`
- get one profile

`PUT /api/profiles/:id`
- update profile

`DELETE /api/profiles/:id`
- delete profile

## Generate application package
`POST /api/applications/generate`

### Input
- resume profile
- theme
- job link
- job description
- optional apply form

### Output
- application id
- generation status
- output folder
- result file path

## List application logs
`GET /api/applications`

### Output
- list of application log entries

## Get one application result
`GET /api/applications/:id`

### Output
- full `result.json`

## Prompt config
`GET /api/config/prompts`
- get prompt text values

`PUT /api/config/prompts`
- update prompt text values

Optional later:
- artifact download/open endpoints

---

## 16. Non-Functional Requirements

- Max users: 30
- Expected jobs per day: 100
- Local development on one machine
- Low operational complexity
- Minimal setup
- Server-side persistence required

---

## 17. Final MVP Summary

This MVP should be framed as a **Pre-Apply Document Generator**.

Core responsibilities:
- let users manually maintain base profiles
- take profile + JD + optional apply form
- generate resume
- generate CV
- generate answers
- save artifacts on server
- make results easy to reopen later

Nothing more is required for first release.

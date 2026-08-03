# Job Application & Interview Manager — Future Roadmap (Revised)

## 1. Purpose
This document captures **future development ideas** after the strict MVP is working.

The MVP should remain small and reliable.  
These items are intentionally deferred.

---

## 2. Guiding Principle
Build in this order:

1. reliable manual-profile document generation
2. better pre-apply usability
3. interactive refinement
4. richer workspace
5. tracking / CRM

Do not pull advanced features into MVP unless they are truly necessary.

---

## 3. Future Profile System Improvements

## 3.1 Create Profile from Existing Resume
Future feature: allow the user to bootstrap a profile by uploading or pasting an existing resume.

### Goal
Reduce onboarding friction and speed up profile creation.

### Suggested flow
1. user uploads a resume or pastes resume text
2. system extracts contact info, summary, companies, dates, titles, and content
3. user reviews and edits the generated profile
4. saved profile becomes the source of truth

### Why deferred
For MVP, fully manual profile entry is simpler and more reliable.

---

## 3.2 Role-Based Experience Model
Future feature: move from a company-based experience model to a richer nested structure.

### Future structure
- company
  - one or more roles
    - title
    - start/end dates
    - bullets
    - projects
    - notes

### Why
This supports:
- promotions inside one company
- better project grouping
- more precise tailoring
- cleaner long-term data structure

### Why deferred
For MVP, company-based entries are simpler and sufficient.

---

## 3.3 Smarter Profile Editing
Future improvements:
- duplicate experience entry
- reorder entries
- reorder bullets
- tag entries by skill or theme
- save favorite bullets
- mark bullets as resume-safe / interview-only

---

## 4. Phase 1.5 — Better Pre-Apply UX

These are the best immediate upgrades after the first version works.

## 4.1 Better Action Buttons
Instead of only one Generate All button, later add:

- Review extraction
- Generate all
- Generate resume only
- Generate answers only
- Generate cheat sheet only

### Why
- reduces wasted generation
- gives more control
- supports partial reruns
- makes debugging easier

---

## 4.2 Artifact Toggles
Later allow users to choose which outputs to generate:

- resume
- CV
- answers
- job brief

Default:
- all checked = true

### Why
Some users may only want answers or only want a resume refresh.

---

## 4.3 Better Result Mode
Expand the Result View page to include:
- better previews
- download buttons
- answer copy helpers
- shorter and longer answer variants
- clearer success/failure messaging

### Why
This improves real-world usability during applications.

---

## 5. Tailoring Plan

This is one of the highest-value next features.

Before final artifact generation, show a compact tailoring plan:

- strongest matching experience areas
- bullets or projects likely to be emphasized
- weak or missing requirements
- likely positioning angle

### Example
- Emphasize ranking + experimentation + LLM productionization
- Downplay generic infra lines
- Missing explicit Kubernetes mention
- Good fit for applied ML / staff scope

### Why
This adds trust and gives users a chance to correct direction before final generation.

### Possible outputs
- `tailoring_plan.md`
- `tailoring_plan.json`

---

## 6. ATS Keyword Panel

Later add an ATS-focused panel showing:

- keywords found in JD
- keywords already covered by resume
- keywords missing from current resume
- keywords that can be truthfully incorporated

### Why
This is highly useful for resume tailoring and ATS optimization.

### Rule
Only suggest keywords that can be added truthfully.

---

## 7. Follow-Up Q&A / Interactive Refinement

After parsing or generation, let the user ask follow-up questions.

### Example questions
- Why did you emphasize this project?
- Which requirements are still weakly covered?
- Rewrite answer 2 shorter
- Make this answer more confident
- What should I emphasize in an interview?
- Which keywords are still missing?

### Why
This transforms the app from a static generator into a working assistant.

### Technical direction
Use saved server-side job context so follow-up prompts do not need the full JD resent every time.

---

## 8. Job Brief and Cheat Sheet

Add additional human-readable outputs:

- `job_brief.md`
- `pre_apply_cheatsheet.md`

## Job brief could include
- company name
- role name
- what the company/team likely does
- top requirements
- likely interview focus

## Cheat sheet could include
- what to remember
- top talking points
- role fit summary
- concise why-this-role angle

### Why
These are useful right before applying and later before interviewing.

---

## 9. Better Multi-Step UX

Once MVP is stable, consider moving away from a single raw form flow.

### Possible flow
1. Input
2. Review extraction
3. Review tailoring plan
4. Generate selected artifacts
5. Use result workspace

### Why
This improves trust, reduces wasted output, and gives more control.

---

## 10. Async Generation and Activity Panel

Later, support starting one generation while continuing to work on another job.

### UX idea
Add a thin right-side activity/status panel showing:
- queued
- generating
- completed
- failed

### Why
This lets the user continue working while generation runs in the background.

### Future expansion
This same panel can later become:
- activity history
- application tracker
- interview tracker

---

## 11. Copilot Workspace

Later evolve from basic pages into a broader workspace.

### Potential sections
- Input
- Parsed Job
- Tailoring Strategy
- Outputs
- Follow-up Q&A

### Goal
Help users:
- understand the job quickly
- control what gets emphasized
- refine outputs interactively
- reuse context without friction

This is a later-stage product direction, not an MVP requirement.

---

## 12. Server-Side Persistence Upgrade Path

Even though MVP uses no database, future growth may require stronger persistence.

### Future options
- local JSON + filesystem
- lightweight embedded DB
- full relational DB
- object storage for artifacts

### When to revisit
Only when:
- result count grows
- concurrent jobs increase
- cloud sync becomes necessary
- search/filtering becomes heavy

---

## 13. Cloud Sync and Multi-Device Support

Not needed now, but future possibilities include:
- syncing application packages across machines
- backing up outputs to cloud storage
- sharing artifacts between environments

### Important
Do not complicate MVP for this.

---

## 14. Workspace Search and Reuse

Later allow:
- searching prior applications
- reusing prior answers
- reusing prior job briefs
- reusing tailored language

### Why
Many job applications ask similar questions.  
Reuse can significantly reduce effort.

---

## 15. CRM / Tracking Layer

This is intentionally later.

### Possible future statuses
- Draft
- Ready to Apply
- Applied
- Recruiter Screen
- Interviewing
- Rejected
- Offer
- Archived

### Possible future features
- notes
- reminders
- interview dates
- outcome tracking
- recruiter communication history

### Important
This is a separate product layer and should not complicate the first release.

---

## 16. Analytics and Learning Layer

Much later, consider analytics such as:
- which profile performs best
- which artifact style gets more interview callbacks
- common question categories
- application-to-interview conversion rate

This is far beyond MVP.

---

## 17. Recommended Roadmap Order

## Phase 1
Strict MVP:
- Profiles page with fully manual entry
- company-based experience model
- Job Apply page
- Result View page
- Application Logs page
- Config page
- Generate All only
- resume + CV + answers + metadata
- filesystem + JSON persistence
- one predefined style
- editable prompts in config

## Phase 1.5
Better pre-apply UX:
- partial generation buttons
- artifact toggles
- better result view
- job brief
- cheat sheet

## Phase 2
Smarter generation:
- tailoring plan
- ATS keyword panel
- answer variants
- editable extracted questions

## Phase 3
Profile and interaction upgrades:
- import existing resume into profile
- role-based experience model
- follow-up Q&A
- refinement actions
- reusable answer memory

## Phase 4
Workspace and async model:
- activity panel
- background generation
- multi-job workflow

## Phase 5
Tracking and CRM:
- application lifecycle
- interview workflow
- reminders
- analytics

---

## 18. Final Summary

The future product can become much bigger, but the order matters.

Right now:
- keep MVP narrow
- use fully manual profiles
- keep the experience company-based
- make results reusable
- make persistence reliable

Later:
- reduce onboarding friction with resume import
- add role-based modeling
- improve pre-apply help
- add interactivity
- expand into workspace
- finally add CRM/tracking

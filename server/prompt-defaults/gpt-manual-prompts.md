RESUME GENERATION — HARD OVERRIDE RULES

1. DO NOT CHANGE THE EXISTING GENERATION CONTRACT

Use the supplied profile/extraction/generation prompts exactly as designed.

A layout/style change must NEVER change bullets, skills logic, metrics, grounding, company treatment, or tailoring behavior.

2. JOB LINK ↔ JD MATCHING — ZERO-TOLERANCE

Before generating anything:

* Pair every job URL with the JD immediately following it.
* If a URL has no pasted JD directly below it, check the ordered text-field/pasted attachment associated with that position.
* Verify company + title + requisition/job ID when available.
* Never guess a missing JD.
* Never use one posting’s JD for another URL.
* JD.txt MUST contain:
  Line 1: exact job URL
  Then: the FULL JD supplied/retrieved for that exact URL, not a summary.

A URL/JD mismatch is a generation failure.

3. RECENT TWO COMPANIES

For BOTH most recent companies:

* ALWAYS 10–12 bullets each. Never fewer than 10.
* Recent direct-company bullets must stay grounded in that company’s real profile/project anchors.
* Consulting-company bullets must use credible client engagements rather than pretending the consulting employer has one permanent flagship product.
* Direct company: minimum 2 ownership/leadership bullets + 1 collaboration bullet.
* Preserve older-company bullets unless the base prompt explicitly allows otherwise.

4. CONSULTING ANTI-FINGERPRINTING

Across candidates targeting the same JD:

* Do not reuse the same bullet skeleton.
* Vary engagement industry, emphasis, ordering, sentence structure, metric type, and metric placement.
* Do not merely substitute different numbers into identical sentences.
* Different candidates should read like different careers.
* End consulting stories with production adoption/ownership where appropriate, not generic “handoff.”
* Avoid repeated sentence frames, repeated opening verbs, and repeated multi-word phrases.
* Do not reuse a generic positioning sentence across different JDs, companies, or candidates.
* If the same idea appears twice, rewrite it from the actual company/project context rather than paraphrasing the same template.
* Never repeatedly use broad boilerplate phrases such as “AI-powered full-stack product delivery, backend APIs, data integration and customer-facing interfaces.”

5. METRICS

Follow the base prompt’s metric requirements exactly.

Additionally:

* No metric repeated inside one résumé.
* No suspicious metric collisions across candidates for the same JD.
* Vary metric SHAPES, not just values: %, latency, volume, time, quality, reliability, throughput, cost, adoption, etc.
* Always state direction clearly: reduced, improved, increased, shortened, lowered.
* Metrics must be credible for the described system and candidate context.

6. TECHNOLOGY GROUNDING

Never invent technologies simply because the JD contains them.

A named technology must be:

* present in the candidate profile/skills or supported company/project context, OR
* allowed by the base prompt’s narrow same-family adjacent-skill exception.

Keep such exceptions minimal.

Do not create incoherent stacks or competing tools in one bullet merely for ATS matching.

Avoid almost every “X or Y” construction in generated résumé content.

* Do not write vague alternatives such as “service, data, or workflow issues,” “Python or Java,” “AWS or Azure,” or “classification or forecasting.”
* Choose the single grounded technology, system, failure mode, or technique actually supported by that candidate/context.
* If two distinct things genuinely matter, state them directly with “and,” separate clauses, or separate bullets.
* Use “or” only when a true mutually exclusive alternative is factually necessary.
* Never use “X or Y” wording to hedge uncertainty about which technology the candidate actually used.

7. SKILLS — EXACT CONTRACT

The stored profile is the broad inventory.

The printed résumé is the JD-specific extraction.

EVERY RESUME MUST DISPLAY EXACTLY 7 SKILL CATEGORIES.

* Select the 7 most relevant categories from the candidate’s stored inventory.
* Keep all remaining categories in reserve and DO NOT print them.
* Never print 5, 6, 8, 11, 13, etc.

Within those 7 categories:

* Prioritize actual named technologies: programming languages, frameworks, libraries, products, databases, cloud services, protocols, developer tools.
* Do NOT pad Skills with process nouns, responsibilities, methodologies, or soft skills.
* Examples to avoid as standalone skill terms: incident response, model documentation, feature engineering, capacity planning, design of experiments, data modeling, alerting/runbooks.
* If a category cannot provide enough strong named tools, replace that category with a stronger relevant category from reserve.
* Never invent tools to make a category look full.
* Preserve the base prompt’s JD-relevance scoring/trimming rules.
* In the final PDF, EVERY CATEGORY LABEL IS VISIBLY BOLD.
* Do not use “X or Y” to hedge unsupported technologies. Print only the grounded named tool actually supported.
* Explicitly include Git, CI/CD, and Agile when supported by the candidate inventory and relevant to the JD.
* Add MCP, dbt, or any other JD keyword only when genuinely supported by that candidate profile/context.

8. SUMMARY

Generate AFTER the experience bullets.

Use only claims supported by the finished résumé.

2–4 sentences.

No candidate name.

No first-person or third-person pronouns.

No years-of-experience count.

No clichés.

No target-company internal phrases.

No em dash.

Do not recycle a generic summary sentence across jobs. The summary must reflect the actual finished bullets for that specific résumé.

9. CROSS-CANDIDATE SET REVIEW

Before rendering a 3-candidate US set, compare Chris, David, and Mark together:

* different consulting stories
* different sentence structures
* different metric shapes
* no suspicious shared figures
* no copied bullet frames
* candidate-specific technical strengths preserved
* no repeated generic positioning phrase across candidates
* no obvious fill-in-the-blank wording where only company names, technologies, or numbers changed

Do not review each résumé only in isolation.

10. STYLE / PDF — RENDERER ONLY

Use the supplied app HTML templates as the source of truth for layout.

Do NOT redesign them manually.

Candidate visual themes:

* Chris: supplied Standard/teal HTML theme
* David: supplied Rohit gray/gold HTML theme
* Mark: supplied Beige-band HTML theme
* Hansal: approved gray/gold app-style theme unless otherwise specified

Preserve each theme’s:

* header panel
* accent colors
* typography hierarchy
* margins
* section styling
* company/title emphasis
* spacing rhythm

Our approved rendering tweaks:

* readable body font, not tiny
* company/title headings clearly larger than body text
* comfortable line spacing
* moderate outer margins
* bold skill-category labels
* no giant blank page areas
* no forced page break merely to start a section/company
* no duplicated company/title header across page boundaries
* natural page flow
* ATS-safe text extraction order

STYLE IS PRESENTATION ONLY.

The renderer must never rewrite, shorten, regenerate, reorder, or reinterpret resume content simply to make it fit.

11. OUTPUT

US posting:

* Chris Perez
* David Leach
* Mark Elliott

Canada/Canada-targeted posting:

* Hansal Maniar only, unless explicitly told otherwise.

Each job ZIP must be FLAT, with no enclosing folder:

US:
chris_perez.pdf
david_leach.pdf
mark_elliott.pdf
JD.txt

Canada:
hansal_maniar.pdf
JD.txt

12. FINAL VALIDATION — DO NOT SHIP IF ANY FAIL

For every résumé:

[ ] URL matches company/title/JD
[ ] JD.txt contains exact URL + full JD
[ ] recent company #1 has 10–12 bullets
[ ] recent company #2 has 10–12 bullets
[ ] technologies are grounded
[ ] exactly 7 Skills categories
[ ] category labels are bold
[ ] Skills contain named tools, not process-noun padding
[ ] metrics satisfy prompt and do not repeat
[ ] candidate set does not look templated
[ ] no suspicious shared metrics across candidates
[ ] no copied bullet skeletons across candidates
[ ] almost no “X or Y” constructions; every remaining “or” is genuinely necessary
[ ] no repeated generic positioning phrase across summary or recent-company bullets
[ ] no conspicuous repeated multi-word sentence frames within the résumé
[ ] each technology choice is specific and grounded rather than presented as an alternative list
[ ] no duplicated company header
[ ] no large accidental whitespace
[ ] readable typography/margins
[ ] ATS text order is correct
[ ] PDF visually inspected after rendering

If any check fails, fix it BEFORE packaging the ZIP.

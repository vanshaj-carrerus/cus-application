# Portal playbooks

One section per job portal: the steps its run follows, what the portal has and does **not** have, where it tends to go
wrong, and what was learned. A portal's code only looks for what its playbook says that portal has. Keep this file up to
date when a portal's behaviour is found out (especially from a failed run's message).

## Company-site forms (shared driver)
- If a site offers "Autofill with Resume" / "Apply Manually" / "Use My Last Application" (Workday), the driver always picks
  **Autofill with Resume**, attaches the candidate's resume, then fills whatever the site missed from the profile and answers.

## How the portals are kept apart

- `urls.ts` – the search and job addresses, one entry per portal.
- `registry.ts` – hands each page to the adapter of its own portal (by host name) and to no other.
- `<portal>.ts` – that portal's page code. LinkedIn's lives in `../linkedin*.ts` for historical reasons.
- `../external-apply.ts` – the **company-site driver**, shared: it fills and submits the form on an employer's own site
  (or Indeed's application form). It never runs on a portal's own pages (`isPortalHost`).
- The server (`/api/helper/portals/apply`) is portal-neutral: it plans, claims jobs, answers questions and records results
  for whichever portal the run names.

### Adding a portal
1. Write its playbook below (steps, what it has / lacks, quirks).
2. Add its `ApplyPortal` id and host check in `../linkedin-shared.ts`, its addresses in `urls.ts`.
3. Write `<portal>.ts`: a search reader, a job-page step, and `run<Portal>ApplyIfAsked(send)`; register it in `registry.ts`.
4. In `lib/portals/catalog.ts` set `autoApply: true` (and `loginInBrowser: true` if the candidate signs in themselves).
5. Add its hosts to the `content_scripts` in `manifest.json` only if it needs a page-world script.

Rules for every portal: the candidate signs in themselves (the run waits); CAPTCHAs and verification are completed by a
person (the run waits); the bot never invents an answer to a required question (it is saved on the candidate's profile).

---

## LinkedIn (`LINKEDIN`)

**Has:** profile, messages, saved/applied jobs (read-only sync); Easy Apply (a window on the job page); "Apply" to the
company's site; job alerts and "top choice" toggles on the last step.

**Does not have:** a separate account for applying; the Easy Apply window is not a page, it sits over the job page.

**Steps**
1. Search `jobs/search` (past week, newest first), every job type. Long (company-site) jobs are done before Easy Apply ones.
2. Job page: "Easy Apply" -> the window headed "Apply to <company>" with "n/N pages": fill, resume if asked, answer, Next /
   Review until Submit, wait for "Application sent". No Easy Apply -> the "Apply" link goes to the company's site and the
   company-site driver takes over in that tab.
3. Standing answers: "Set alert for similar jobs" = yes, "Mark job as a top choice" = no (`standingAnswer` in formEngine).

**Quirks:** the Easy Apply window is found by its "Apply to" heading, not by markup (LinkedIn's markup changes). Radio
questions repeat the question as every option's label (see `optionTextsOf`). Ten parallel sessions on one account risk
verification checks.

---

## Glassdoor (`GLASSDOOR`)

**Has:** job search; a job page with one Apply button ("Apply on employer site", or "Easy Apply" on some jobs); a sign-in
pop-up; saved questions come from the employer's form, not from Glassdoor.

**Does not have:** an application form of its own. Glassdoor never takes the application itself: "Apply on employer site"
sends the browser to the employer, and "Easy Apply" sends it to Indeed's application form (`smartapply.indeed.com`).
No profile / message / saved-job reading is built for Glassdoor. No modal-style apply window like LinkedIn's.

**Steps**
1. Search `Job/jobs.htm?sc.keyword=...&locKeyword=...&fromAge=7&sortBy=date_desc`; read the cards (`a[data-test=job-link]`,
   `li[data-test=jobListing]`; id from `jl=`).
2. Sign in: if the sign-in page or pop-up shows, the run waits for the candidate.
3. Job page (`/job-listing/...`): find the Apply button (`[data-test=applyButton]`, or text "Easy Apply" / "Apply on employer
   site"). Hand over to the employer, trying in this order:
   1. the link behind the button (`<a href>` on or around it) -> opened by the extension;
   2. the address the button's script opens with `window.open` -> caught by `main-world.ts` (a script-made click cannot open
      a pop-up, the browser blocks it), then opened by the extension;
   3. the apply address in the page data (`__NEXT_DATA__`).
   If all three fail the job fails with the buttons the page showed.
4. In-between page (`/partner/...`, "Apply on the company's website"): normally forwards by itself; if it waits for a click or
   a link, `leaveGlassdoor` follows the outward link / presses Continue.
5. The employer's site (or Indeed's form) is filled and submitted by the company-site driver.

**Quirks / unknowns to confirm on a real run:** whether Easy Apply opens a new tab or an embedded frame (frames are not
reached yet); the exact Apply button markup (the selectors are from memory); whether the sign-in pop-up appears.
Failure messages include `[path | buttons: ...]` so the real page can be read from them.

---

## Indeed (`INDEED`)

Code: `indeed.ts` only (nothing of LinkedIn's or Glassdoor's is used). Shared with them: the form driver (`external-apply.ts`)
and the server.

**Has:** job search (`/jobs?q=&l=&fromage=7&sort=date`); a job page (`/viewjob?jk=`) with one Apply button: "Apply now" /
"Easily apply" (Indeed's own form) or "Apply on company site"; sign-in with an emailed code (the candidate does it).

**Does not have:** a modal-style form on the job page in the normal flow. "Apply now" opens Indeed's own application form on
`smartapply.indeed.com` (own tab, or this tab); "Apply on company site" opens an in-between page that forwards to the
employer.

**Steps**
1. Start: the extension opens a window on the search for each profile keyword + location (candidate's saved auto-apply profile).
2. Search page: read the cards (`a[data-jk]`, `.job_seen_beacon`; id = `jk`; "Easily apply" marks Indeed's own form). Company-site
   jobs are done first, Indeed's own form after (the run sorts on `easy`).
3. Sign in: if the sign-in page shows (`secure.indeed.com`, a password field) the run waits for the candidate (10 minutes).
4. Job page: find the Apply button (`#indeedApplyButton`, or the text). Hand over, in order: the link behind it; the address its
   script opens with `window.open` (caught by `main-world.ts`, opened by the extension); the address in the page data. If
   none works the job fails with `[path | buttons: ...]`. If the page is reloaded before the click, the waiting tab clicks again.
5. `smartapply.indeed.com` (Indeed's own form): the shared form driver fills the contact details, keeps the Indeed resume
   (or attaches the candidate's), answers the employer's questions, presses Continue until Submit, presses it once, and
   reports on the confirmation page.
6. In-between page (`indeed.*` tab that is not the job page): forwards by itself; else `leaveIndeed` follows the outward link /
   presses Continue.
7. The company's own site: the shared form driver (cookie banners, pop-ups, CAPTCHA wait of 30 s, then next job).

**Quirks / unknowns to confirm on a real run:** the exact markup of the Apply button and the cards (selectors are from memory
and fall back to text); whether Apply opens a new tab or navigates the job tab; Cloudflare checks on Indeed (the run waits for
the person); regional hosts (`in.indeed.com`...) are handled by host pattern, the search starts on `www.indeed.com`.

---

## ZipRecruiter (`ZIPRECRUITER`)

Code: `ziprecruiter.ts` only. Shared: the form driver (`external-apply.ts`) and the server.

**Has:** job search (`/jobs-search?search=&location=&days=5`); a job page with "1-Click Apply" / "Quick Apply" (ZipRecruiter's
own, sent from the page, sometimes with a short form or questions) or "Apply" (the company's own site, another tab); sign-in
(candidate does it); Cloudflare-type checks.

**Steps**
1. Start: a window on the search for each profile keyword + location.
2. Search page: read the cards (`article[id^=job-card]`, link with `lvk=`); "1-Click / Quick Apply" marks the own kind.
3. Sign in: if the sign-in page shows, the run waits for the candidate (10 minutes).
4. Job page: press 1-Click / Quick Apply if present (else "Apply"). Own kind: the page showing "application sent" / "Applied"
   is a success; a form that comes up is filled and submitted by the shared form driver. Company "Apply": the link or the
   address its script opens is opened by the extension in another tab, and the shared driver does the company's form.
5. A ZipRecruiter tab that is not the run's own job page forwards to the company (`leaveZipRecruiter`).

**Quirks / unknowns to confirm on a real run:** card and button markup (written from memory, with text fallbacks); whether
"Apply" opens a tab or navigates; whether Quick Apply questions sit in a modal or a page. Failures end with `[path | buttons: ...]`.

---

## Naukri (`NAUKRI`)

Code: `naukri.ts` only. Shared: the form driver (`external-apply.ts`) and the server. India-focused.

**Has:** job search (`/<title>-jobs-in-<city>?k=&l=&jobAge=7`); a job page with "Apply" (Naukri's own, sent from the page, sometimes
followed by a short questions panel) or "Apply on company site" (the employer's own site, another tab); sign-in (candidate does it).

**Steps**
1. Start: a window on the search for each profile title + location (city part only). The date filter is `jobAge` (7, 15, 30 days, any).
2. Search page: read the cards (`.srp-jobtuple-wrapper`, `data-job-id`, `a.title`, `a.comp-name`, `.locWdth`). "No results" is answered
   at once (so the run loosens the search); cards that cannot be read stop the run with a message instead of changing filters.
3. Sign in: if the login page shows, the run waits for the candidate (10 minutes).
4. Job page: press "Apply" (`#apply-button`) if present, else "Apply on company site" (`#company-site-button`). Own apply: the page
   saying "successfully applied" / the button turning into "Applied" is a success; a questions panel is handed to the shared form
   driver. Company site: the address its script opens is opened by the extension in another tab, and the shared driver does the form.
5. A Naukri tab that is not the run's own job page forwards to the employer (`leaveNaukri`).

**Quirks / unknowns to confirm on a real run:** all selectors are from memory; Naukri's chatbot-style questions panel (one question
at a time, answers typed into a rich box) is not something the shared form driver is built for, so those jobs are expected to end
as "needs a person" until the panel is mapped. Failures end with `[path | buttons: ...]`.

# Portal playbooks

One section per job portal: the steps its run follows, what the portal has and does **not** have, where it tends to go
wrong, and what was learned. A portal's code only looks for what its playbook says that portal has. Keep this file up to
date when a portal's behaviour is found out (especially from a failed run's message).

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

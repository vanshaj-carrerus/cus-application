import type { ICandidate } from "@/lib/models/Candidate";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * Plain, single-column, semantic HTML — deliberately avoids tables/columns/graphics
 * so ATS parsers read it cleanly. tailoredBody is the already-tailored resume text
 * (from resumeService.tailorResume); this just wraps it with a rewritten summary and
 * a highlighted-skills line above it.
 */
export function buildResumeHtml(candidate: ICandidate, adjustedSummary: string, highlightedSkills: string[], tailoredBody: string): string {
  const contactLine = [candidate.email, candidate.phone, candidate.location]
    .filter((v): v is string => Boolean(v))
    .map(escapeHtml)
    .join(" &middot; ");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #1a1a1a; line-height: 1.5; }
  h1 { font-size: 20pt; margin: 0 0 4px; }
  .contact { font-size: 9.5pt; color: #444; margin-bottom: 16px; }
  h2 { font-size: 12pt; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #999; padding-bottom: 2px; margin: 18px 0 8px; }
  .skills span { display: inline-block; background: #eef2f7; border-radius: 3px; padding: 2px 8px; margin: 0 6px 6px 0; font-size: 9.5pt; }
  .body-text { white-space: pre-wrap; font-size: 10.5pt; }
</style>
</head>
<body>
  <h1>${escapeHtml(candidate.name)}</h1>
  <div class="contact">${contactLine}</div>

  <h2>Summary</h2>
  <p>${escapeHtml(adjustedSummary)}</p>

  <h2>Key Skills</h2>
  <div class="skills">${highlightedSkills.map((s) => `<span>${escapeHtml(s)}</span>`).join("")}</div>

  <h2>Experience &amp; Education</h2>
  <div class="body-text">${escapeHtml(tailoredBody)}</div>
</body>
</html>`;
}

/**
 * Builds the srcDoc for the sandboxed iframe that shows an email body. The mail is untrusted content
 * from whoever wrote to the candidate, so the frame is locked down twice: the <iframe sandbox> (no
 * scripts, no forms) and a CSP inside the document that blocks every network request except images —
 * and remote images only when the person opts in, since a tracking pixel tells the sender the mail
 * was opened.
 */
export function buildMailFrameDoc(html: string | null, text: string | null, allowImages: boolean): string {
  const csp = `default-src 'none'; img-src data: ${allowImages ? "https:" : ""}; style-src 'unsafe-inline'; font-src data:`;
  const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const body = html
    ? // meta (refresh/CSP overrides), base (relinks every URL) and script are never wanted from a sender.
      html.replace(/<meta\b[^>]*>/gi, "").replace(/<base\b[^>]*>/gi, "").replace(/<script\b[\s\S]*?<\/script>/gi, "")
    : `<pre style="white-space:pre-wrap;font:inherit;margin:0">${escape(text ?? "(This message has no content)")}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{margin:0;padding:4px;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${body}</body></html>`;
}

export const MAIL_FRAME_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

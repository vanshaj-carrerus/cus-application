import "dotenv/config";
import mongoose from "mongoose";
import { chromium } from "playwright";
import { connectDB } from "@/lib/db/mongodb";
import { Candidate } from "@/lib/models/Candidate";
import { JOB_BOARDS, type JobBoard } from "@/lib/models/enums";
import { installCaptchaCapture } from "@/lib/automation/captcha";
import { saveBoardSession } from "@/lib/automation/browser";
import { findCredentialForUrl } from "@/lib/automation/authLogin";
import { passLoginWall } from "@/lib/automation/signInFlow";
import { decryptSecret } from "@/lib/security/crypto";

/**
 * One-time sign-in to a job board for a candidate, done in a VISIBLE browser window so a person can pass
 * the board's bot check once (LinkedIn's "quick security check", for example). The signed-in session is then
 * saved, encrypted, and the worker reuses it for every application — it never meets the login or the check again
 * until the session expires (weeks).
 *
 *   npm run board-login -- <candidateId or part of the name> [LINKEDIN|INDEED|NAUKRI|...]
 *
 * Run it on a machine with a screen, from the same network the worker uses where possible.
 */

const LOGIN_URLS: Partial<Record<JobBoard, string>> = {
  LINKEDIN: "https://www.linkedin.com/login",
  INDEED: "https://secure.indeed.com/auth",
  NAUKRI: "https://www.naukri.com/nlogin/login",
  GLASSDOOR: "https://www.glassdoor.com/profile/login_input.htm",
  MONSTER: "https://www.monster.com/profile/login",
  DICE: "https://www.dice.com/dashboard/login",
  ZIPRECRUITER: "https://www.ziprecruiter.com/authn/login",
};

const WAIT_FOR_PERSON_MS = 10 * 60_000;

function signedIn(url: string): boolean {
  return !/login|signin|sign-in|auth|checkpoint|challenge|captcha|verify|uas\//i.test(url);
}

async function main() {
  const [who, boardArg = "LINKEDIN"] = process.argv.slice(2);
  const board = boardArg.toUpperCase() as JobBoard;
  if (!who || !JOB_BOARDS.includes(board) || board === "OTHER" || !LOGIN_URLS[board]) {
    console.error(`usage: npm run board-login -- <candidateId | name> [${Object.keys(LOGIN_URLS).join("|")}]`);
    process.exit(2);
  }

  await connectDB();
  const candidate = /^[0-9a-f]{24}$/i.test(who) ? await Candidate.findById(who) : await Candidate.findOne({ name: new RegExp(who, "i") });
  if (!candidate) {
    console.error(`no candidate matches "${who}"`);
    process.exit(1);
  }
  const loginUrl = LOGIN_URLS[board]!;
  const credential = await findCredentialForUrl(String(candidate._id), loginUrl);
  if (!credential) {
    console.error(`${candidate.name} has no saved login to use — add one under Job Board Logins first`);
    process.exit(1);
  }
  const password = decryptSecret(credential.passwordEncrypted);

  console.log(`Opening a browser window to sign ${candidate.name} in to ${board} as ${credential.boardUsername}…`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  await installCaptchaCapture(context);
  const page = await context.newPage();
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const flow = await passLoginWall(page, String(candidate._id), { name: candidate.name, email: candidate.email, phone: candidate.phone });
  if (flow.success) console.log(`Signed in automatically: ${flow.steps.join(" → ")}`);
  else console.log(`The automatic part stopped: ${flow.reason}\nFinish signing in (and pass any security check) in the window — waiting up to 10 minutes…`);

  const deadline = Date.now() + WAIT_FOR_PERSON_MS;
  while (Date.now() < deadline && !(signedIn(page.url()) && (await page.locator('input[type="password"]:visible').count()) === 0)) {
    await page.waitForTimeout(1500);
  }
  if (!signedIn(page.url())) {
    console.error("Timed out before the sign-in finished — nothing was saved.");
    await browser.close();
    await mongoose.disconnect();
    process.exit(1);
  }

  await page.waitForTimeout(3000); // let the site finish setting its cookies
  await saveBoardSession(String(candidate._id), board, context, credential.boardUsername, password);
  console.log(`Saved the ${board} session for ${candidate.name}. The worker will now start signed in.`);
  await browser.close();
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

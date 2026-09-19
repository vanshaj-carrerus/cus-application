import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const PROXY_HOST = "brd.superproxy.io:9222";
const PROXY_USER = "brd-customer-hl_48d2fbfd-zone-cus_application";

function buildProxyEndpoint(): string {
  const password = process.env.BRIGHT_DATA_PASSWORD;
  if (!password) {
    throw new Error("BRIGHT_DATA_PASSWORD is not set — required to connect to the residential proxy endpoint.");
  }
  return `wss://${PROXY_USER}:${password}@${PROXY_HOST}`;
}

export interface ProxySession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/**
 * Connects Playwright to Bright Data's remote residential proxy over CDP so apply
 * flows can be exercised through different regional exit nodes during testing.
 */
export async function openProxySession(testUrl: string): Promise<ProxySession> {
  const browser = await chromium.connectOverCDP(buildProxyEndpoint());
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  await page.goto(testUrl, { waitUntil: "domcontentloaded" });
  return { browser, context, page };
}

export async function closeProxySession(session: ProxySession): Promise<void> {
  await session.page.close();
  // connectOverCDP attaches to a remote browser instance rather than launching a
  // local process, so only the context should be torn down, not the browser itself.
  await session.context.close();
}

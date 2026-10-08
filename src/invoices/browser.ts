import { finishLogin, pendingLogin, withSite, type CamofoxSite } from "./camofox.js";

/**
 * Browser-backed providers (portals whose APIs only work from an authenticated browser session,
 * e.g. AliExpress mtop). Each site has its own isolated Camoufox profile (see camofox.ts):
 *   - `accountable-mcp browser-login <site>` opens a visible window once so the user can log in;
 *   - fetches then reuse the profile headless and call the site's own JS API client in page context.
 */

export const BROWSER_SITES: Record<string, { loginUrl: string; checkUrl: string; loggedIn: (url: string) => boolean }> = {
  aliexpress: {
    loginUrl: "https://www.aliexpress.com/p/order/index.html",
    checkUrl: "https://www.aliexpress.com/p/order/index.html",
    loggedIn: (url) => !/login/i.test(url),
  },
};

export function requireSite(site: string): (typeof BROWSER_SITES)[string] {
  const cfg = BROWSER_SITES[site];
  if (!cfg) throw new Error(`Unknown browser site "${site}". Known: ${Object.keys(BROWSER_SITES).join(", ")}`);
  return cfg;
}

/** Interactive one-time login: opens a visible Camoufox window and waits until the user is logged in. */
export async function browserLogin(site: string): Promise<void> {
  const cfg = requireSite(site);
  await withSite(
    site,
    async (c: CamofoxSite) => {
      await c.openTab(cfg.loginUrl);
      process.stdout.write(`Log in to ${site} in the Camoufox window that just opened. Waiting up to 10 minutes…\n`);
      const deadline = Date.now() + 10 * 60_000;
      // Sites redirect somewhere else after login (e.g. the home page), so probe the check URL in a
      // second tab instead of watching the login tab's URL.
      const probe = await c.openTab(cfg.checkUrl);
      for (;;) {
        await new Promise((r) => setTimeout(r, 5000));
        await c.navigate(probe, cfg.checkUrl).catch(() => undefined);
        const url = await c.url(probe).catch(() => "");
        if (url.startsWith(cfg.checkUrl.split("?")[0]) && cfg.loggedIn(url)) break;
        if (Date.now() > deadline) throw new Error("Timed out waiting for login.");
      }
      await new Promise((r) => setTimeout(r, 3000)); // let session cookies settle
      process.stdout.write(`Logged in to ${site}; the Camoufox profile "${site}" keeps the session.\n`);
    },
    { headed: true },
  );
}

/** Poll a pending site login window (started with startLogin); closes it once the check URL loads logged-in. */
export async function checkSiteLogin(site: string): Promise<{ loggedIn: boolean; url: string }> {
  const cfg = requireSite(site);
  const p = pendingLogin(site);
  if (!p) throw new Error(`No ${site} login in progress; call accountable_login_start first.`);
  const isIn = (url: string) => url.startsWith(cfg.checkUrl.split("?")[0]) && cfg.loggedIn(url);
  let url = await p.c.url(p.tab).catch(() => "");
  if (!isIn(url)) {
    // The site may have redirected elsewhere after login: re-open the check URL in the same tab.
    await p.c.navigate(p.tab, cfg.checkUrl).catch(() => undefined);
    await p.c.wait(p.tab, 10_000);
    url = await p.c.url(p.tab).catch(() => "");
  }
  if (!isIn(url)) return { loggedIn: false, url };
  await new Promise((r) => setTimeout(r, 3000)); // let session cookies settle
  await finishLogin(site);
  return { loggedIn: true, url };
}

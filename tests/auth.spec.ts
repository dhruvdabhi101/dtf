import { describe, test } from '../src/index.ts';

/**
 * Browser-based sign-in, the way it is actually testable in CI.
 *
 * The flow being covered: user clicks Sign In → the app opens the system browser
 * at the identity provider → the user authenticates there → the IdP redirects to
 * the app's custom scheme → the app exchanges the token and updates its UI.
 *
 * That crosses two process boundaries, which is why an in-process harness can
 * only ever test the first hop. The split that works is:
 *
 *   1. Assert the *handoff*: the browser opened, at the right authorize URL,
 *      with the right client_id, redirect_uri and PKCE parameters. This is the
 *      part your app is responsible for, and it is fully deterministic.
 *   2. Assert the *return*: fire the callback deep link yourself with a token
 *      minted for a CI service account, and check the app handles it.
 *
 * What is deliberately NOT automated is typing credentials into the IdP. That
 * buys 2FA prompts, bot detection, and provider credentials living in your
 * pipeline, in exchange for testing someone else's login page.
 */
describe('Sign-in handoff to the browser', () => {
  test('the tray offers Sign in when signed out', async ({ app }) => {
    const menu = await app.tray.open();
    try {
      await menu.shouldHaveItem('Sign in');
    } finally {
      await menu.close();
    }
  });

  /**
   * Asserting the authorize URL without touching the browser.
   *
   * This is the version to prefer when the app can be made to log the URL it is
   * about to open: it needs no extra permissions, cannot be flaked by a slow
   * browser launch, and works identically on a laptop and in CI. A wrong
   * redirect_uri or a dropped PKCE challenge breaks sign-in for every user, and
   * nothing inside the app's own window can see it.
   */
  test('the authorize URL carries the right OAuth parameters', async ({ app }) => {
    await app.tray.click('Sign in');

    const line = await app.waitForLog(/signin-opening-browser url=/, { timeoutMs: 15_000 });
    const url = new URL(line.line.split('url=')[1]);
    const params = url.searchParams;

    if (url.origin + url.pathname !== 'https://example.com/oauth/authorize') {
      throw new Error(`wrong authorize endpoint: ${url.origin + url.pathname}`);
    }
    if (params.get('client_id') !== 'dtf-fixture') {
      throw new Error(`wrong client_id: ${params.get('client_id')}`);
    }
    if (params.get('redirect_uri') !== 'dtffixture://auth') {
      throw new Error(`wrong redirect_uri: ${params.get('redirect_uri')}`);
    }
    if (params.get('code_challenge_method') !== 'S256') {
      throw new Error(`PKCE challenge method missing or weak: ${params.get('code_challenge_method')}`);
    }
  }, { timeoutMs: 40_000 });

  /**
   * The same assertion made against the real browser, for apps that do not log
   * the URL they open.
   *
   * Skipped by default because it needs the Automation permission for the test
   * process: Chromium-based browsers refuse AXManualAccessibility, so their URL
   * is only reachable through AppleScript. Grant it under System Settings >
   * Privacy & Security > Automation (a one-time prompt), or pre-grant
   * kTCCServiceAppleEvents on a CI runner, then un-skip.
   */
  test.skip('the browser is actually sent to the authorize URL', async ({ app }) => {
    await app.tray.click('Sign in');

    const page = await app.browser.shouldOpenUrl(/example\.com\/oauth\/authorize/, { timeoutMs: 25_000 });
    if (new URL(page.url).searchParams.get('client_id') !== 'dtf-fixture') {
      throw new Error(`wrong client_id in the browser: ${page.url}`);
    }
    await app.browser.closeMatching(/example\.com\/oauth/);
  }, { timeoutMs: 60_000 });
});

describe('Sign-in return via deep link', () => {
  test('a callback deep link signs the app in', async ({ app }) => {
    await app.openDeepLink('dtffixture://auth?token=ci-test-token&email=ci%40example.com');

    await app.waitForLog(/auth-success user=ci@example\.com/, { timeoutMs: 15_000 });

    // The OS-level half: the tray must reflect the new state.
    const menu = await app.tray.open();
    try {
      await menu.shouldHaveItem('Signed in as ci@example.com');
    } finally {
      await menu.close();
    }
  });

  test('a callback without a token is rejected', async ({ app }) => {
    await app.openDeepLink('dtffixture://auth?email=attacker%40example.com');
    await app.waitForLog(/auth-failed reason=missing-token/, { timeoutMs: 15_000 });
  });
});

/**
 * The full email-and-password login, end to end.
 *
 * This is the version to reach for when the identity provider is your own and
 * has no CAPTCHA and no 2FA on the test account — then there is nothing
 * fundamentally un-automatable about it, and one test covering the real round
 * trip is worth having.
 *
 * The browser runs on a throwaway profile with `--force-renderer-accessibility`,
 * so the login form is fully addressable and every run starts logged out. Keep
 * this to a single test: it is an order of magnitude slower than the deep-link
 * path, and it depends on a service you do not control.
 */
describe('Full browser login (email + password)', () => {
  const IDP_PAGE = new URL('./fixtures/idp-login.html', import.meta.url).href;

  test('signing in through the browser signs in the app', async ({ app }) => {
    const browser = await app.browser.launchIsolated(IDP_PAGE);
    try {
      // Credentials come from the environment. Use a dedicated CI account, and
      // never a real user's — the same rule as any other E2E login test.
      const email = process.env.DTF_TEST_EMAIL ?? 'ci@example.com';
      const password = process.env.DTF_TEST_PASSWORD ?? 'correct-horse';

      await browser.find('textfield[title=Email]').fill(email);
      await browser.find('textfield[title=Password]').fill(password);
      await browser.find('button[title="Sign in"]').click();

      // The IdP redirects to the app's custom scheme, and the browser asks the
      // user to confirm before handing off. That prompt lives inside the browser
      // window, not in the OS dialog list.
      await app.browser.confirmProtocolLaunch(browser);

      await app.waitForLog(/auth-success user=/, { timeoutMs: 20_000 });

      const menu = await app.tray.open();
      try {
        await menu.shouldHaveItem(`Signed in as ${email}`);
      } finally {
        await menu.close();
      }
    } finally {
      await browser.close();
    }
  }, { timeoutMs: 120_000 });

  test('bad credentials are rejected without signing in', async ({ app }) => {
    // Scope the negative assertion to this test: the app instance is shared
    // across the file, and an earlier test already signed in successfully.
    const since = app.logCursor();
    const browser = await app.browser.launchIsolated(IDP_PAGE);
    try {
      await browser.find('textfield[title=Email]').fill('ci@example.com');
      await browser.find('textfield[title=Password]').fill('wrong-password');
      await browser.find('button[title="Sign in"]').click();

      await browser.find('"Invalid credentials"').shouldExist();
      await app.shouldNotLog(/auth-success/, { since });
    } finally {
      await browser.close();
    }
  }, { timeoutMs: 120_000 });
});

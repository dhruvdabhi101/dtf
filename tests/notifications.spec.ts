import { describe, test } from '../src/index.ts';

/**
 * OS notifications.
 *
 * Posting a notification is easy to unit-test; verifying the OS actually
 * *delivered* one, with the right text and attributed to the right app, is not
 * possible from inside the process. That is the gap this covers.
 */
describe('Notifications', () => {
  // `anyApp` is here because the bundled fixture is only ad-hoc signed, so macOS
  // will not let it register with the notification system and it falls back to
  // the scripting bridge — which attributes the banner to the script host rather
  // than to the fixture. Testing a properly signed application, drop `anyApp`
  // and the banner is matched to the app under test automatically.
  const fromFixture = { title: 'DTF Fixture', anyApp: true };

  test('sending from the tray delivers a banner with the right content', async ({ app }) => {
    await app.notifications.dismissAll();
    await app.tray.click('Send Notification');

    const notification = await app.notifications.shouldHave(fromFixture);
    if (!notification.body.includes('Notification body')) {
      throw new Error(`unexpected notification body: ${JSON.stringify(notification.body)}`);
    }
    if (notification.subtitle !== 'Subtitle line') {
      throw new Error(`unexpected subtitle: ${JSON.stringify(notification.subtitle)}`);
    }
    await app.notifications.dismiss(fromFixture);
  });

  test('a banner can be dismissed', async ({ app }) => {
    await app.tray.click('Send Notification');
    await app.notifications.shouldHave(fromFixture);
    await app.notifications.dismissAll();
    await app.notifications.shouldNotHave(fromFixture, { withinMs: 2500 });
  });

  test('nothing is posted unless the app posts it', async ({ app }) => {
    await app.notifications.dismissAll();
    await app.notifications.shouldNotHave(fromFixture, { withinMs: 2500 });
  });
});

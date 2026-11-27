import { BuildManager } from "@/lib/build-manager";
import { AGENT_PORT } from "@/lib/protocol";
import { FAILURE_NOTIFICATION_ID } from "@/lib/storage";
import { TIDY_NOTIFICATION_ID, TidyManager } from "@/lib/tidy-manager";

/**
 * The service worker is the build host. It owns the agent loop (BuildManager),
 * runs the browser tools in-process, and drives scheduled rebuilds from an alarm.
 *
 * New-tab pages are thin views that connect on AGENT_PORT. Closing every tab
 * doesn't stop a build: the worker keeps itself warm during an active turn.
 *
 * The same alarm also feeds TidyManager: once a day it reviews a small batch
 * of bookmarks and stores a plan the user approves from the new-tab page.
 */
const HEARTBEAT_ALARM = "homepage-heartbeat";

export default defineBackground(() => {
  const manager = new BuildManager();
  const tidy = new TidyManager();
  const tick = () => {
    void manager.tick();
    void tidy.tick();
  };

  browser.runtime.onConnect.addListener((port) => {
    if (port.name === AGENT_PORT) {
      manager.attach(port);
      tidy.attach(port);
      tick();
    }
  });

  // ~1 min is the chrome.alarms floor.
  browser.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM) tick();
  });

  browser.runtime.onStartup.addListener(tick);
  browser.runtime.onInstalled.addListener(tick);
  browser.notifications.onClicked.addListener((id) => {
    if (id !== FAILURE_NOTIFICATION_ID && id !== TIDY_NOTIFICATION_ID) return;
    void browser.tabs.create({});
  });

  tick();
});

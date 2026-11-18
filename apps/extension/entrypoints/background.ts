import { BuildManager } from "@/lib/build-manager";
import { AGENT_PORT } from "@/lib/protocol";
import { FAILURE_NOTIFICATION_ID } from "@/lib/storage";

/**
 * The service worker is the build host. It owns the agent loop (BuildManager),
 * runs the browser tools in-process, and drives scheduled rebuilds from an alarm.
 *
 * New-tab pages are thin views that connect on AGENT_PORT. Closing every tab
 * doesn't stop a build: the worker keeps itself warm during an active turn.
 */
const HEARTBEAT_ALARM = "homepage-heartbeat";

export default defineBackground(() => {
  const manager = new BuildManager();

  browser.runtime.onConnect.addListener((port) => {
    if (port.name === AGENT_PORT) {
      manager.attach(port);
      void manager.tick();
    }
  });

  // ~1 min is the chrome.alarms floor.
  browser.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM) void manager.tick();
  });

  browser.runtime.onStartup.addListener(() => void manager.tick());
  browser.runtime.onInstalled.addListener(() => void manager.tick());
  browser.notifications.onClicked.addListener((id) => {
    if (id !== FAILURE_NOTIFICATION_ID) return;
    void browser.tabs.create({});
  });

  void manager.tick();
});

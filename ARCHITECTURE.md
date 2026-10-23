# Architecture

There is no server of ours. The extension talks to the OpenAI-compatible API at the base URL you set.

| | Runs where | Does what |
|---|---|---|
| **Extension** (service worker) | Your browser | Hosts the build: runs the chat loop, executes `getHistory` / `getPageHtml` / `submitHomepage`, persists the homepage |
| **Extension** (new-tab page(s)) | Your browser | Thin view: subscribes to the worker over a port, renders live progress and the finished homepage |
| **Chat API** | The base URL you set | Completes each turn (`POST /chat/completions`) and returns assistant text or tool calls |

The agent loop runs **in the service worker** (`apps/extension/lib/build-manager.ts` calls `runHomepageBuild`), so a build
survives closing the tab, shows up in every open tab, and can run headless on a
`chrome.alarms` schedule. The browser tools execute in the extension too, because they
need `chrome.history` and `chrome.tabs`. Page HTML comes back inline in the `getPageHtml`
tool result, truncated when it is long. There is no sandbox and no remote session: the only
success path is `submitHomepage` with the component source. There is no
inbound connection and no public endpoint.

```
service worker                         chat API
    │                                      │
    ├─ POST /chat/completions ────────────▶│  system + kickoff
    │◀─ tool_calls: getHistory ────────────┤
    ├─ chrome.history                      │
    ├─ POST /chat/completions ────────────▶│  tool result: history digest
    │◀─ tool_calls: getPageHtml ───────────┤
    ├─ tabs + scripting                    │
    ├─ POST /chat/completions ────────────▶│  tool result: inline HTML
    │◀─ tool_calls: submitHomepage ────────┤
    └─ save the component source           │
```

### Keeping the worker alive

An MV3 service worker is torn down after ~30s idle, and a build spends most of its
wall clock waiting on the model. Three things keep it alive or bring it back:

- **During a turn**, the in-flight completion request plus a 20s self-ping
  (`runtime.getPlatformInfo`) reset the idle timer.
- **A 1-minute alarm heartbeat** calls `BuildManager.tick()`. It does not
  reattach a remote session. A worker restart drops the in-flight build; the
  last saved homepage stays.
- **The same heartbeat** drives scheduled rebuilds (`lib/auto-rebuild.ts`), so the
  first new tab of the day already shows a fresh homepage.

### Tabs are views

Each new tab connects on a port (`lib/protocol.ts`), receives a snapshot of the
build state, then streams phase/text/log deltas. Every open tab shows the same live
run. A throttled snapshot is also mirrored to storage so a tab opened while the
worker is asleep paints instantly.

The finished component renders inside the extension's sandbox page
(`entrypoints/sandbox/`, framed by `entrypoints/newtab/components/HomepagePreview.tsx`):
it is model-written code, so it runs sandboxed and offline, not in the extension's own
page. Links open in a new tab, since most sites refuse to be framed.

## Layout

```
packages/agent-core/      host-agnostic agent loop — imports no chrome.*, browser.*, or node:*
  orchestrator.ts         runHomepageBuild: chat completions loop and tool dispatch
  prompt.ts               system prompt + per-build kickoff message
  schemas.ts              tool input schemas and defaults
  history-digest.ts       narrows raw history to fit a tool result
  site-filter.ts          blocklist, private-host, and address checks
  types.ts                BrowserBridge, RunPhase, digest and scrape types

apps/extension/           MV3 extension (WXT + React)
  entrypoints/
    background.ts         service worker: hosts BuildManager, alarm heartbeat
    scraper.content.ts    injected into scraped tabs: scroll, return HTML
    newtab/               the new-tab UI (thin client onto the worker)
  lib/
    build-manager.ts      single-flight build host, broadcast, keepalive
    browser-bridge.ts     BrowserBridge over chrome.history / chrome.tabs
    history.ts            getHistory: group and rank chrome.history by domain
    scraper.ts            getPageHtml: load URLs in a background window, sanitize HTML
    protocol.ts           page ↔ worker messages and the five UI build steps
    auto-rebuild.ts       when to rebuild on a schedule
    storage.ts            every chrome.storage key, settings, saved homepage
    transpile.ts          TSX → JS for the preview

harness/                  Bun scripts: drive agent-core with a fixture/fetch bridge, test the extension
```

## Verification

| Command | Proves |
|---|---|
| `pnpm test` | The history digest, the blocklist, and the chat tool loop (local mock, no API calls) |
| `pnpm agent:run` | Full build against the configured API: history, inline HTML, `submitHomepage`; writes `harness/out` |
| `pnpm agent:verify` | The deliverable transforms, evaluates and server-renders |
| `pnpm extension:test` | In headless Chrome: worker registers, new tab renders, port protocol answers, `chrome.history` reads |

`pnpm agent:run` needs `AI_NEWTAB_BASE_URL`, `AI_NEWTAB_API_KEY`, and `AI_NEWTAB_MODEL`
in the environment and spends API credits. The
harness's bridge uses fixture history and a plain `fetch`, so it can't see
logged-in pages — that's the whole reason `getPageHtml` runs in your browser.

## Gotchas worth knowing

**The model must call `submitHomepage`.** A plain assistant reply ends the build
with an error. The component source is the tool argument, not a file.

**Tool results carry the page.** `getPageHtml` returns sanitized HTML inline,
cut at 24,000 characters, with `truncated: true` when that happens. There is no
separate read of mounted files.

**Every tool call gets a tool message.** An unknown tool name or arguments that
are not JSON become `{"error":"..."}` and the loop continues. The next completion
still has to see a result for that `tool_call_id`.

**Blocked content never enters the tool JSON.** A redirect onto a blocked host,
or a page served from a private address, is reported as
`blocked by the user's settings` with no title and no HTML.

**The loop stops at 16 completions.** A build that never submits throws
`tool loop exceeded 16 turns`.

## Privacy

The editable blocked-sites list is enforced in agent-core's tool handlers, not
just the prompt: blocked domains are excluded from history digests and their
counts, and blocked or non-HTTP(S) page requests never reach the browser bridge.
Each scraped page's final URL is checked again before the tool result is built, so a redirect onto
a blocked host is dropped: the browser still loads it, but nothing it read is
sent. Loopback, private-IP and local-network hosts are always blocked, whatever
the list says. A name can still resolve to a private address (`fritz.box`, an
intranet name), so the scraper also records the address each page was served
from (`webRequest`, observe only) and the page is dropped before the tool result is built when it is
private. That address is only reported when the extension's own API requests
connect to a public address; behind a proxy at a private address, or when Chrome
reports no address, the name check is all there is. History digests still list
such a domain. Subresource loads are not intercepted.

The history digest and page HTML are sent inline to the base URL you configured.
There is no managed session and no uploaded file to delete afterwards. What that
provider retains is its own policy. Confirm that before distributing this.

The API key lives in `chrome.storage.local`, readable by anyone with access to the
browser profile. Fine for a tool you run yourself; **do not ship this to the Web Store**
without moving the key behind a proxy.

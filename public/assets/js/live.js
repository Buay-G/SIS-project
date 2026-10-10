/*
 * live.js — live updates for every portal (put this at /assets/js/live.js).
 *
 * Problem it solves: a request or notification sent by one person used to
 * show up for the other person only after their browser refreshed (or after
 * a slow 60-second poll). Now the server pings every open portal the moment
 * anything changes (GET /api/live/events, Server-Sent Events) and each portal
 * re-checks its own bell/badges/lists right away.
 *
 * How a portal uses it (portal JS files already include the tiny loader that
 * injects this script, so they only do):
 *
 *     window.onLiveChange(() => loadMyNotifications());
 *
 * Safety nets, so nothing depends on the live connection alone:
 *   - a short fallback poll while the tab is visible (30 s),
 *   - an instant refresh when the tab becomes visible / regains focus /
 *     the network comes back (browsers freeze timers in background tabs),
 *   - automatic reconnect if the stream drops or a proxy blocks it.
 * Refreshes are debounced, so a burst of changes causes one refresh.
 */
(function () {
  "use strict";
  if (window.__liveStarted) return;
  window.__liveStarted = true;

  var callbacks = [];
  var queued = window.__liveQueue || [];
  window.onLiveChange = function (fn) {
    if (typeof fn === "function" && callbacks.indexOf(fn) === -1) callbacks.push(fn);
  };
  queued.forEach(window.onLiveChange);

  // Functions many portals already define globally; called too if present,
  // so portals not yet wired explicitly still get a refreshed bell/badge.
  var KNOWN_GLOBALS = [
    "loadAlertsDropdown",
    "refreshUnreadMessagesBadge",
    "loadRegistrarNotifications",
    "refreshDocFeeBadge",
  ];

  var DEBOUNCE_MS = 600;
  var MIN_GAP_MS = 2000;
  var POLL_MS = 30000;
  var lastRun = 0;
  var timer = null;

  function runAll() {
    lastRun = Date.now();
    var fns = callbacks.slice();
    KNOWN_GLOBALS.forEach(function (name) {
      if (typeof window[name] === "function" && fns.indexOf(window[name]) === -1) {
        fns.push(window[name]);
      }
    });
    fns.forEach(function (fn) {
      try {
        var r = fn();
        if (r && typeof r.catch === "function") r.catch(function () {});
      } catch (e) {
        /* one portal callback failing must never stop the others */
      }
    });
  }

  function schedule() {
    if (timer) return;
    var wait = Math.max(DEBOUNCE_MS, MIN_GAP_MS - (Date.now() - lastRun));
    timer = setTimeout(function () {
      timer = null;
      runAll();
    }, wait);
  }

  // ---- live connection ----
  var es = null;
  var reconnectTimer = null;
  function connect() {
    if (typeof window.EventSource !== "function") return;
    if (es) return;
    try {
      es = new EventSource("/api/live/events", { withCredentials: true });
    } catch (e) {
      es = null;
      return;
    }
    es.addEventListener("changed", schedule);
    es.onopen = function () {
      // We may have missed changes while disconnected.
      schedule();
    };
    es.onerror = function () {
      // EventSource retries by itself while CONNECTING. If the server
      // refused it outright (not logged in, blocked by a proxy) it ends up
      // CLOSED — try again later; the fallback poll covers the gap.
      if (es && es.readyState === 2) {
        try {
          es.close();
        } catch (e) {}
        es = null;
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 60000);
      }
    };
  }

  // ---- fallback poll + wake-up refreshes ----
  setInterval(function () {
    if (document.visibilityState === "visible") schedule();
  }, POLL_MS);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      connect();
      schedule();
    }
  });
  window.addEventListener("focus", schedule);
  window.addEventListener("online", function () {
    connect();
    schedule();
  });

  connect();
})();

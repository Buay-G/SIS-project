/* first-login-pin.js — shared "set your 6-digit PIN" screen.
 *
 * Every account in the system now starts on the default password (1122)
 * with must_change_password = TRUE, and the server refuses every request
 * except /api/me, /api/logout and the change-password routes until the
 * person has replaced it with a 6-digit PIN. This script is the screen
 * for that: drop it into any portal's index.html (right after guard.js)
 *
 *   <script src="/assets/js/first-login-pin.js"></script>
 *
 * and it asks /api/me whether the signed-in account still has to change
 * its password. If so it shows a blocking dialog (cannot be dismissed),
 * sends the new PIN to POST /api/auth/change-password, then reloads the
 * page. If not, it does nothing at all. Self-contained: no dependencies,
 * its own styles, English + Amharic (follows the portal's language
 * choice, stored by i18n.js under "sis_lang").
 */
(function () {
  "use strict";
  if (window.__firstLoginPinLoaded) return;
  window.__firstLoginPinLoaded = true;

  var STR = {
    en: {
      title: "Set your new PIN",
      hint: "For your security, replace the default password with a 6-digit PIN before you continue.",
      current: "Current password",
      currentHint: "The default password you were given",
      pin: "New PIN (6 digits)",
      confirm: "Confirm new PIN",
      save: "Save PIN",
      saving: "Saving…",
      logout: "Log out",
      errCurrent: "Enter your current password.",
      errLen: "The new PIN must be exactly 6 digits (numbers only).",
      errMatch: "The two PINs don't match.",
      errNetwork: "Couldn't reach the server. Check your connection and try again.",
      done: "PIN updated. Loading your portal…"
    },
    am: {
      title: "አዲስ ፒን ያዘጋጁ",
      hint: "ለደህንነትዎ፣ ከመቀጠልዎ በፊት ነባሪውን የይለፍ ቃል በባለ 6 አሃዝ ፒን ይተኩ።",
      current: "የአሁኑ የይለፍ ቃል",
      currentHint: "የተሰጠዎት ነባሪ የይለፍ ቃል",
      pin: "አዲስ ፒን (6 አሃዝ)",
      confirm: "አዲሱን ፒን ያረጋግጡ",
      save: "ፒን አስቀምጥ",
      saving: "በማስቀመጥ ላይ…",
      logout: "ውጣ",
      errCurrent: "የአሁኑን የይለፍ ቃል ያስገቡ።",
      errLen: "አዲሱ ፒን በትክክል 6 አሃዝ (ቁጥሮች ብቻ) መሆን አለበት።",
      errMatch: "ሁለቱ ፒኖች አይመሳሰሉም።",
      errNetwork: "ከአገልጋዩ ጋር መገናኘት አልተቻለም። ግንኙነትዎን ያረጋግጡ እና እንደገና ይሞክሩ።",
      done: "ፒን ተዘምኗል። ፖርታልዎ በመጫን ላይ…"
    }
  };

  function lang() {
    try {
      return localStorage.getItem("sis_lang") === "am" ? "am" : "en";
    } catch (e) {
      return "en";
    }
  }
  function T(key) {
    var d = STR[lang()] || STR.en;
    return d[key] || STR.en[key] || key;
  }

  var CSS =
    ".flp-backdrop{position:fixed;inset:0;z-index:100000;background:rgba(13,51,36,.72);display:flex;align-items:center;justify-content:center;padding:16px;font-family:inherit;}" +
    ".flp-box{background:#fff;border-radius:16px;width:100%;max-width:400px;padding:26px 24px 20px;box-shadow:0 24px 60px rgba(0,0,0,.35);max-height:100%;overflow:auto;}" +
    ".flp-icon{width:46px;height:46px;border-radius:50%;background:#fbeecb;color:#a97a1f;display:flex;align-items:center;justify-content:center;margin:0 auto 12px;font-size:22px;}" +
    ".flp-title{font-size:18px;font-weight:700;text-align:center;color:var(--green-900,#0d3324);margin:0 0 6px;}" +
    ".flp-hint{font-size:13.5px;line-height:1.5;color:var(--text-dim,#5c6b64);text-align:center;margin:0 0 16px;}" +
    ".flp-field{margin-bottom:12px;text-align:left;}" +
    ".flp-field label{display:block;font-size:12.5px;font-weight:600;color:var(--green-900,#0d3324);margin-bottom:5px;}" +
    ".flp-field input{width:100%;box-sizing:border-box;padding:11px 12px;font-size:15px;border:1px solid var(--border,#d5ddd9);border-radius:10px;background:#fff;color:inherit;font-family:inherit;}" +
    ".flp-field input:focus{outline:2px solid var(--gold,#c99a4a);outline-offset:1px;}" +
    ".flp-pin{letter-spacing:.4em;text-align:center;font-size:18px;}" +
    ".flp-err{min-height:18px;font-size:12.5px;font-weight:600;color:#c0392b;margin:0 0 10px;text-align:left;}" +
    ".flp-ok{color:#1f6b53;}" +
    ".flp-actions{display:flex;gap:10px;}" +
    ".flp-btn{flex:1;padding:11px 14px;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;border:1px solid transparent;}" +
    ".flp-btn[disabled]{opacity:.65;cursor:default;}" +
    ".flp-primary{background:var(--green-800,#123c2c);color:#fff;}" +
    ".flp-ghost{background:#fff;color:var(--green-900,#0d3324);border-color:var(--border,#d5ddd9);flex:0 0 auto;}";

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }

  function field(id, labelText, input) {
    var wrap = el("div", { class: "flp-field" });
    var lab = el("label", { for: id }, labelText);
    wrap.appendChild(lab);
    wrap.appendChild(input);
    return wrap;
  }

  function show() {
    if (document.getElementById("flpBackdrop")) return;
    if (!document.getElementById("flpStyle")) {
      var st = el("style", { id: "flpStyle" });
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var backdrop = el("div", { class: "flp-backdrop", id: "flpBackdrop" });
    var box = el("div", {
      class: "flp-box",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "flpTitle"
    });
    box.appendChild(el("div", { class: "flp-icon", "aria-hidden": "true" }, "🔑"));
    box.appendChild(el("h2", { class: "flp-title", id: "flpTitle" }, T("title")));
    box.appendChild(el("p", { class: "flp-hint" }, T("hint")));

    var cur = el("input", {
      type: "password",
      id: "flpCurrent",
      autocomplete: "current-password",
      placeholder: T("currentHint")
    });
    var pin = el("input", {
      type: "password",
      id: "flpPin",
      class: "flp-pin",
      inputmode: "numeric",
      pattern: "[0-9]*",
      maxlength: "6",
      autocomplete: "new-password"
    });
    var pin2 = el("input", {
      type: "password",
      id: "flpPin2",
      class: "flp-pin",
      inputmode: "numeric",
      pattern: "[0-9]*",
      maxlength: "6",
      autocomplete: "new-password"
    });
    [pin, pin2].forEach(function (i) {
      i.addEventListener("input", function () {
        var clean = i.value.replace(/\D/g, "").slice(0, 6);
        if (clean !== i.value) i.value = clean;
      });
    });

    box.appendChild(field("flpCurrent", T("current"), cur));
    box.appendChild(field("flpPin", T("pin"), pin));
    box.appendChild(field("flpPin2", T("confirm"), pin2));

    var err = el("p", { class: "flp-err", id: "flpErr", role: "alert", "aria-live": "assertive" });
    box.appendChild(err);

    var actions = el("div", { class: "flp-actions" });
    var out = el("button", { type: "button", class: "flp-btn flp-ghost" }, T("logout"));
    var save = el("button", { type: "button", class: "flp-btn flp-primary" }, T("save"));
    actions.appendChild(out);
    actions.appendChild(save);
    box.appendChild(actions);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    function fail(msg) {
      err.className = "flp-err";
      err.textContent = msg;
    }

    function submit() {
      fail("");
      if (!cur.value) { fail(T("errCurrent")); cur.focus(); return; }
      if (!/^\d{6}$/.test(pin.value)) { fail(T("errLen")); pin.focus(); return; }
      if (pin.value !== pin2.value) { fail(T("errMatch")); pin2.focus(); return; }
      save.disabled = true;
      save.textContent = T("saving");
      fetch("/api/auth/change-password", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPass: cur.value, newPass: pin.value })
      })
        .then(function (res) {
          if (res.status === 401) { window.location.href = "/login.html"; return null; }
          return res.json().catch(function () { return {}; }).then(function (data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function (r) {
          if (!r) return;
          if (!r.ok) {
            fail((r.data && r.data.error) || T("errNetwork"));
            save.disabled = false;
            save.textContent = T("save");
            return;
          }
          err.className = "flp-err flp-ok";
          err.textContent = T("done");
          setTimeout(function () { window.location.reload(); }, 700);
        })
        .catch(function () {
          fail(T("errNetwork"));
          save.disabled = false;
          save.textContent = T("save");
        });
    }

    save.addEventListener("click", submit);
    [cur, pin, pin2].forEach(function (i) {
      i.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
    });
    out.addEventListener("click", function () {
      fetch("/api/logout", { method: "POST", credentials: "include" })
        .catch(function () {})
        .then(function () { window.location.href = "/login.html"; });
    });
    cur.focus();
  }

  function init() {
    fetch("/api/me", { credentials: "include" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (me) { if (me && me.must_change_password) show(); })
      .catch(function () {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

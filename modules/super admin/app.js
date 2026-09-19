/* This file relies on i18n.js being loaded first (t, applyTranslations,
   getCurrentLang, window.setLang) — see index.html script order.

   Mirrors the Zonal Admin portal's app.js conventions exactly (same
   apiGet/apiPost helpers, same showConfirm/showPasswordConfirm/
   showCredentialsModal modals, same panel/table/form-grid CSS classes)
   so the two portals feel like the same product — just pointed at
   /api/super/* and /api/registrar/pending-roster instead of /api/zonal/*.
   Auth is the httpOnly `auth_token` cookie set at login, same as every
   other portal in this system. */
const API_BASE = "";

function handleUnauthorized() {
  window.location.href = "/login.html";
}

async function apiGet(path, params) {
  let url = API_BASE + path;
  if (params) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(
        ([, v]) => v !== undefined && v !== null && v !== "",
      ),
    );
    const s = qs.toString();
    if (s) url += "?" + s;
  }
  const res = await fetch(url, { credentials: "include" });
  if (res.status === 401) {
    handleUnauthorized();
    throw new Error("Not logged in");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
async function apiPost(path, body) {
  return apiSend("POST", path, body);
}
async function apiPut(path, body) {
  return apiSend("PUT", path, body);
}
async function apiDelete(path) {
  return apiSend("DELETE", path);
}
async function apiSend(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401) {
    handleUnauthorized();
    throw new Error("Not logged in");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
// Roster upload is multipart, not JSON — separate from apiSend above,
// which always sends Content-Type: application/json.
async function apiUpload(path, formData) {
  const res = await fetch(API_BASE + path, {
    method: "POST",
    credentials: "include",
    body: formData,
  });
  if (res.status === 401) {
    handleUnauthorized();
    throw new Error("Not logged in");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------------- Styled confirm dialog (same as Zonal Admin's) ------ */
function showConfirm(message, { title, confirmText } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "confirm-modal-backdrop";
    backdrop.innerHTML = `
      <div class="confirm-modal" role="alertdialog" aria-modal="true">
        <div class="confirm-modal-icon"><i data-lucide="alert-triangle"></i></div>
        <h3 class="confirm-modal-title">${title || t("za_confirm_title")}</h3>
        <p class="confirm-modal-msg">${message}</p>
        <div class="confirm-modal-actions">
          <button class="btn ghost" id="confirmModalCancel">${t("za_cancel")}</button>
          <button class="btn primary" id="confirmModalOk">${confirmText || t("za_confirm_yes")}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    if (window.lucide) lucide.createIcons();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
    };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) finish(false);
    });
    backdrop
      .querySelector("#confirmModalCancel")
      .addEventListener("click", () => finish(false));
    backdrop
      .querySelector("#confirmModalOk")
      .addEventListener("click", () => finish(true));
    backdrop.querySelector("#confirmModalOk").focus();
  });
}

/* ---------------- Password-confirm modal ------------------------------
   Same "prove it's you" gate as the Zonal Admin portal, just checked
   against POST /api/super/verify-password instead of /api/zonal/... —
   gates every write in this portal (create zonal admin, school setup,
   subject dictionary, roster upload), with NO approval step behind it;
   this password check is the only gate. */
function showPasswordConfirm(message) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "confirm-modal-backdrop";
    backdrop.innerHTML = `
      <div class="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="pwConfirmTitle" aria-describedby="pwConfirmMsg">
        <div class="confirm-modal-icon"><i data-lucide="lock"></i></div>
        <h3 class="confirm-modal-title" id="pwConfirmTitle">${t("za_pwconfirm_title")}</h3>
        <p class="confirm-modal-msg" id="pwConfirmMsg">${message || t("za_pwconfirm_hint")}</p>
        <div class="form-field" style="text-align:left;margin-bottom:4px;">
          <label for="pwConfirmInput" class="sr-only-label">${t("za_pwconfirm_placeholder")}</label>
          <input type="password" id="pwConfirmInput" autocomplete="current-password" placeholder="${t("za_pwconfirm_placeholder")}">
        </div>
        <p class="confirm-modal-error" id="pwConfirmError" role="alert" aria-live="assertive" style="display:none"></p>
        <div class="confirm-modal-actions">
          <button class="btn ghost" id="pwConfirmCancel">${t("za_cancel")}</button>
          <button class="btn primary" id="pwConfirmOk">${t("za_confirm_yes")}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    if (window.lucide) lucide.createIcons();
    const input = backdrop.querySelector("#pwConfirmInput");
    const errEl = backdrop.querySelector("#pwConfirmError");
    const okBtn = backdrop.querySelector("#pwConfirmOk");
    const cancelBtn = backdrop.querySelector("#pwConfirmCancel");
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
      if (e.key === "Enter" && document.activeElement === input) attempt();
    };
    document.addEventListener("keydown", onKey);
    const attempt = async () => {
      const password = input.value;
      errEl.style.display = "none";
      if (!password) {
        errEl.textContent = t("za_pwconfirm_required");
        errEl.style.display = "block";
        input.focus();
        return;
      }
      okBtn.disabled = true;
      const originalText = okBtn.textContent;
      okBtn.textContent = t("za_loading");
      try {
        await apiPost("/api/super/verify-password", { password });
        finish(true);
      } catch (err) {
        errEl.textContent = err.message || t("za_pwconfirm_wrong");
        errEl.style.display = "block";
        okBtn.disabled = false;
        okBtn.textContent = originalText;
        input.select();
        input.focus();
      }
    };
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) finish(false);
    });
    cancelBtn.addEventListener("click", () => finish(false));
    okBtn.addEventListener("click", attempt);
    input.focus();
  });
}

/* ---------------- Credentials modal (same as Zonal Admin's) ---------- */
function showCredentialsModal(id, password) {
  const backdrop = document.createElement("div");
  backdrop.className = "confirm-modal-backdrop";
  backdrop.innerHTML = `
    <div class="confirm-modal creds-modal" role="alertdialog" aria-modal="true">
      <div class="confirm-modal-icon"><i data-lucide="key-round"></i></div>
      <h3 class="confirm-modal-title">${t("za_creds_modal_title")}</h3>
      <p class="confirm-modal-msg">${t("za_creds_modal_hint")}</p>
      <div class="creds-row"><span class="creds-label">${t("za_identity_id_label")}</span><span class="creds-value" id="credsIdVal">${id}</span></div>
      <div class="creds-row"><span class="creds-label">${t("za_f_password")}</span><span class="creds-value" id="credsPwVal">${password}</span></div>
      <div class="confirm-modal-actions">
        <button class="btn ghost" id="credsCopyBtn">${t("za_creds_copy")}</button>
        <button class="btn primary" id="credsCloseBtn">${t("za_confirm_yes")}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  if (window.lucide) lucide.createIcons();
  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("#credsCloseBtn").addEventListener("click", close);
  backdrop
    .querySelector("#credsCopyBtn")
    .addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(
          `ID: ${id}\n${t("za_f_password")}: ${password}`,
        );
        const btn = backdrop.querySelector("#credsCopyBtn");
        btn.textContent = t("za_saved");
        setTimeout(() => {
          if (btn.isConnected) btn.textContent = t("za_creds_copy");
        }, 1500);
      } catch (e) {
        /* clipboard denied — the visible text is still there to copy by hand */
      }
    });
}

function setMsg(el, text, kind) {
  if (!el) return;
  const icon = kind === "success" ? "check-circle-2" : "alert-triangle";
  el.innerHTML = `<i data-lucide="${icon}" class="msg-icon ${kind}"></i><span>${text}</span>`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  if (window.lucide) lucide.createIcons();
}
function setSuccessMsg(el, text) {
  setMsg(el, text, "success");
}
function setErrorMsg(el, text) {
  setMsg(el, text, "error");
}

function errorPanel(err) {
  const msg = (err && err.message) || String(err);
  return `<div class="panel"><div class="alert-box error">
    <div class="icon"><i data-lucide="alert-triangle"></i></div>
    <div class="body">${msg}</div>
  </div></div>`;
}

function initialsOf(name) {
  if (!name) return "SA";
  const parts = name.trim().split(/\s+/);
  return (
    ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() ||
    parts[0].slice(0, 2).toUpperCase()
  );
}

function fillSelect(el, rows, idKey, nameKey, placeholder) {
  el.innerHTML =
    `<option value="">${placeholder}</option>` +
    rows
      .map((r) => `<option value="${r[idKey]}">${r[nameKey]}</option>`)
      .join("");
}

let role = null;
let CURRENT_USER = null;
let activePage = "sa_nav_dashboard";

let CURRENT_USER_SUPER_PERMISSIONS = null;

/* ---------------- Nav — title-aware: "Manage Super Admins" only shows
   for an Owner, since only an Owner can create/reset a super admin
   account (requireOwner on the backend) — everything else is the same
   for Owner and IT Lead. Built as a function (not a static array) so it
   can read CURRENT_USER.title once it's known.
   Grouped per request: Core & Overview / User & Access Management /
   Institution & Curriculum Structure / Data Management & Operations.
   "Class & Grade Mapping" stayed a clickable page (not folded into a
   header) and was grouped with Stream Setup/Subject Dictionary, since
   the three sat consecutively in the old flat order already.
   An "IT Specialist" (restricted) account additionally has nav items
   hidden per CURRENT_USER_SUPER_PERMISSIONS — mirrors
   requireSuperAdminPermission server-side; hiding here is just UX, the
   route itself is still the real gate. --------- */
// Nav item -> the SUPER_ADMIN_PERMISSION_KEYS entry that gates it.
// Anything not listed here isn't retrofitted yet (see
// requireSuperAdminPermission's comment in server.js) and stays
// visible to every super admin, restricted or not.
const NAV_PERMISSION_MAP = {
  sa_nav_schools: "manage_schools",
  sa_nav_schools_archive: "manage_schools",
  sa_nav_zonal_admins: "manage_zonal_admins",
  sa_nav_subjects: "manage_subject_dictionary",
  sa_nav_roster: "manage_roster",
  sa_nav_streams: "manage_streams",
  sa_nav_audit: "view_audit_log",
};
function navItemAllowed(key) {
  const permKey = NAV_PERMISSION_MAP[key];
  if (!permKey) return true;
  if (!CURRENT_USER_SUPER_PERMISSIONS) return true;
  return !!CURRENT_USER_SUPER_PERMISSIONS[permKey];
}
function getNavSuper() {
  const userAccessItems = [["sa_nav_zonal_admins", "user-cog"]];
  if (CURRENT_USER && CURRENT_USER.title === "Owner") {
    userAccessItems.push(["sa_nav_super_admins", "user-cog"]);
  }
  userAccessItems.push(
    ["sa_nav_permissions", "shield-check"],
    ["sa_nav_audit", "scroll-text"],
  );
  const sections = [
    { sec: "sa_sec_core_overview", items: [["sa_nav_dashboard", "home"]] },
    { sec: "sa_sec_user_access", items: userAccessItems },
    {
      sec: "sa_sec_institution_structure",
      items: [
        ["sa_nav_regions", "map"],
        ["sa_nav_schools", "building-2"],
        ["sa_nav_schools_archive", "archive"],
        ["sa_nav_grade_mapping", "layers"],
        ["sa_nav_streams", "git-branch"],
        ["sa_nav_subjects", "book-open"],
      ],
    },
    {
      sec: "sa_sec_data_ops",
      items: [
        ["sa_nav_roster", "upload"],
        ["sa_nav_emis_roster", "link-2"],
        ["sa_nav_ease_candidates", "clipboard-check"],
      ],
    },
    { sec: "sa_sec_account", items: [["sa_nav_account", "user-circle"]] },
  ];
  return sections
    .map((s) => ({
      ...s,
      items: s.items.filter(([key]) => navItemAllowed(key)),
    }))
    .filter((s) => s.items.length > 0);
}

const SUPER_ADMIN_TITLES = ["Owner", "IT Lead"];
const EDUCATIONAL_LEVELS = ["PRIMARY", "MIDDLE", "SECONDARY"];
// What each Educational Level implies for Grade-Tier(s) — a Secondary
// school always carries BOTH General and Preparatory at once; this
// mirrors EDUCATIONAL_LEVEL_TIERS in server.js exactly.
const EDUCATIONAL_LEVEL_TIERS = {
  PRIMARY: ["BASIC"],
  MIDDLE: ["CORE"],
  SECONDARY: ["GENERAL", "PREPARATORY"],
};
const SCHOOL_LEVELS = ["BASIC", "CORE", "GENERAL", "PREPARATORY"];
const SCHOOL_LEVEL_GRADES = {
  BASIC: "1–6",
  CORE: "7–8",
  GENERAL: "9–10",
  PREPARATORY: "11–12",
};
// The two seeded defaults, used only as a fallback before the live
// catalog loads — Stream Setup (/api/super/streams) is the actual
// source of truth from here on; see loadStreamCatalog().
let SCHOOL_STREAMS = ["NATURAL SCIENCE", "SOCIAL SCIENCE"];
async function loadStreamCatalog() {
  try {
    const rows = await apiGet("/api/super/streams");
    if (rows.length) SCHOOL_STREAMS = rows.map((r) => r.stream_name);
    return rows;
  } catch (err) {
    return SCHOOL_STREAMS.map((s) => ({ stream_name: s }));
  }
}

function navHasPage(key) {
  return getNavSuper().some((section) =>
    section.items.some(([k]) => k === key),
  );
}

function renderNav() {
  const wrap = document.getElementById("navScroll");
  wrap.innerHTML = "";
  getNavSuper().forEach((section) => {
    const lbl = document.createElement("div");
    lbl.className = "nav-label";
    lbl.textContent = t(section.sec);
    wrap.appendChild(lbl);
    section.items.forEach(([key, icon]) => {
      const el = document.createElement("div");
      el.className = "nav-item" + (key === activePage ? " active" : "");
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      if (key === activePage) el.setAttribute("aria-current", "page");
      el.innerHTML = `<span class="ic"><i data-lucide="${icon}"></i></span><span class="nav-item-label">${t(key)}</span>`;
      const go = () => {
        activePage = key;
        render();
        closeMobileNav();
      };
      el.onclick = go;
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });
      wrap.appendChild(el);
    });
  });
}

function openMobileNav() {
  document.getElementById("sidebar").classList.add("open");
  document.getElementById("navOverlay").classList.add("open");
}
function closeMobileNav() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("navOverlay").classList.remove("open");
}

function renderTopChrome() {
  // Owner/IT Lead — falls back to the generic role label for the
  // original manually-seeded row, which may still have no title set.
  const roleLabel =
    CURRENT_USER.title === "Owner"
      ? t("sa_role_owner")
      : CURRENT_USER.title === "IT Lead"
        ? t("sa_role_it_lead")
        : t("sa_role_title");
  const name = CURRENT_USER.admin_full_name || roleLabel;
  document.getElementById("roleTitleTxt").textContent = roleLabel;
  document.getElementById("roleIdTxt").textContent = CURRENT_USER.user_id;
  document.getElementById("whoName").textContent = name;
  document.getElementById("whoRole").textContent = roleLabel;
  const avatarEl = document.getElementById("avatarInit");
  if (avatarEl) {
    avatarEl.innerHTML = CURRENT_USER.avatar_url
      ? `<img class="avatar-img" src="${CURRENT_USER.avatar_url}" alt="">`
      : initialsOf(name);
  }
  document.getElementById("pageTitle").textContent = t(activePage);
}

function genericPanel(titleKey, icon) {
  return `<div class="panel"><h3><i data-lucide="${icon}"></i> ${t(titleKey)}</h3>
    <p class="hint">${t("za_generic_hint")}</p></div>`;
}

/* ==================================================================
   Dashboard — headline numbers from /api/super/stats, a DB/health
   check from /api/super/system-status, recently registered schools,
   and the last few rows of the activity log as a "what's happened
   recently" feed.
   ================================================================== */
function dashboardSkeletonHTML() {
  return `<div class="panel" id="dashDataPanel"><p class="hint">${t("za_loading")}</p></div>`;
}
async function loadAndRenderDashboard() {
  try {
    const [stats, status, schools, activity] = await Promise.all([
      apiGet("/api/super/stats"),
      apiGet("/api/super/system-status"),
      apiGet("/api/super/schools"),
      apiGet("/api/super/audit-log", { limit: 8 }),
    ]);
    const cards = [
      {
        icon: "building-2",
        label: t("sa_dash_schools"),
        value: stats.total_schools,
      },
      { icon: "map", label: t("sa_dash_regions"), value: stats.total_regions },
      { icon: "compass", label: t("sa_dash_zones"), value: stats.total_zones },
      {
        icon: "users",
        label: t("sa_dash_students"),
        value: stats.total_students,
      },
      {
        icon: "graduation-cap",
        label: t("sa_dash_hoe"),
        value: stats.total_hoe,
      },
      { icon: "user-cog", label: t("sa_dash_tdc"), value: stats.total_tdc },
    ];
    const recentSchools =
      schools
        .slice(0, 6)
        .map(
          (s) => `
      <tr><td>${s.school_name}</td><td>${t("sa_level_" + s.school_level.toLowerCase())}</td><td>${s.zone_name || "—"}</td></tr>`,
        )
        .join("") ||
      `<tr><td colspan="3" class="hint">${t("sa_schools_empty")}</td></tr>`;
    const activityRows = activity.length
      ? activity
          .map(
            (a) => `
      <tr><td>${auditActionLabel(a.action)}</td><td>${a.actor_id}</td><td>${new Date(a.created_at).toLocaleString()}</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="3" class="hint">${t("sa_audit_empty")}</td></tr>`;

    document.getElementById("content").innerHTML = `
      <div class="cards">
        ${cards
          .map(
            (c) => `
          <div class="card">
            <div class="icon"><i data-lucide="${c.icon}"></i></div>
            <div><div class="label">${c.label}</div>
            <div class="value">${c.value}</div></div>
          </div>`,
          )
          .join("")}
      </div>
      <div class="panel">
        <h3><i data-lucide="activity"></i> ${t("sa_dash_system_status")}</h3>
        <div class="cards">
          <div class="card">
            <div class="icon"><i data-lucide="database"></i></div>
            <div><div class="label">${t("sa_status_db")}</div>
            <div class="value" style="font-size:16px;">${status.database.ok ? t("sa_status_ok") : t("sa_status_down")} (${status.database.latency_ms}ms)</div></div>
          </div>
          <div class="card">
            <div class="icon"><i data-lucide="clock"></i></div>
            <div><div class="label">${t("sa_status_uptime")}</div>
            <div class="value" style="font-size:16px;">${Math.floor(status.server.uptime_seconds / 3600)}h ${Math.floor((status.server.uptime_seconds % 3600) / 60)}m</div></div>
          </div>
          <div class="card">
            <div class="icon"><i data-lucide="plug-zap"></i></div>
            <div><div class="label">${t("sa_status_api")}</div>
            <div class="value" style="font-size:16px;">${status.api.ok ? t("sa_status_ok") : t("sa_status_down")}</div></div>
          </div>
        </div>
      </div>
      <div class="panel">
        <h3><i data-lucide="building-2"></i> ${t("sa_dash_recent_schools")}</h3>
        <div class="table-wrap"><table>
          <tr><th>${t("sa_th_school")}</th><th>${t("sa_th_level")}</th><th>${t("sa_th_zone")}</th></tr>
          ${recentSchools}
        </table></div>
      </div>
      <div class="panel">
        <h3><i data-lucide="scroll-text"></i> ${t("sa_dash_recent_activity")}</h3>
        <div class="table-wrap"><table>
          <tr><th>${t("sa_th_action")}</th><th>${t("sa_th_actor")}</th><th>${t("sa_th_when")}</th></tr>
          ${activityRows}
        </table></div>
      </div>`;
  } catch (err) {
    const panel = document.getElementById("dashDataPanel");
    if (panel) panel.outerHTML = errorPanel(err);
    else document.getElementById("content").innerHTML = errorPanel(err);
  }
}

/* ==================================================================
   Regions — the top of the hierarchy; add/edit/remove, live from
   /api/super/regions (write) and /api/super/lookup/regions (read).
   ================================================================== */
function regionsSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="map"></i> ${t("sa_nav_regions")}</h3><p class="hint">${t("za_loading")}</p></div>`;
}
async function loadAndRenderRegions() {
  try {
    const regions = await apiGet("/api/super/lookup/regions");
    renderRegionsPanel(regions);
  } catch (err) {
    document.getElementById("content").innerHTML = errorPanel(err);
  }
}
function renderRegionsPanel(regions) {
  const rows = regions.length
    ? regions
        .map(
          (r) => `
    <tr data-id="${r.region_id}">
      <td class="region-name">${r.region_name}</td>
      <td>
        <button class="btn ghost sm region-edit">${t("za_edit")}</button>
        <button class="btn ghost sm region-delete">${t("za_delete")}</button>
      </td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="2" class="hint">${t("sa_regions_empty")}</td></tr>`;

  document.getElementById("content").innerHTML = `
  <div class="panel">
    <h3><i data-lucide="map"></i> ${t("sa_nav_regions")}</h3>
    <div class="form-grid">
      <div class="form-field">
        <label for="region_new_name">${t("sa_f_region_name")}</label>
        <input type="text" id="region_new_name" placeholder="${t("sa_f_region_name")}">
      </div>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnAddRegion">${t("sa_add_region")}</button>
    </div>
    <p class="hint" id="regionFormMsg"></p>
    <div class="table-wrap"><table>
      <tr><th>${t("sa_th_region")}</th><th>${t("za_th_actions")}</th></tr>
      ${rows}
    </table></div>
  </div>`;

  const msg = document.getElementById("regionFormMsg");
  document.getElementById("btnAddRegion").onclick = async () => {
    const nameEl = document.getElementById("region_new_name");
    const region_name = nameEl.value.trim();
    if (!region_name) {
      setErrorMsg(msg, t("sa_region_required"));
      return;
    }
    if (!(await showPasswordConfirm(t("sa_pwconfirm_region")))) return;
    try {
      const result = await apiPost("/api/super/regions", { region_name });
      setSuccessMsg(msg, result.message);
      loadAndRenderRegions();
    } catch (err) {
      setErrorMsg(msg, err.message);
    }
  };

  document.querySelectorAll(".region-edit").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tr = btn.closest("tr");
      const id = tr.dataset.id;
      const current = tr.querySelector(".region-name").textContent;
      const next = prompt(t("sa_edit_region_prompt"), current);
      if (next === null || !next.trim() || next.trim() === current) return;
      if (!(await showPasswordConfirm(t("sa_pwconfirm_region")))) return;
      try {
        await apiPut(`/api/super/regions/${id}`, { region_name: next.trim() });
        loadAndRenderRegions();
      } catch (err) {
        setErrorMsg(msg, err.message);
      }
    });
  });
  document.querySelectorAll(".region-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tr = btn.closest("tr");
      const id = tr.dataset.id;
      if (!(await showConfirm(t("sa_confirm_delete_region")))) return;
      if (!(await showPasswordConfirm(t("sa_pwconfirm_region")))) return;
      try {
        await apiDelete(`/api/super/regions/${id}`);
        loadAndRenderRegions();
      } catch (err) {
        setErrorMsg(msg, err.message);
      }
    });
  });
}

/* ==================================================================
   Zonal Admins — create Head of Education / Teacher Development
   Coordinator accounts and assign them to a Region -> Zone, live from
   /api/super/zonal-admins and /api/super/lookup/{regions,zones}.
   ================================================================== */
function zonalAdminsSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="user-cog"></i> ${t("sa_nav_zonal_admins")}</h3><p class="hint">${t("za_loading")}</p></div>`;
}
async function loadAndRenderZonalAdmins() {
  try {
    const [admins, regions] = await Promise.all([
      apiGet("/api/super/zonal-admins"),
      apiGet("/api/super/lookup/regions"),
    ]);
    renderZonalAdminsPanel(admins, regions);
  } catch (err) {
    document.getElementById("content").innerHTML = errorPanel(err);
  }
}
function renderZonalAdminsPanel(admins, regions) {
  const rows = admins.length
    ? admins
        .map(
          (a) => `
    <tr data-id="${a.admin_id}">
      <td>${[a.first_name, a.middle_name, a.last_name].filter(Boolean).join(" ")}</td>
      <td>${a.admin_id}</td>
      <td>${t(a.title === "Head of Education" ? "za_role_hoe" : "za_role_tdc")}</td>
      <td>${a.zone_name || "—"}</td>
      <td>${a.region_name || "—"}</td>
      <td>
        <button class="btn ghost sm za-edit">${t("za_edit")}</button>
        <button class="btn ghost sm za-reset">${t("sa_reset_password")}</button>
      </td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="hint">${t("sa_zonal_admins_empty")}</td></tr>`;
  const regionOpts = regions
    .map((r) => `<option value="${r.region_id}">${r.region_name}</option>`)
    .join("");
  const adminsByAdminId = Object.fromEntries(
    admins.map((a) => [a.admin_id, a]),
  );

  document.getElementById("content").innerHTML = `
  <div class="panel">
    <h3><i data-lucide="image"></i> ${t("sa_zone_logo_title")}</h3>
    <p class="hint">${t("sa_zone_logo_hint")}</p>
    <div class="form-grid">
      <div class="form-field">
        <label for="zl_zone">${t("sa_zone_logo_pick_zone")}</label>
        <select id="zl_zone"><option value="">${t("sa_zone_logo_pick_zone")}</option></select>
      </div>
      <div class="form-field">
        <label for="zl_file">${t("sa_zone_logo_choose_file")}</label>
        <input type="file" id="zl_file" accept="image/*">
      </div>
    </div>
    <div id="zl_preview_wrap" style="display:none; margin: 8px 0;">
      <div class="hint">${t("sa_zone_logo_current")}</div>
      <img id="zl_preview" alt="Zone logo" style="height:56px; width:56px; object-fit:contain; border-radius:8px; background:#fff; border:1px solid var(--border, #ddd); padding:4px;">
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnUploadZoneLogo">${t("sa_zone_logo_upload_btn")}</button>
    </div>
    <p class="hint" id="zoneLogoFormMsg"></p>
  </div>
  <div class="panel">
    <h3><i data-lucide="user-plus"></i> ${t("sa_create_zonal_admin")}</h3>
    <div class="form-grid">
      <div class="form-field">
        <label for="za_title">${t("sa_f_title")}</label>
        <select id="za_title">
          <option value="Head of Education">${t("za_role_hoe")}</option>
          <option value="Teacher Development Coordinator">${t("za_role_tdc")}</option>
        </select>
      </div>
      <div class="form-field">
        <label for="za_region">${t("za_f_region")}</label>
        <select id="za_region"><option value="">${t("za_pick_region")}</option>${regionOpts}</select>
      </div>
      <div class="form-field">
        <label for="za_zone">${t("za_f_zone")}</label>
        <select id="za_zone" disabled><option value="">${t("za_pick_zone")}</option></select>
      </div>
      <div class="form-field">
        <label for="za_first">${t("sa_f_first_name")}</label>
        <input type="text" id="za_first" placeholder="${t("sa_f_first_name")}">
      </div>
      <div class="form-field">
        <label for="za_middle">${t("sa_f_middle_name")}</label>
        <input type="text" id="za_middle" placeholder="${t("sa_f_middle_name")}">
      </div>
      <div class="form-field">
        <label for="za_last">${t("sa_f_last_name")}</label>
        <input type="text" id="za_last" placeholder="${t("sa_f_last_name")}">
      </div>
      <div class="form-field">
        <label for="za_contact">${t("sa_f_contact")}</label>
        <input type="text" id="za_contact" placeholder="09xxxxxxxx">
      </div>
      <div class="form-field">
        <label for="za_email">${t("sa_f_email")}</label>
        <input type="email" id="za_email" placeholder="name@example.com">
      </div>
    </div>
    <div class="form-field" id="za_delegate_wrap" style="display:none;">
      <label class="checklist-row"><input type="checkbox" id="za_delegate"> ${t("sa_f_can_act_independently")}</label>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnCreateZonalAdmin">${t("sa_create_zonal_admin")}</button>
    </div>
    <p class="hint" id="zonalAdminFormMsg"></p>
  </div>
  <div class="panel">
    <h3><i data-lucide="user-cog"></i> ${t("sa_nav_zonal_admins")}</h3>
    <div class="table-wrap"><table>
      <tr><th>${t("sa_th_name")}</th><th>${t("sa_th_id")}</th><th>${t("sa_th_title")}</th><th>${t("sa_th_zone")}</th><th>${t("sa_th_region")}</th><th>${t("za_th_actions")}</th></tr>
      ${rows}
    </table></div>
  </div>`;

  // Zone Logo card — lists every zone (not scoped to a region), so the
  // dropdown is populated independently of the create-zonal-admin form's
  // region -> zone cascade below. /api/super/lookup/zones with no
  // region_id returns all zones, including each one's logo_url now, so
  // the preview can show what's already set without a second request.
  let allZonesCache = [];
  const zlZoneEl = document.getElementById("zl_zone");
  const zlFileEl = document.getElementById("zl_file");
  const zlPreviewWrap = document.getElementById("zl_preview_wrap");
  const zlPreview = document.getElementById("zl_preview");
  const zlMsg = document.getElementById("zoneLogoFormMsg");
  (async () => {
    try {
      allZonesCache = await apiGet("/api/super/lookup/zones");
      fillSelect(zlZoneEl, allZonesCache, "zone_id", "zone_name", t("sa_zone_logo_pick_zone"));
    } catch (err) {
      setErrorMsg(zlMsg, err.message);
    }
  })();
  zlZoneEl.addEventListener("change", () => {
    const zone = allZonesCache.find(
      (z) => String(z.zone_id) === zlZoneEl.value,
    );
    if (zone && zone.logo_url) {
      zlPreview.src = zone.logo_url;
      zlPreviewWrap.style.display = "block";
    } else {
      zlPreviewWrap.style.display = "none";
    }
  });
  document.getElementById("btnUploadZoneLogo").onclick = async () => {
    const zoneId = zlZoneEl.value;
    const file = zlFileEl.files[0];
    if (!zoneId || !file) {
      setErrorMsg(zlMsg, t("sa_zone_logo_required"));
      return;
    }
    if (!(await showPasswordConfirm(t("sa_pwconfirm_zone_logo")))) return;
    try {
      const formData = new FormData();
      formData.append("logo", file);
      const result = await apiUpload(
        `/api/super/zones/${zoneId}/logo`,
        formData,
      );
      setSuccessMsg(zlMsg, t("sa_zone_logo_success"));
      zlPreview.src = result.logo_url;
      zlPreviewWrap.style.display = "block";
      zlFileEl.value = "";
      const cached = allZonesCache.find(
        (z) => String(z.zone_id) === zoneId,
      );
      if (cached) cached.logo_url = result.logo_url;
    } catch (err) {
      setErrorMsg(zlMsg, err.message);
    }
  };

  const regionEl = document.getElementById("za_region");
  const zoneEl = document.getElementById("za_zone");
  const titleEl = document.getElementById("za_title");
  const delegateWrap = document.getElementById("za_delegate_wrap");
  const updateDelegateVisibility = () => {
    delegateWrap.style.display =
      titleEl.value === "Teacher Development Coordinator" ? "block" : "none";
  };
  titleEl.addEventListener("change", updateDelegateVisibility);
  updateDelegateVisibility();

  regionEl.addEventListener("change", async () => {
    fillSelect(zoneEl, [], "zone_id", "zone_name", t("za_pick_zone"));
    zoneEl.disabled = true;
    if (!regionEl.value) return;
    try {
      const zones = await apiGet("/api/super/lookup/zones", {
        region_id: regionEl.value,
      });
      fillSelect(zoneEl, zones, "zone_id", "zone_name", t("za_pick_zone"));
      zoneEl.disabled = zones.length === 0;
    } catch (err) {
      setErrorMsg(document.getElementById("zonalAdminFormMsg"), err.message);
    }
  });

  document.getElementById("btnCreateZonalAdmin").onclick = async () => {
    const msg = document.getElementById("zonalAdminFormMsg");
    const body = {
      title: titleEl.value,
      zone_id: zoneEl.value || null,
      first_name: document.getElementById("za_first").value.trim(),
      middle_name: document.getElementById("za_middle").value.trim() || null,
      last_name: document.getElementById("za_last").value.trim(),
      contact_number:
        document.getElementById("za_contact").value.trim() || null,
      email: document.getElementById("za_email").value.trim() || null,
      can_act_independently:
        titleEl.value === "Teacher Development Coordinator" &&
        document.getElementById("za_delegate").checked,
    };
    if (!body.zone_id || !body.first_name || !body.last_name) {
      setErrorMsg(msg, t("sa_zonal_admin_required"));
      return;
    }
    if (!(await showPasswordConfirm(t("sa_pwconfirm_zonal_admin")))) return;
    try {
      const result = await apiPost("/api/super/zonal-admins", body);
      setSuccessMsg(msg, result.message);
      showCredentialsModal(result.admin_id, result.default_password);
      loadAndRenderZonalAdmins();
    } catch (err) {
      setErrorMsg(msg, err.message);
    }
  };

  document.querySelectorAll(".za-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const adminId = btn.closest("tr").dataset.id;
      openZonalAdminEditModal(adminsByAdminId[adminId]);
    });
  });
  document.querySelectorAll(".za-reset").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const adminId = btn.closest("tr").dataset.id;
      if (!(await showConfirm(t("sa_confirm_reset_password")))) return;
      if (!(await showPasswordConfirm(t("sa_pwconfirm_reset")))) return;
      try {
        const result = await apiPost(
          `/api/super/zonal-admins/${adminId}/reset-password`,
          {},
        );
        showCredentialsModal(adminId, result.default_password);
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

// A small edit modal for one zonal admin — name/contact/email plus the
// TDC-only delegation toggle. Zone and title aren't editable here (see
// the PUT route's comment: both are baked into admin_id).
function openZonalAdminEditModal(admin) {
  const backdrop = document.createElement("div");
  backdrop.className = "confirm-modal-backdrop";
  const isTdc = admin.title === "Teacher Development Coordinator";
  backdrop.innerHTML = `
    <div class="confirm-modal" role="dialog" aria-modal="true">
      <div class="confirm-modal-icon"><i data-lucide="user-cog"></i></div>
      <h3 class="confirm-modal-title">${t("sa_edit_zonal_admin")}</h3>
      <div class="form-grid">
        <div class="form-field"><label for="zaEditFirst">${t("sa_f_first_name")}</label><input type="text" id="zaEditFirst" value="${admin.first_name}"></div>
        <div class="form-field"><label for="zaEditMiddle">${t("sa_f_middle_name")}</label><input type="text" id="zaEditMiddle" value="${admin.middle_name || ""}"></div>
        <div class="form-field"><label for="zaEditLast">${t("sa_f_last_name")}</label><input type="text" id="zaEditLast" value="${admin.last_name}"></div>
        <div class="form-field"><label for="zaEditContact">${t("sa_f_contact")}</label><input type="text" id="zaEditContact" value="${admin.contact_number || ""}"></div>
        <div class="form-field"><label for="zaEditEmail">${t("sa_f_email")}</label><input type="email" id="zaEditEmail" value="${admin.email || ""}"></div>
      </div>
      ${isTdc ? `<div class="form-field"><label class="checklist-row"><input type="checkbox" id="zaEditDelegate" ${admin.can_act_independently ? "checked" : ""}> ${t("sa_f_can_act_independently")}</label></div>` : ""}
      <p class="confirm-modal-error" id="zaEditError" role="alert" style="display:none"></p>
      <div class="confirm-modal-actions">
        <button class="btn ghost" id="zaEditCancel">${t("za_cancel")}</button>
        <button class="btn primary" id="zaEditSave">${t("za_save")}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  if (window.lucide) lucide.createIcons();
  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("#zaEditCancel").addEventListener("click", close);
  backdrop.querySelector("#zaEditSave").addEventListener("click", async () => {
    const errEl = backdrop.querySelector("#zaEditError");
    const body = {
      first_name: backdrop.querySelector("#zaEditFirst").value.trim(),
      middle_name: backdrop.querySelector("#zaEditMiddle").value.trim() || null,
      last_name: backdrop.querySelector("#zaEditLast").value.trim(),
      contact_number:
        backdrop.querySelector("#zaEditContact").value.trim() || null,
      email: backdrop.querySelector("#zaEditEmail").value.trim() || null,
      can_act_independently: isTdc
        ? backdrop.querySelector("#zaEditDelegate").checked
        : admin.can_act_independently,
    };
    if (!body.first_name || !body.last_name) {
      errEl.textContent = t("sa_zonal_admin_required");
      errEl.style.display = "block";
      return;
    }
    close();
    if (!(await showPasswordConfirm(t("sa_pwconfirm_zonal_admin_edit"))))
      return;
    try {
      await apiPut(`/api/super/zonal-admins/${admin.admin_id}`, body);
      loadAndRenderZonalAdmins();
    } catch (err) {
      alert(err.message);
    }
  });
}

/* ==================================================================
   Schools — setup (name, EDUCATIONAL LEVEL, region/zone/woreda/kebele,
   streams) and a list of every school across every zone. A school
   picks its Educational Level ONCE at registration; the Grade-Tier(s)
   it carries (BASIC/CORE/GENERAL/PREPARATORY) are DERIVED from that —
   Secondary always carries both General and Preparatory together, see
   EDUCATIONAL_LEVEL_TIERS above. Prefix preview mirrors
   buildSchoolPrefixBase() in server.js (keyed off the primary/lower
   tier), same pattern the old Zonal Admin setup form used.
   ================================================================== */
function schoolsSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="building-2"></i> ${t("sa_nav_schools")}</h3><p class="hint">${t("za_loading")}</p></div>`;
}
const SCHOOL_LEVEL_CODE = {
  BASIC: "BS",
  CORE: "CR",
  GENERAL: "GN",
  PREPARATORY: "PR",
};
// educationalLevels is now an array (Multi-Tier School Registration) —
// the preview uses the LOWEST tier across every checked level, same
// "lowest of what it offers" rule the server applies when it derives
// schools.school_level/school_prefix (see POST /api/super/schools).
function computeSchoolPrefixPreview(name, educationalLevels) {
  const initials = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join("");
  const tiers = new Set(
    (educationalLevels || []).flatMap((l) => EDUCATIONAL_LEVEL_TIERS[l] || []),
  );
  const primaryTier = SCHOOL_LEVELS.find((t) => tiers.has(t));
  if (!initials || !primaryTier) return "";
  return initials + (SCHOOL_LEVEL_CODE[primaryTier] || "");
}
function eduLevelBadges(levels) {
  return (
    (levels && levels.length ? levels : [])
      .map(
        (l) =>
          `<span class="badge">${t("sa_edulevel_" + l.toLowerCase())}</span>`,
      )
      .join(" ") || "—"
  );
}
function tierBadges(tiers) {
  return (
    (tiers && tiers.length ? tiers : [])
      .map(
        (l) =>
          `<span class="badge">${t("sa_level_" + l.toLowerCase())} (${SCHOOL_LEVEL_GRADES[l] || ""})</span>`,
      )
      .join(" ") || "—"
  );
}
async function loadAndRenderSchools() {
  try {
    const [schools, regions] = await Promise.all([
      apiGet("/api/super/schools"),
      apiGet("/api/super/lookup/regions"),
    ]);
    renderSchoolsPanel(schools, regions);
  } catch (err) {
    document.getElementById("content").innerHTML = errorPanel(err);
  }
}
function renderSchoolsPanel(schools, regions) {
  // Keyed by id so the Edit button's click handler can look up the full
  // row (educational_levels etc.) without re-parsing table cells — same
  // adminsByAdminId pattern the Zonal Admin edit button uses above.
  const schoolsById = {};
  schools.forEach((s) => {
    schoolsById[s.id] = s;
  });
  const rows = schools.length
    ? schools
        .map(
          (s) => `
    <tr data-id="${s.id}">
      <td>${s.school_name}</td>
      <td>${eduLevelBadges(s.educational_levels)}</td>
      <td>${tierBadges(s.grade_tiers)}</td>
      <td>${s.school_prefix || "—"}</td>
      <td>${s.zone_name || "—"}</td>
      <td>${s.region_name || "—"}</td>
      <td>
        <button class="btn ghost sm school-edit"><i data-lucide="pencil"></i> ${t("za_edit")}</button>
        <button class="btn danger sm school-delete"><i data-lucide="trash-2"></i> ${t("za_delete")}</button>
      </td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="7" class="hint">${t("sa_schools_empty")}</td></tr>`;
  const regionOpts = regions
    .map((r) => `<option value="${r.region_id}">${r.region_name}</option>`)
    .join("");
  // Multi-Tier School Registration: checkboxes instead of a single
  // dropdown, so one campus can host more than one Educational Level at
  // once (e.g. Primary + Middle School under one umbrella).
  const eduLevelChecks = EDUCATIONAL_LEVELS.map(
    (l) => `
    <label class="checklist-row"><input type="checkbox" class="school-edulevel-check" value="${l}"> ${t("sa_edulevel_" + l.toLowerCase())} (${EDUCATIONAL_LEVEL_TIERS[l].map((t2) => SCHOOL_LEVEL_GRADES[t2]).join(", ")})</label>`,
  ).join("");
  const streamChecks = SCHOOL_STREAMS.map(
    (s) => `
    <label class="checklist-row"><input type="checkbox" class="school-stream-check" value="${s}"> ${s}</label>`,
  ).join("");

  document.getElementById("content").innerHTML = `
  <div class="panel">
    <h3><i data-lucide="plus-circle"></i> ${t("sa_setup_school")}</h3>
    <div class="form-grid">
      <div class="form-field">
        <label for="sc_name">${t("za_f_school_name")}</label>
        <input type="text" id="sc_name" placeholder="e.g. Newland">
      </div>
      <div class="form-field" id="sc_level_wrap">
        <label>${t("sa_f_educational_level")}</label>
        <div class="checklist">${eduLevelChecks}</div>
        <p class="hint">${t("sa_educational_level_hint")}</p>
      </div>
      <div class="form-field">
        <label for="sc_prefix_preview">${t("za_f_school_prefix")}</label>
        <input type="text" id="sc_prefix_preview" placeholder="—" readonly disabled>
      </div>
      <div class="form-field">
        <label for="sc_moe">${t("za_f_moe_code")}</label>
        <input type="text" id="sc_moe" placeholder="e.g. 1203010102">
      </div>
      <div class="form-field">
        <label for="sc_region">${t("za_f_region")}</label>
        <select id="sc_region"><option value="">${t("za_pick_region")}</option>${regionOpts}</select>
      </div>
      <div class="form-field">
        <label for="sc_zone">${t("za_f_zone")}</label>
        <select id="sc_zone" disabled><option value="">${t("za_pick_zone")}</option></select>
      </div>
      <div class="form-field">
        <label for="sc_woreda">${t("za_f_woreda")}</label>
        <select id="sc_woreda" disabled><option value="">${t("za_pick_woreda")}</option></select>
      </div>
      <div class="form-field">
        <label for="sc_kebele">${t("za_f_kebele")}</label>
        <select id="sc_kebele" disabled><option value="">${t("za_pick_kebele")}</option></select>
      </div>
    </div>
    <div class="form-field" id="sc_streams_wrap" style="display:none;">
      <label>${t("sa_f_streams")}</label>
      <div class="checklist">${streamChecks}</div>
      <p class="hint">${t("sa_streams_hint")}</p>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnSaveSchool">${t("za_save_school")}</button>
    </div>
    <p class="hint" id="schoolFormMsg"></p>
  </div>
  <div class="panel">
    <h3><i data-lucide="building-2"></i> ${t("sa_all_schools")}</h3>
    <div class="table-wrap"><table>
      <tr><th>${t("sa_th_school")}</th><th>${t("sa_th_educational_level")}</th><th>${t("sa_th_grade_tiers")}</th><th>${t("za_th_prefix")}</th><th>${t("sa_th_zone")}</th><th>${t("za_th_region")}</th><th>${t("za_th_actions")}</th></tr>
      ${rows}
    </table></div>
  </div>`;

  const nameEl = document.getElementById("sc_name");
  const levelChecks = Array.from(
    document.querySelectorAll(".school-edulevel-check"),
  );
  const previewEl = document.getElementById("sc_prefix_preview");
  const streamsWrap = document.getElementById("sc_streams_wrap");
  const getCheckedLevels = () =>
    levelChecks.filter((c) => c.checked).map((c) => c.value);
  const updatePreview = () => {
    const checkedLevels = getCheckedLevels();
    previewEl.value = computeSchoolPrefixPreview(nameEl.value, checkedLevels);
    // Streams only apply once a Secondary school's Preparatory tier is
    // in play — see EDUCATIONAL_LEVEL_TIERS (Primary/Middle never
    // include PREPARATORY) — so this stays keyed off SECONDARY even
    // when it's checked alongside other levels.
    streamsWrap.style.display = checkedLevels.includes("SECONDARY")
      ? "block"
      : "none";
  };
  nameEl.addEventListener("input", updatePreview);
  levelChecks.forEach((c) => c.addEventListener("change", updatePreview));

  const regionEl = document.getElementById("sc_region");
  const zoneEl = document.getElementById("sc_zone");
  const woredaEl = document.getElementById("sc_woreda");
  const kebeleEl = document.getElementById("sc_kebele");
  const formMsg = document.getElementById("schoolFormMsg");

  regionEl.addEventListener("change", async () => {
    fillSelect(zoneEl, [], "zone_id", "zone_name", t("za_pick_zone"));
    zoneEl.disabled = true;
    fillSelect(woredaEl, [], "woreda_id", "woreda_name", t("za_pick_woreda"));
    woredaEl.disabled = true;
    fillSelect(kebeleEl, [], "kebele_id", "kebele_name", t("za_pick_kebele"));
    kebeleEl.disabled = true;
    if (!regionEl.value) return;
    try {
      const zones = await apiGet("/api/super/lookup/zones", {
        region_id: regionEl.value,
      });
      fillSelect(zoneEl, zones, "zone_id", "zone_name", t("za_pick_zone"));
      zoneEl.disabled = zones.length === 0;
    } catch (err) {
      setErrorMsg(formMsg, err.message);
    }
  });
  zoneEl.addEventListener("change", async () => {
    fillSelect(woredaEl, [], "woreda_id", "woreda_name", t("za_pick_woreda"));
    woredaEl.disabled = true;
    fillSelect(kebeleEl, [], "kebele_id", "kebele_name", t("za_pick_kebele"));
    kebeleEl.disabled = true;
    if (!zoneEl.value) return;
    try {
      const woredas = await apiGet("/api/super/lookup/woredas", {
        zone_id: zoneEl.value,
      });
      fillSelect(
        woredaEl,
        woredas,
        "woreda_id",
        "woreda_name",
        t("za_pick_woreda"),
      );
      woredaEl.disabled = woredas.length === 0;
    } catch (err) {
      setErrorMsg(formMsg, err.message);
    }
  });
  woredaEl.addEventListener("change", async () => {
    fillSelect(kebeleEl, [], "kebele_id", "kebele_name", t("za_pick_kebele"));
    kebeleEl.disabled = true;
    if (!woredaEl.value) return;
    try {
      const kebeles = await apiGet("/api/super/lookup/kebeles", {
        woreda_id: woredaEl.value,
      });
      fillSelect(
        kebeleEl,
        kebeles,
        "kebele_id",
        "kebele_name",
        t("za_pick_kebele"),
      );
      kebeleEl.disabled = kebeles.length === 0;
    } catch (err) {
      setErrorMsg(formMsg, err.message);
    }
  });

  document.getElementById("btnSaveSchool").onclick = async () => {
    const checkedLevels = getCheckedLevels();
    const body = {
      school_name: nameEl.value.trim(),
      educational_levels: checkedLevels,
      moe_school_code: document.getElementById("sc_moe").value.trim() || null,
      region_id: regionEl.value || null,
      zone_id: zoneEl.value || null,
      woreda_id: woredaEl.value || null,
      kebele_id: kebeleEl.value || null,
      streams: checkedLevels.includes("SECONDARY")
        ? Array.from(
            document.querySelectorAll(".school-stream-check:checked"),
          ).map((c) => c.value)
        : undefined,
    };
    if (
      !body.school_name ||
      body.educational_levels.length === 0 ||
      !body.zone_id
    ) {
      setErrorMsg(formMsg, t("za_setup_required"));
      return;
    }
    if (!(await showPasswordConfirm(t("za_pwconfirm_setup_school")))) return;
    try {
      const result = await apiPost("/api/super/schools", body);
      setSuccessMsg(formMsg, result.message);
      loadAndRenderSchools();
    } catch (err) {
      setErrorMsg(formMsg, err.message);
    }
  };

  document.querySelectorAll(".school-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const schoolId = btn.closest("tr").dataset.id;
      openSchoolEditModal(schoolsById[schoolId]);
    });
  });
  document.querySelectorAll(".school-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      const schoolId = btn.closest("tr").dataset.id;
      openSchoolDeleteModal(schoolsById[schoolId]);
    });
  });
}

// Delete button on the Schools screen — three distinct outcomes, since
// "delete a school" is ambiguous once students/staff/enrollment are
// attached to it. Archive and delete-and-unassign are safe/reversible-
// ish; "Delete completely" is the one irreversible option and gets a
// second, harsher confirmation of its own on top of the usual
// password-confirm every write on this screen already requires.
function openSchoolDeleteModal(school) {
  const backdrop = document.createElement("div");
  backdrop.className = "confirm-modal-backdrop";
  backdrop.innerHTML = `
    <div class="confirm-modal" role="alertdialog" aria-modal="true">
      <div class="confirm-modal-icon"><i data-lucide="trash-2"></i></div>
      <h3 class="confirm-modal-title">${t("sa_delete_school_title")} — ${school.school_name}</h3>
      <p class="confirm-modal-msg">${t("sa_delete_school_hint")}</p>
      <div class="checklist" style="text-align:left;">
        <label class="checklist-row">
          <input type="radio" name="schoolDeleteMode" value="archive" checked>
          <b>${t("sa_delete_mode_archive")}</b> — ${t("sa_delete_mode_archive_hint")}
        </label>
        <label class="checklist-row">
          <input type="radio" name="schoolDeleteMode" value="unassign">
          <b>${t("sa_delete_mode_unassign")}</b> — ${t("sa_delete_mode_unassign_hint")}
        </label>
        <label class="checklist-row">
          <input type="radio" name="schoolDeleteMode" value="wipe">
          <b>${t("sa_delete_mode_wipe")}</b> — ${t("sa_delete_mode_wipe_hint")}
        </label>
      </div>
      <p class="confirm-modal-error" id="schoolDeleteError" role="alert" style="display:none"></p>
      <div class="confirm-modal-actions">
        <button class="btn ghost" id="schoolDeleteCancel">${t("za_cancel")}</button>
        <button class="btn danger" id="schoolDeleteOk">${t("za_confirm_yes")}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  if (window.lucide) lucide.createIcons();
  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("#schoolDeleteCancel").addEventListener("click", close);
  backdrop.querySelector("#schoolDeleteOk").addEventListener("click", async () => {
    const mode = backdrop.querySelector(
      'input[name="schoolDeleteMode"]:checked',
    ).value;
    close();
    if (mode === "wipe") {
      // Extra, harsher confirmation — this is the one irreversible path.
      if (
        !(await showConfirm(
          t("sa_confirm_wipe_school", { school: school.school_name }),
          { confirmText: t("sa_delete_mode_wipe") },
        ))
      )
        return;
    }
    if (!(await showPasswordConfirm(t("sa_pwconfirm_delete_school")))) return;
    const formMsg = document.getElementById("schoolFormMsg");
    try {
      let result;
      if (mode === "archive") {
        result = await apiSend("PATCH", `/api/super/schools/${school.id}/archive`);
      } else {
        result = await apiDelete(
          `/api/super/schools/${school.id}?mode=${mode}`,
        );
      }
      setSuccessMsg(formMsg, result.message);
      loadAndRenderSchools();
    } catch (err) {
      alert(err.message);
    }
  });
}

// Lets Super Admin add an Educational Level a school didn't originally
// register with (e.g. a Primary school later opens a Middle School
// wing). Deliberately add-only: existing levels are shown checked and
// DISABLED, not removable here — see the PUT route's comment for why
// (students may already be placed in a tier; removing one isn't a
// simple field edit). Reuses the same checkbox catalog/streams-reveal
// logic as the New School form above (EDUCATIONAL_LEVELS,
// EDUCATIONAL_LEVEL_TIERS, SCHOOL_LEVEL_GRADES, SCHOOL_STREAMS).
function openSchoolEditModal(school) {
  const existingLevels = new Set(school.educational_levels || []);
  const backdrop = document.createElement("div");
  backdrop.className = "confirm-modal-backdrop";
  const levelChecksHtml = EDUCATIONAL_LEVELS.map((l) => {
    const already = existingLevels.has(l);
    return `<label class="checklist-row">
      <input type="checkbox" class="school-edit-level-check" value="${l}" ${already ? "checked disabled" : ""}>
      ${t("sa_edulevel_" + l.toLowerCase())} (${EDUCATIONAL_LEVEL_TIERS[l].map((t2) => SCHOOL_LEVEL_GRADES[t2]).join(", ")})
      ${already ? `<span class="badge">${t("sa_already_offered")}</span>` : ""}
    </label>`;
  }).join("");
  const streamChecks = SCHOOL_STREAMS.map(
    (s) => `
    <label class="checklist-row"><input type="checkbox" class="school-edit-stream-check" value="${s}"> ${s}</label>`,
  ).join("");
  backdrop.innerHTML = `
    <div class="confirm-modal" role="dialog" aria-modal="true">
      <div class="confirm-modal-icon"><i data-lucide="building-2"></i></div>
      <h3 class="confirm-modal-title">${t("sa_edit_school")} — ${school.school_name}</h3>
      <div class="form-field">
        <label for="schoolEditName">${t("za_f_school_name")}</label>
        <input type="text" id="schoolEditName" value="${school.school_name.replace(/"/g, "&quot;")}">
      </div>
      <div class="form-field">
        <label>${t("sa_f_educational_level")}</label>
        <div class="checklist">${levelChecksHtml}</div>
        <p class="hint">${t("sa_edit_school_hint")}</p>
      </div>
      <div class="form-field" id="schoolEditStreamsWrap" style="display:none;">
        <label>${t("sa_f_streams")}</label>
        <div class="checklist">${streamChecks}</div>
        <p class="hint">${t("sa_streams_hint")}</p>
      </div>
      <p class="confirm-modal-error" id="schoolEditError" role="alert" style="display:none"></p>
      <div class="confirm-modal-actions">
        <button class="btn ghost" id="schoolEditCancel">${t("za_cancel")}</button>
        <button class="btn primary" id="schoolEditSave">${t("za_save")}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  if (window.lucide) lucide.createIcons();

  const streamsWrap = backdrop.querySelector("#schoolEditStreamsWrap");
  const levelChecks = Array.from(
    backdrop.querySelectorAll(".school-edit-level-check"),
  );
  const updateStreamsVisibility = () => {
    const checkedNew = levelChecks
      .filter((c) => !c.disabled && c.checked)
      .map((c) => c.value);
    streamsWrap.style.display = checkedNew.includes("SECONDARY")
      ? "block"
      : "none";
  };
  levelChecks.forEach((c) =>
    c.addEventListener("change", updateStreamsVisibility),
  );

  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("#schoolEditCancel").addEventListener("click", close);
  backdrop
    .querySelector("#schoolEditSave")
    .addEventListener("click", async () => {
      const errEl = backdrop.querySelector("#schoolEditError");
      const addLevels = levelChecks
        .filter((c) => !c.disabled && c.checked)
        .map((c) => c.value);
      const newName = backdrop
        .querySelector("#schoolEditName")
        .value.trim();
      const isRename = newName !== "" && newName !== school.school_name;
      if (newName === "") {
        errEl.textContent = t("sa_edit_school_name_required");
        errEl.style.display = "block";
        return;
      }
      if (addLevels.length === 0 && !isRename) {
        errEl.textContent = t("sa_edit_school_pick_new_level");
        errEl.style.display = "block";
        return;
      }
      const body = {
        add_educational_levels:
          addLevels.length > 0 ? addLevels : undefined,
        streams: addLevels.includes("SECONDARY")
          ? Array.from(
              backdrop.querySelectorAll(".school-edit-stream-check:checked"),
            ).map((c) => c.value)
          : undefined,
        school_name: isRename ? newName : undefined,
      };
      close();
      if (!(await showPasswordConfirm(t("sa_pwconfirm_edit_school")))) return;
      try {
        const result = await apiPut(`/api/super/schools/${school.id}`, body);
        loadAndRenderSchools();
        setSuccessMsg(document.getElementById("schoolFormMsg"), result.message);
      } catch (err) {
        alert(err.message);
      }
    });
}

/* ==================================================================
   Archived Schools — where a school lands after "Archive" from the
   Schools screen's Delete button. From here Super Admin can Restore it
   (back to the active list, untouched), Wipe it (permanently delete
   the school and every dependent record), or Transfer its records to
   another active school first, then remove it. Live from
   /api/super/schools/archived; Wipe/Transfer reuse the same
   DELETE/POST routes the Schools screen's Delete modal uses.
   ================================================================== */
function archivedSchoolsSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="archive"></i> ${t("sa_nav_schools_archive")}</h3><p class="hint">${t("za_loading")}</p></div>`;
}
async function loadAndRenderArchivedSchools() {
  try {
    const [archived, activeSchools] = await Promise.all([
      apiGet("/api/super/schools/archived"),
      apiGet("/api/super/schools"),
    ]);
    renderArchivedSchoolsPanel(archived, activeSchools);
  } catch (err) {
    document.getElementById("content").innerHTML = errorPanel(err);
  }
}
function renderArchivedSchoolsPanel(archived, activeSchools) {
  const archivedById = {};
  archived.forEach((s) => {
    archivedById[s.id] = s;
  });
  const transferOpts = activeSchools
    .map((s) => `<option value="${s.id}">${s.school_name}</option>`)
    .join("");
  const rows = archived.length
    ? archived
        .map(
          (s) => `
    <tr data-id="${s.id}">
      <td>${s.school_name}</td>
      <td>${s.school_prefix || "—"}</td>
      <td>${s.zone_name || "—"}</td>
      <td>${s.region_name || "—"}</td>
      <td>${s.archived_at ? new Date(s.archived_at).toLocaleDateString() : "—"}</td>
      <td>
        <button class="btn ghost sm archived-restore"><i data-lucide="rotate-ccw"></i> ${t("sa_restore")}</button>
        <select class="archived-transfer-target">
          <option value="">${t("sa_transfer_pick_school")}</option>
          ${transferOpts}
        </select>
        <button class="btn ghost sm archived-transfer">${t("sa_transfer")}</button>
        <button class="btn danger sm archived-wipe"><i data-lucide="trash-2"></i> ${t("sa_delete_mode_wipe")}</button>
      </td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="hint">${t("sa_archived_schools_empty")}</td></tr>`;

  document.getElementById("content").innerHTML = `
  <div class="panel">
    <h3><i data-lucide="archive"></i> ${t("sa_nav_schools_archive")}</h3>
    <p class="hint">${t("sa_archived_schools_hint")}</p>
    <div class="table-wrap"><table>
      <tr><th>${t("sa_th_school")}</th><th>${t("za_th_prefix")}</th><th>${t("sa_th_zone")}</th><th>${t("za_th_region")}</th><th>${t("sa_th_archived_at")}</th><th>${t("za_th_actions")}</th></tr>
      ${rows}
    </table></div>
    <p class="hint" id="archivedFormMsg"></p>
  </div>`;

  const msg = document.getElementById("archivedFormMsg");

  document.querySelectorAll(".archived-restore").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const schoolId = btn.closest("tr").dataset.id;
      if (!(await showPasswordConfirm(t("sa_pwconfirm_restore_school")))) return;
      try {
        const result = await apiPost(`/api/super/schools/${schoolId}/restore`, {});
        setSuccessMsg(msg, result.message);
        loadAndRenderArchivedSchools();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll(".archived-wipe").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const schoolId = btn.closest("tr").dataset.id;
      const school = archivedById[schoolId];
      if (
        !(await showConfirm(
          t("sa_confirm_wipe_school", { school: school.school_name }),
          { confirmText: t("sa_delete_mode_wipe") },
        ))
      )
        return;
      if (!(await showPasswordConfirm(t("sa_pwconfirm_delete_school")))) return;
      try {
        const result = await apiDelete(
          `/api/super/schools/${schoolId}?mode=wipe`,
        );
        setSuccessMsg(msg, result.message);
        loadAndRenderArchivedSchools();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll(".archived-transfer").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tr = btn.closest("tr");
      const schoolId = tr.dataset.id;
      const school = archivedById[schoolId];
      const targetSelect = tr.querySelector(".archived-transfer-target");
      const targetId = targetSelect.value;
      if (!targetId) {
        setErrorMsg(msg, t("sa_transfer_pick_school"));
        return;
      }
      const targetName = targetSelect.options[targetSelect.selectedIndex].text;
      if (
        !(await showConfirm(
          t("sa_confirm_transfer_school", {
            school: school.school_name,
            target: targetName,
          }),
        ))
      )
        return;
      if (!(await showPasswordConfirm(t("sa_pwconfirm_transfer_school")))) return;
      try {
        const result = await apiPost(`/api/super/schools/${schoolId}/transfer`, {
          target_school_id: targetId,
        });
        setSuccessMsg(msg, result.message);
        loadAndRenderArchivedSchools();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

/* ==================================================================
   Subject Dictionary — Subject Setup Matrix. One row per distinct
   subject name, one column per Grade-Tier that doesn't carry a stream
   (BASIC/CORE/GENERAL) plus one column per live PREPARATORY stream
   (from the same Stream Setup catalog school registration's stream
   checkboxes use — see loadStreamCatalog()), so e.g. English can be
   ticked across every level/stream at once instead of being re-entered
   per level. Live from /api/super/subject-dictionary/matrix. No
   approval step — every write is gated by showPasswordConfirm only.
   ================================================================== */
function subjectsSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="book-open"></i> ${t("sa_nav_subjects")}</h3><p class="hint">${t("za_loading")}</p></div>`;
}
async function loadAndRenderSubjects() {
  try {
    const data = await apiGet("/api/super/subject-dictionary/matrix");
    renderSubjectsPanel(data.subjects, data.streams);
  } catch (err) {
    document.getElementById("content").innerHTML = errorPanel(err);
  }
}
// Every non-stream column, in fixed BASIC/CORE/GENERAL order, plus one
// column per currently-live stream (streams is whatever Stream Setup
// currently has — see refreshStreamCache() server-side).
function subjectMatrixColumns(streams) {
  const cols = SCHOOL_LEVELS.filter((l) => l !== "PREPARATORY").map((l) => ({
    key: l,
    label: `${t("sa_level_" + l.toLowerCase())} (${SCHOOL_LEVEL_GRADES[l]})`,
  }));
  streams.forEach((s) => cols.push({ key: `PREPARATORY:${s}`, label: s }));
  return cols;
}
function renderSubjectsPanel(subjects, streams) {
  const columns = subjectMatrixColumns(streams);
  const headerCells = columns.map((c) => `<th>${c.label}</th>`).join("");
  const bodyRows = subjects.length
    ? subjects
        .map((s, i) =>
          subjectMatrixRow(`subj-${i}`, s.subject_name, s.cells, columns),
        )
        .join("")
    : `<tr><td colspan="${columns.length + 2}" class="hint">${t("sa_subjects_empty")}</td></tr>`;
  const newRow = subjectMatrixRow("subj-new", "", {}, columns, true);

  document.getElementById("content").innerHTML = `
  <div class="panel">
    <h3><i data-lucide="book-open"></i> ${t("sa_nav_subjects")}</h3>
    <p class="hint" id="subjectFormMsg"></p>
    <div class="table-wrap"><table>
      <tr><th>${t("sa_th_subject")}</th>${headerCells}<th>${t("za_th_actions")}</th></tr>
      ${bodyRows}
      ${newRow}
    </table></div>
  </div>`;

  const msg = document.getElementById("subjectFormMsg");

  const bindRow = (rowId, originalName, isNew) => {
    const tr = document.getElementById(rowId);
    const nameEl = tr.querySelector(".subj-matrix-name");
    const saveBtn = tr.querySelector(".subj-matrix-save");
    const deleteBtn = tr.querySelector(".subj-matrix-delete");
    saveBtn.addEventListener("click", async () => {
      const subject_name = nameEl.value.trim();
      if (!subject_name) {
        setErrorMsg(msg, t("sa_subject_required"));
        return;
      }
      const cols = {};
      columns.forEach((c) => {
        cols[c.key] = tr.querySelector(
          `.subj-matrix-check[data-col="${c.key}"]`,
        ).checked;
      });
      if (!Object.values(cols).some(Boolean)) {
        setErrorMsg(msg, t("sa_subject_required"));
        return;
      }
      if (!(await showPasswordConfirm(t("sa_pwconfirm_subject")))) return;
      try {
        const result = await apiPut("/api/super/subject-dictionary/matrix", {
          subject_name,
          original_subject_name: isNew ? null : originalName,
          columns: cols,
        });
        setSuccessMsg(msg, result.message);
        await loadAndRenderSubjects();
      } catch (err) {
        setErrorMsg(msg, err.message);
      }
    });
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async () => {
        if (!(await showConfirm(t("sa_confirm_delete_subject")))) return;
        if (!(await showPasswordConfirm(t("sa_pwconfirm_subject")))) return;
        try {
          await apiDelete(
            `/api/super/subject-dictionary/matrix/${encodeURIComponent(originalName)}`,
          );
          await loadAndRenderSubjects();
        } catch (err) {
          setErrorMsg(msg, err.message);
        }
      });
    }
  };

  subjects.forEach((s, i) => bindRow(`subj-${i}`, s.subject_name, false));
  bindRow("subj-new", "", true);
}
function subjectMatrixRow(rowId, subjectName, cells, columns, isNew) {
  const checkCells = columns
    .map(
      (c) =>
        `<td><input type="checkbox" class="subj-matrix-check" data-col="${c.key}" ${cells[c.key] ? "checked" : ""}></td>`,
    )
    .join("");
  return `
    <tr id="${rowId}">
      <td><input type="text" class="subj-matrix-name" value="${subjectName}" placeholder="${t("sa_f_subject_name")}"></td>
      ${checkCells}
      <td>
        <button class="btn ghost sm subj-matrix-save">${t("za_save")}</button>
        ${isNew ? "" : `<button class="btn ghost sm subj-matrix-delete">${t("za_delete")}</button>`}
      </td>
    </tr>`;
}

/* ==================================================================
   Student Roster — pick a school, upload a .csv/.xlsx roster (Name,
   Sex, Class, Section, Stream), see what's still pending assignment.
   The school's own Registrar finishes each row (fayda/phone + real
   student ID) via POST /api/registrar/pending-roster/:id/assign-id.
   ================================================================== */
let rosterCurrentSchool = null;
function rosterSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="upload"></i> ${t("sa_nav_roster")}</h3><p class="hint">${t("za_loading")}</p></div>`;
}
async function loadAndRenderRoster() {
  try {
    const schools = await apiGet("/api/super/schools");
    renderRosterPanel(schools);
  } catch (err) {
    document.getElementById("content").innerHTML = errorPanel(err);
  }
}
function renderRosterPanel(schools) {
  const schoolOpts = schools
    .map(
      (s) =>
        `<option value="${s.id}" ${String(s.id) === String(rosterCurrentSchool) ? "selected" : ""}>${s.school_name} (${s.zone_name || "—"})</option>`,
    )
    .join("");
  document.getElementById("content").innerHTML = `
  <div class="panel">
    <h3><i data-lucide="upload"></i> ${t("sa_nav_roster")}</h3>
    <div class="form-grid">
      <div class="form-field">
        <label for="roster_school">${t("sa_f_school")}</label>
        <select id="roster_school"><option value="">${t("sa_pick_school")}</option>${schoolOpts}</select>
      </div>
    </div>
    <div id="rosterBody">
      ${rosterCurrentSchool ? "" : `<p class="hint">${t("sa_pick_school_first")}</p>`}
    </div>
  </div>`;

  const schoolEl = document.getElementById("roster_school");
  schoolEl.addEventListener("change", async () => {
    rosterCurrentSchool = schoolEl.value || null;
    if (!rosterCurrentSchool) {
      document.getElementById("rosterBody").innerHTML =
        `<p class="hint">${t("sa_pick_school_first")}</p>`;
      return;
    }
    await refreshRosterBody();
  });
  if (rosterCurrentSchool) schoolEl.dispatchEvent(new Event("change"));
}
async function refreshRosterBody() {
  try {
    const pending = await apiGet(
      `/api/super/schools/${rosterCurrentSchool}/roster`,
    );
    renderRosterBody(pending);
  } catch (err) {
    document.getElementById("rosterBody").innerHTML = errorPanel(err);
  }
}
// Client-side CSV template for the Student Roster Upload form — headers
// match ROSTER_HEADER_MAP on the server exactly (case-insensitive there,
// but kept Title Case here since that's what the sample row shows).
// One example row is included so it's obvious what each column expects;
// the person deletes/overwrites it before filling in their own list.
function downloadRosterTemplateCsv() {
  const csv = [
    "First Name,Middle Name,Last Name,Sex,Class,Section,Stream",
    "Abebe,Kebede,Tesfaye,Male,9,A,",
    `Marta,,Alemu,Female,11,A,${SCHOOL_STREAMS[0] || "NATURAL SCIENCE"}`,
  ].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "student-roster-template.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function renderRosterBody(pending) {
  const rows = pending.length
    ? pending
        .map(
          (p) => `
    <tr>
      <td>${[p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ")}</td>
      <td>${p.sex}</td><td>${p.class_level}</td><td>${p.section}</td><td>${p.stream || "—"}</td>
      <td><span class="badge ${p.status === "assigned" ? "open" : "gold"}">${t("sa_roster_status_" + p.status)}</span>${p.assigned_student_id ? ` <span class="hint">${p.assigned_student_id}</span>` : ""}</td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="hint">${t("sa_roster_empty")}</td></tr>`;

  document.getElementById("rosterBody").innerHTML = `
    <div class="form-field">
      <label for="roster_file">${t("sa_f_roster_file")}</label>
      <input type="file" id="roster_file" accept=".csv,.xlsx">
      <p class="hint">${t("sa_roster_file_hint")}</p>
    </div>
    <div class="form-actions">
      <button class="btn ghost" id="btnDownloadRosterTemplate"><i data-lucide="download"></i> ${t("sa_roster_download_template")}</button>
      <button class="btn primary" id="btnUploadRoster">${t("sa_upload_roster")}</button>
    </div>
    <p class="hint" id="rosterFormMsg"></p>
    <div id="rosterUploadResult"></div>
    <div class="table-wrap"><table>
      <tr><th>${t("sa_th_name")}</th><th>${t("sa_th_sex")}</th><th>${t("sa_th_class")}</th><th>${t("sa_th_section")}</th><th>${t("sa_th_stream")}</th><th>${t("sa_th_status")}</th></tr>
      ${rows}
    </table></div>`;

  if (window.lucide) lucide.createIcons();
  document
    .getElementById("btnDownloadRosterTemplate")
    .addEventListener("click", downloadRosterTemplateCsv);

  const msg = document.getElementById("rosterFormMsg");
  document.getElementById("btnUploadRoster").onclick = async () => {
    const fileEl = document.getElementById("roster_file");
    const file = fileEl.files[0];
    if (!file) {
      setErrorMsg(msg, t("sa_roster_file_required"));
      return;
    }
    if (!(await showPasswordConfirm(t("sa_pwconfirm_roster")))) return;
    try {
      const formData = new FormData();
      formData.append("roster", file);
      const result = await apiUpload(
        `/api/super/schools/${rosterCurrentSchool}/roster/upload`,
        formData,
      );
      setSuccessMsg(msg, result.message);
      const resultEl = document.getElementById("rosterUploadResult");
      if (result.errors && result.errors.length) {
        resultEl.innerHTML = `<div class="alert-box error"><div class="icon"><i data-lucide="alert-triangle"></i></div><div class="body">
          ${t("sa_roster_skipped", { n: result.skipped })}
          <ul>${result.errors.map((e) => `<li>${t("sa_roster_row_error", { row: e.row, error: e.error })}</li>`).join("")}</ul>
        </div></div>`;
      } else {
        resultEl.innerHTML = "";
      }
      fileEl.value = "";
      await refreshRosterBody();
    } catch (err) {
      setErrorMsg(msg, err.message);
    }
  };
}

/* ==================================================================
   EASE Candidates (Super Admin side) — Grade 6/8/12 toggle switches
   which Ministry results table is shown AND which class_level the CSV
   upload applies to. Columns: School, Student, Admission #, Mark,
   Cutoff, Result. Upload populates ease_exam_results — the same table
   the Registrar's own EASE Candidates screen, the report card
   disclaimer, the Promote gate, and New Entrant admission all read
   live against.
   ================================================================== */
let easeCurrentGrade = 6;
function easeResultsSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="clipboard-check"></i> ${t("sa_nav_ease_candidates")}</h3><p class="hint">${t("za_loading")}</p></div>`;
}
async function loadAndRenderEaseResults() {
  await refreshEaseResultsBody();
}
function downloadEaseResultsTemplateCsv() {
  const csv = [
    "Admission Number,First Name,Mark,Cutoff,Average,Percentile,Result",
    "AD-10293,Abebe,68,50,71.5,88,",
    "AD-10294,Marta,42,50,45.2,34,",
  ].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ease-results-grade${easeCurrentGrade}-template.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
async function refreshEaseResultsBody() {
  const c = document.getElementById("content");
  c.innerHTML = `
  <div class="panel">
    <h3><i data-lucide="clipboard-check"></i> ${t("sa_nav_ease_candidates")}</h3>
    <div class="form-actions" id="easeGradeToggle">
      ${[6, 8, 12]
        .map(
          (g) =>
            `<button type="button" class="btn ${g === easeCurrentGrade ? "primary" : "ghost"}" data-grade="${g}">${t("sa_ease_grade_btn", { grade: g })}</button>`,
        )
        .join("")}
    </div>
    <div class="form-field">
      <label for="ease_file">${t("sa_f_ease_file")}</label>
      <input type="file" id="ease_file" accept=".csv">
      <p class="hint">${t("sa_ease_file_hint")}</p>
    </div>
    <div class="form-actions">
      <button class="btn ghost" id="btnDownloadEaseTemplate"><i data-lucide="download"></i> ${t("sa_roster_download_template")}</button>
      <button class="btn primary" id="btnUploadEase">${t("sa_ease_upload_btn")}</button>
    </div>
    <p class="hint" id="easeFormMsg"></p>
    <div id="easeUploadResult"></div>
    <div class="table-wrap" id="easeResultsTable"></div>
  </div>`;

  if (window.lucide) lucide.createIcons();
  document
    .getElementById("easeGradeToggle")
    .querySelectorAll("button")
    .forEach((btn) => {
      btn.addEventListener("click", async () => {
        easeCurrentGrade = Number(btn.dataset.grade);
        await refreshEaseResultsBody();
      });
    });
  document
    .getElementById("btnDownloadEaseTemplate")
    .addEventListener("click", downloadEaseResultsTemplateCsv);

  const msg = document.getElementById("easeFormMsg");
  document.getElementById("btnUploadEase").onclick = async () => {
    const fileEl = document.getElementById("ease_file");
    const file = fileEl.files[0];
    if (!file) {
      setErrorMsg(msg, t("sa_ease_file_required"));
      return;
    }
    try {
      const formData = new FormData();
      formData.append("results", file);
      formData.append("class_level", easeCurrentGrade);
      const result = await apiUpload(
        "/api/super/ease-results/upload",
        formData,
      );
      setSuccessMsg(msg, result.message);
      const resultEl = document.getElementById("easeUploadResult");
      if (result.errors && result.errors.length) {
        resultEl.innerHTML = `<div class="alert-box error"><div class="icon"><i data-lucide="alert-triangle"></i></div><div class="body">
          ${t("sa_roster_skipped", { n: result.skipped })}
          <ul>${result.errors.map((e) => `<li>${t("sa_roster_row_error", { row: e.row, error: e.error })}</li>`).join("")}</ul>
        </div></div>`;
      } else {
        resultEl.innerHTML = "";
      }
      fileEl.value = "";
      await loadEaseResultsTable();
    } catch (err) {
      setErrorMsg(msg, err.message);
    }
  };
  await loadEaseResultsTable();
}
async function loadEaseResultsTable() {
  const tableEl = document.getElementById("easeResultsTable");
  // Grade 12's national exam is reported as a Total Score, not a
  // Mark-vs-cutoff-percentile ranking the way Grade 6/8 are — same
  // underlying `mark` column, just a different label and no Percentile
  // column for that grade. See sa_ease_th_total_score in i18n.js.
  const isGrade12 = easeCurrentGrade === 12;
  try {
    const rows = await apiGet("/api/super/ease-results", {
      class_level: easeCurrentGrade,
    });
    const colCount = isGrade12 ? 6 : 7;
    const trs = rows.length
      ? rows
          .map((r) => {
            const badgeClass =
              r.result === "Pass"
                ? "open"
                : r.result === "Pending"
                  ? ""
                  : "gold";
            const resultLabel =
              r.result === "Pending"
                ? t("sa_ease_status_pending")
                : r.result === "Pass"
                  ? t("sa_ease_status_pass")
                  : r.result === "Fail"
                    ? t("sa_ease_status_fail")
                    : r.result;
            const percentileCell = isGrade12
              ? ""
              : `<td>${r.percentile ?? "—"}</td>`;
            return `
      <tr>
        <td>${r.school_name || `<span class="hint">${t("sa_ease_unmatched")}</span>`}</td>
        <td>${r.admission_number}</td>
        <td>${r.student_name || "—"}</td>
        <td>${r.average ?? "—"}</td>
        ${percentileCell}
        <td>${r.mark ?? "—"}</td>
        <td><span class="badge ${badgeClass}">${resultLabel}</span></td>
      </tr>`;
          })
          .join("")
      : `<tr><td colspan="${colCount}" class="hint">${t("sa_ease_empty")}</td></tr>`;
    const percentileHeader = isGrade12
      ? ""
      : `<th>${t("sa_ease_th_percentile")}</th>`;
    const markHeader = isGrade12
      ? t("sa_ease_th_total_score")
      : t("sa_ease_th_mark");
    tableEl.innerHTML = `<table>
      <tr><th>${t("sa_th_school")}</th><th>${t("sa_ease_th_admission")}</th><th>${t("sa_th_student")}</th><th>${t("sa_ease_th_average")}</th>${percentileHeader}<th>${markHeader}</th><th>${t("sa_ease_th_result")}</th></tr>
      ${trs}
    </table>`;
  } catch (err) {
    tableEl.innerHTML = errorPanel(err);
  }
}

/* ==================================================================
   EMIS Roster Requests — retrieve the list of active students at a
   school who still have no EMIS ID, send the Registrar a request to
   release that list, then once approved download it, fill in the EMIS
   IDs offline, and upload the mapping back. Three states per request:
   pending (waiting on Registrar) -> approved (download/upload unlocked)
   -> fulfilled (mapping uploaded at least once — stays downloadable in
   case more students still need mapping, since the download always
   reflects who's STILL missing an EMIS ID, live).
   ================================================================== */
let emisCurrentSchool = null;
let emisCurrentRoster = null; // last /emis-roster response for the selected school
function emisRequestsSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="link-2"></i> ${t("sa_nav_emis_roster")}</h3><p class="hint">${t("za_loading")}</p></div>`;
}
async function loadAndRenderEmisRequests() {
  try {
    const schools = await apiGet("/api/super/schools");
    renderEmisRosterPanel(schools);
  } catch (err) {
    document.getElementById("content").innerHTML = errorPanel(err);
  }
}
function emisStatusBadge(status) {
  const cls =
    status === "approved" || status === "pending"
      ? "gold"
      : status === "fulfilled"
        ? "open"
        : "danger";
  return `<span class="badge ${cls}">${t("sa_emis_status_" + status)}</span>`;
}

/* Main EMIS Roster panel: pick a school -> summary cards + full roster
   (Verified / Unverified / No EMIS). "Request EMIS IDs" opens a modal
   scoped to only the students still missing one; "View Requests" opens
   the history/download/upload table — both stay inside this one nav
   item instead of living as separate pages. */
function renderEmisRosterPanel(schools) {
  const schoolOpts = schools
    .map(
      (s) =>
        `<option value="${s.id}" ${String(s.id) === String(emisCurrentSchool) ? "selected" : ""}>${s.school_name} (${s.zone_name || "—"})</option>`,
    )
    .join("");

  document.getElementById("content").innerHTML = `
  <div class="panel">
    <h3><i data-lucide="link-2"></i> ${t("sa_nav_emis_roster")}</h3>
    <p class="hint">${t("sa_emis_intro")}</p>
    <div class="form-grid">
      <div class="form-field">
        <label for="emis_school">${t("sa_f_school")}</label>
        <select id="emis_school"><option value="">${t("sa_pick_school")}</option>${schoolOpts}</select>
      </div>
    </div>
    <div id="emisRosterBody">
      ${emisCurrentSchool ? "" : `<p class="hint">${t("sa_pick_school_first")}</p>`}
    </div>
  </div>`;

  const schoolEl = document.getElementById("emis_school");
  schoolEl.addEventListener("change", async () => {
    emisCurrentSchool = schoolEl.value || null;
    if (!emisCurrentSchool) {
      document.getElementById("emisRosterBody").innerHTML =
        `<p class="hint">${t("sa_pick_school_first")}</p>`;
      return;
    }
    await refreshEmisRosterBody();
  });
  if (emisCurrentSchool) schoolEl.dispatchEvent(new Event("change"));
}

async function refreshEmisRosterBody() {
  try {
    const data = await apiGet(
      `/api/super/schools/${emisCurrentSchool}/emis-roster`,
    );
    emisCurrentRoster = data;
    renderEmisRosterBody(data);
  } catch (err) {
    document.getElementById("emisRosterBody").innerHTML = errorPanel(err);
  }
}

function emisLinkBadge(s) {
  if (!s.emis_id)
    return `<span class="badge danger">${t("sa_emis_badge_unlinked")}</span>`;
  return s.verified
    ? `<span class="badge open">${t("sa_emis_badge_verified")}</span>`
    : `<span class="badge gold">${t("sa_emis_badge_unverified")}</span>`;
}

function renderEmisRosterBody(data) {
  const rows = data.students.length
    ? data.students
        .map(
          (s) => `
    <tr>
      <td>${s.student_id}</td>
      <td>${[s.first_name, s.middle_name, s.last_name].filter(Boolean).join(" ")}</td>
      <td>${s.class_level}</td><td>${s.section || "—"}</td>
      <td>${s.emis_id || "—"}</td>
      <td>${emisLinkBadge(s)}</td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="hint">${t("sa_emis_roster_empty")}</td></tr>`;

  document.getElementById("emisRosterBody").innerHTML = `
    <div class="cards">
      <div class="card">
        <div class="icon"><i data-lucide="users"></i></div>
        <div><div class="label">${t("sa_emis_card_total")}</div><div class="value">${data.total}</div></div>
      </div>
      <div class="card">
        <div class="icon"><i data-lucide="check-circle-2"></i></div>
        <div><div class="label">${t("sa_emis_card_with")}</div><div class="value">${data.with_emis}</div></div>
      </div>
      <div class="card">
        <div class="icon"><i data-lucide="unlink"></i></div>
        <div><div class="label">${t("sa_emis_card_without")}</div><div class="value">${data.without_emis}</div></div>
      </div>
    </div>
    <div class="form-actions" style="margin:14px 0;">
      <button class="btn primary" id="btnOpenEmisRequestModal" ${data.without_emis === 0 ? "disabled" : ""}>
        <i data-lucide="send"></i> ${t("sa_emis_send_request")}
      </button>
      <button class="btn ghost" id="btnOpenEmisRequestsHistory">
        <i data-lucide="history"></i> ${t("sa_emis_view_requests")}
      </button>
    </div>
    <div class="table-wrap"><table>
      <tr><th>${t("sa_th_id")}</th><th>${t("sa_th_name")}</th><th>${t("sa_th_class")}</th><th>${t("sa_th_section")}</th><th>${t("sa_th_emis_id")}</th><th>${t("za_th_status")}</th></tr>
      ${rows}
    </table></div>`;

  if (window.lucide) lucide.createIcons();

  const reqBtn = document.getElementById("btnOpenEmisRequestModal");
  if (reqBtn)
    reqBtn.addEventListener("click", () => openEmisRequestModal(data));
  document
    .getElementById("btnOpenEmisRequestsHistory")
    .addEventListener("click", () => openEmisRequestsHistoryModal());
}

/* ---------------- Request EMIS IDs modal — scoped to only the
   students currently missing one (data.without_emis), matching what
   POST /api/super/schools/:id/emis-requests itself enforces server-side. */
function openEmisRequestModal(data) {
  const backdrop = document.createElement("div");
  backdrop.className = "confirm-modal-backdrop";
  backdrop.innerHTML = `
    <div class="confirm-modal form-modal" role="dialog" aria-modal="true">
      <div class="confirm-modal-icon"><i data-lucide="send"></i></div>
      <h3 class="confirm-modal-title">${t("sa_emis_send_request")}</h3>
      <p class="confirm-modal-msg">${t("sa_emis_missing_count", { n: data.without_emis, school: data.school_name })}</p>
      <div class="form-field" style="text-align:left;">
        <label for="emis_request_note">${t("sa_emis_note")}</label>
        <textarea id="emis_request_note" rows="3"></textarea>
      </div>
      <p class="hint" id="emisRequestMsg" style="text-align:left;"></p>
      <div class="confirm-modal-actions">
        <button class="btn ghost" id="emisReqCancel">${t("za_cancel")}</button>
        <button class="btn primary" id="emisReqSend">${t("sa_emis_send_request")}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  if (window.lucide) lucide.createIcons();
  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("#emisReqCancel").addEventListener("click", close);
  backdrop.querySelector("#emisReqSend").addEventListener("click", async () => {
    const msg = document.getElementById("emisRequestMsg");
    const note = document.getElementById("emis_request_note").value.trim();
    try {
      const result = await apiPost(
        `/api/super/schools/${emisCurrentSchool}/emis-requests`,
        { note: note || undefined },
      );
      setSuccessMsg(msg, result.message);
      await refreshEmisRosterBody();
      setTimeout(close, 900);
    } catch (err) {
      setErrorMsg(msg, err.message);
    }
  });
}

/* ---------------- Request history modal — every request sent across
   every school (download/upload actions), reached from inside the EMIS
   Roster nav instead of being its own separate nav item. */
async function openEmisRequestsHistoryModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "confirm-modal-backdrop";
  backdrop.innerHTML = `
    <div class="confirm-modal form-modal wide" role="dialog" aria-modal="true">
      <h3 class="confirm-modal-title">${t("sa_emis_requests_title")}</h3>
      <div id="emisHistoryBody" style="text-align:left;"><p class="hint">${t("za_loading")}</p></div>
      <div class="confirm-modal-actions">
        <button class="btn ghost" id="emisHistoryClose">${t("za_cancel")}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  if (window.lucide) lucide.createIcons();
  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("#emisHistoryClose").addEventListener("click", close);

  try {
    const requests = await apiGet("/api/super/emis-requests");
    renderEmisRequestsHistoryBody(requests);
  } catch (err) {
    document.getElementById("emisHistoryBody").innerHTML = errorPanel(err);
  }
}

function renderEmisRequestsHistoryBody(requests) {
  const reqRows = requests.length
    ? requests
        .map(
          (r) => `
    <tr>
      <td>${r.school_name}</td>
      <td>${r.student_count}</td>
      <td>${emisStatusBadge(r.status)}</td>
      <td>${new Date(r.created_at).toLocaleString()}</td>
      <td>
        ${
          r.status === "approved" || r.status === "fulfilled"
            ? `
          <button class="btn ghost sm emis-download" data-id="${r.request_id}">${t("sa_emis_download")}</button>
          <button class="btn ghost sm emis-upload-toggle" data-id="${r.request_id}">${t("sa_emis_upload")}</button>
        `
            : ""
        }
        ${r.status === "rejected" && r.rejection_reason ? `<span class="hint">${r.rejection_reason}</span>` : ""}
      </td>
    </tr>
    <tr class="emis-upload-row" id="emisUploadRow_${r.request_id}" style="display:none">
      <td colspan="5">
        <div class="form-field">
          <input type="file" id="emisUploadFile_${r.request_id}" accept=".csv">
          <p class="hint">${t("sa_emis_upload_hint")}</p>
        </div>
        <button class="btn primary sm emis-upload-submit" data-id="${r.request_id}">${t("za_save")}</button>
        <p class="hint" id="emisUploadMsg_${r.request_id}"></p>
      </td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="hint">${t("sa_emis_requests_empty")}</td></tr>`;

  document.getElementById("emisHistoryBody").innerHTML = `
    <div class="table-wrap"><table>
      <tr><th>${t("sa_th_school")}</th><th>${t("sa_emis_th_count")}</th><th>${t("za_th_status")}</th><th>${t("sa_th_when")}</th><th>${t("za_th_actions")}</th></tr>
      ${reqRows}
    </table></div>`;

  document.querySelectorAll(".emis-download").forEach((btn) => {
    btn.addEventListener("click", () => {
      window.open(
        `${API_BASE}/api/super/emis-requests/${btn.dataset.id}/download`,
        "_blank",
      );
    });
  });
  document.querySelectorAll(".emis-upload-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = document.getElementById(`emisUploadRow_${btn.dataset.id}`);
      row.style.display = row.style.display === "none" ? "table-row" : "none";
    });
  });
  document.querySelectorAll(".emis-upload-submit").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const fileEl = document.getElementById(`emisUploadFile_${id}`);
      const msg = document.getElementById(`emisUploadMsg_${id}`);
      const file = fileEl.files[0];
      if (!file) {
        setErrorMsg(msg, t("sa_emis_upload_file_required"));
        return;
      }
      try {
        const formData = new FormData();
        formData.append("roster", file);
        const result = await apiUpload(
          `/api/super/emis-requests/${id}/upload`,
          formData,
        );
        setSuccessMsg(msg, result.message);
        if (result.errors && result.errors.length) {
          msg.innerHTML += `<ul>${result.errors.map((e) => `<li>${t("sa_roster_row_error", { row: e.row, error: e.error })}</li>`).join("")}</ul>`;
        }
        const requests = await apiGet("/api/super/emis-requests");
        renderEmisRequestsHistoryBody(requests);
        await refreshEmisRosterBody();
      } catch (err) {
        setErrorMsg(msg, err.message);
      }
    });
  });
}

/* ==================================================================
   Activity Log — read-only view of audit_log via /api/super/audit-log.
   ================================================================== */
function auditSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="scroll-text"></i> ${t("sa_nav_audit")}</h3><p class="hint">${t("za_loading")}</p></div>`;
}
async function loadAndRenderAuditLog() {
  try {
    const entries = await apiGet("/api/super/audit-log", { limit: 100 });
    renderAuditLogPanel(entries);
  } catch (err) {
    document.getElementById("content").innerHTML = errorPanel(err);
  }
}
// audit_log.action is a raw, dot-namespaced event code straight off the
// backend (see logAudit() in server.js) — stable for filtering/exports,
// but not something to show a Zonal/Super Admin as-is, especially in
// Amharic. Maps it to a translated sa_audit_action_* label; anything not
// in the map (a code added on the backend without a matching label yet)
// falls back to the raw code rather than a raw i18n key string.
function auditActionLabel(action) {
  if (!action) return "—";
  const key = "sa_audit_action_" + action.replace(/\./g, "_");
  const label = t(key);
  return label === key ? action : label;
}
function renderAuditLogPanel(entries) {
  const rows = entries.length
    ? entries
        .map(
          (a) => `
    <tr>
      <td>${auditActionLabel(a.action)}</td>
      <td>${a.actor_id}</td>
      <td>${a.target_type ? `${a.target_type}${a.target_id ? " #" + a.target_id : ""}` : "—"}</td>
      <td>${a.details || "—"}</td>
      <td>${new Date(a.created_at).toLocaleString()}</td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="hint">${t("sa_audit_empty")}</td></tr>`;

  document.getElementById("content").innerHTML = `
  <div class="panel">
    <h3><i data-lucide="scroll-text"></i> ${t("sa_nav_audit")}</h3>
    <div class="table-wrap"><table>
      <tr><th>${t("sa_th_action")}</th><th>${t("sa_th_actor")}</th><th>${t("sa_th_target")}</th><th>${t("sa_th_details")}</th><th>${t("sa_th_when")}</th></tr>
      ${rows}
    </table></div>
  </div>`;
}

/* ==================================================================
   Role Permissions — the concrete, togglable list this used to be a
   stub for: one checkbox per action (hire a teacher, appoint a school
   admin, transfer a teacher) for each Teacher Development Coordinator,
   instead of the old all-or-nothing "delegate" checkbox on the Zonal
   Admins screen. Live from /api/super/zonal-admins (to list TDCs) and
   /api/super/zonal-admins/:admin_id/permissions (read/write per row).
   ================================================================== */
const PERMISSION_KEYS = [
  "hire_teacher",
  "appoint_school_admin",
  "transfer_teacher",
];
function permissionsSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="shield-check"></i> ${t("sa_nav_permissions")}</h3><p class="hint">${t("za_loading")}</p></div>`;
}
async function loadAndRenderPermissions() {
  try {
    const admins = await apiGet("/api/super/zonal-admins");
    const tdcs = admins.filter(
      (a) => a.title === "Teacher Development Coordinator",
    );
    const perms = await Promise.all(
      tdcs.map((a) =>
        apiGet(`/api/super/zonal-admins/${a.admin_id}/permissions`).catch(
          () => ({ permissions: {} }),
        ),
      ),
    );
    renderPermissionsPanel(tdcs, perms);
  } catch (err) {
    document.getElementById("content").innerHTML = errorPanel(err);
  }
}
function renderPermissionsPanel(tdcs, perms) {
  const rows = tdcs.length
    ? tdcs
        .map((a, i) => {
          const p = perms[i]?.permissions || {};
          const checks = PERMISSION_KEYS.map(
            (k) => `
      <label class="checklist-row"><input type="checkbox" class="perm-check" data-admin="${a.admin_id}" data-key="${k}" ${p[k] ? "checked" : ""}> ${t("sa_perm_" + k)}</label>`,
          ).join("");
          return `
    <tr data-id="${a.admin_id}">
      <td>${[a.first_name, a.middle_name, a.last_name].filter(Boolean).join(" ")}</td>
      <td>${a.admin_id}</td>
      <td>${a.zone_name || "—"}</td>
      <td><div class="checklist">${checks}</div></td>
      <td><button class="btn primary sm perm-save">${t("za_save")}</button></td>
    </tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="hint">${t("sa_permissions_empty")}</td></tr>`;

  document.getElementById("content").innerHTML = `
  <div class="panel">
    <h3><i data-lucide="shield-check"></i> ${t("sa_nav_permissions")}</h3>
    <p class="hint">${t("sa_permissions_hint")}</p>
    <div class="table-wrap"><table>
      <tr><th>${t("sa_th_name")}</th><th>${t("sa_th_id")}</th><th>${t("sa_th_zone")}</th><th>${t("sa_th_permissions")}</th><th>${t("za_th_actions")}</th></tr>
      ${rows}
    </table></div>
    <p class="hint" id="permissionsFormMsg"></p>
  </div>`;

  const msg = document.getElementById("permissionsFormMsg");
  document.querySelectorAll(".perm-save").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tr = btn.closest("tr");
      const adminId = tr.dataset.id;
      const permissions = {};
      tr.querySelectorAll(".perm-check").forEach((chk) => {
        permissions[chk.dataset.key] = chk.checked;
      });
      if (!(await showPasswordConfirm(t("sa_pwconfirm_permissions")))) return;
      try {
        await apiPut(`/api/super/zonal-admins/${adminId}/permissions`, {
          permissions,
        });
        setSuccessMsg(msg, t("sa_permissions_saved"));
      } catch (err) {
        setErrorMsg(msg, err.message);
      }
    });
  });
}

/* ==================================================================
   Class & Grade Mapping — read-only reference showing how Educational
   Level maps to Grade-Tier(s) and grade ranges, plus which tiers each
   registered school actually carries. Live from
   /api/super/grade-tier-mapping (the fixed mapping) and
   /api/super/schools (per-school tiers, reused from the Schools screen).
   ================================================================== */
function gradeMappingSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="layers"></i> ${t("sa_nav_grade_mapping")}</h3><p class="hint">${t("za_loading")}</p></div>`;
}
async function loadAndRenderGradeMapping() {
  try {
    const [mapping, schools] = await Promise.all([
      apiGet("/api/super/grade-tier-mapping"),
      apiGet("/api/super/schools"),
    ]);
    renderGradeMappingPanel(mapping, schools);
  } catch (err) {
    document.getElementById("content").innerHTML = errorPanel(err);
  }
}
function renderGradeMappingPanel(mapping, schools) {
  const mappingRows = mapping
    .map(
      (m) => `
    <tr>
      <td>${t("sa_edulevel_" + m.educational_level.toLowerCase())}</td>
      <td>${m.tiers.map((t2) => `<span class="badge">${t("sa_level_" + t2.school_level.toLowerCase())}</span>`).join(" ")}</td>
      <td>${m.tiers.map((t2) => `${t2.grades[0]}–${t2.grades[1]}`).join(", ")}</td>
    </tr>`,
    )
    .join("");
  const schoolRows = schools.length
    ? schools
        .map(
          (s) => `
    <tr>
      <td>${s.school_name}</td>
      <td>${eduLevelBadges(s.educational_levels)}</td>
      <td>${tierBadges(s.grade_tiers)}</td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="hint">${t("sa_schools_empty")}</td></tr>`;

  document.getElementById("content").innerHTML = `
  <div class="panel">
    <h3><i data-lucide="layers"></i> ${t("sa_grade_mapping_reference")}</h3>
    <p class="hint">${t("sa_grade_mapping_hint")}</p>
    <div class="table-wrap"><table>
      <tr><th>${t("sa_th_educational_level")}</th><th>${t("sa_th_grade_tiers")}</th><th>${t("sa_th_grades")}</th></tr>
      ${mappingRows}
    </table></div>
  </div>
  <div class="panel">
    <h3><i data-lucide="building-2"></i> ${t("sa_grade_mapping_by_school")}</h3>
    <div class="table-wrap"><table>
      <tr><th>${t("sa_th_school")}</th><th>${t("sa_th_educational_level")}</th><th>${t("sa_th_grade_tiers")}</th></tr>
      ${schoolRows}
    </table></div>
  </div>`;
}

/* ==================================================================
   Stream Setup — system-wide catalog of streams schools can draw from,
   its own screen instead of an inline toggle on school registration.
   Live from /api/super/streams. Adding/renaming here refreshes
   SCHOOL_STREAMS (see loadStreamCatalog()) so the Schools/Subject
   Dictionary/Roster screens pick it up on their next load.
   ================================================================== */
function streamsSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="git-branch"></i> ${t("sa_nav_streams")}</h3><p class="hint">${t("za_loading")}</p></div>`;
}
async function loadAndRenderStreams() {
  try {
    const streams = await apiGet("/api/super/streams");
    renderStreamsPanel(streams);
  } catch (err) {
    document.getElementById("content").innerHTML = errorPanel(err);
  }
}
function renderStreamsPanel(streams) {
  const rows = streams.length
    ? streams
        .map(
          (s) => `
    <tr data-id="${s.stream_id}">
      <td class="stream-name">${s.stream_name}</td>
      <td>
        <button class="btn ghost sm stream-edit">${t("za_edit")}</button>
        <button class="btn ghost sm stream-delete">${t("za_delete")}</button>
      </td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="2" class="hint">${t("sa_streams_empty")}</td></tr>`;

  document.getElementById("content").innerHTML = `
  <div class="panel">
    <h3><i data-lucide="git-branch"></i> ${t("sa_nav_streams")}</h3>
    <p class="hint">${t("sa_stream_setup_hint")}</p>
    <div class="form-grid">
      <div class="form-field">
        <label for="stream_new_name">${t("sa_f_stream_name")}</label>
        <input type="text" id="stream_new_name" placeholder="e.g. Technical Science">
      </div>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnAddStream">${t("sa_add_stream")}</button>
    </div>
    <p class="hint" id="streamFormMsg"></p>
    <div class="table-wrap"><table>
      <tr><th>${t("sa_th_stream")}</th><th>${t("za_th_actions")}</th></tr>
      ${rows}
    </table></div>
  </div>`;

  const msg = document.getElementById("streamFormMsg");
  document.getElementById("btnAddStream").onclick = async () => {
    const nameEl = document.getElementById("stream_new_name");
    const stream_name = nameEl.value.trim();
    if (!stream_name) {
      setErrorMsg(msg, t("sa_stream_required"));
      return;
    }
    if (!(await showPasswordConfirm(t("sa_pwconfirm_stream")))) return;
    try {
      const result = await apiPost("/api/super/streams", { stream_name });
      setSuccessMsg(msg, result.message);
      await loadStreamCatalog();
      loadAndRenderStreams();
    } catch (err) {
      setErrorMsg(msg, err.message);
    }
  };

  document.querySelectorAll(".stream-edit").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tr = btn.closest("tr");
      const id = tr.dataset.id;
      const current = tr.querySelector(".stream-name").textContent;
      const next = prompt(t("sa_edit_stream_prompt"), current);
      if (
        next === null ||
        !next.trim() ||
        next.trim().toUpperCase() === current
      )
        return;
      if (!(await showPasswordConfirm(t("sa_pwconfirm_stream")))) return;
      try {
        await apiPut(`/api/super/streams/${id}`, { stream_name: next.trim() });
        await loadStreamCatalog();
        loadAndRenderStreams();
      } catch (err) {
        setErrorMsg(msg, err.message);
      }
    });
  });
  document.querySelectorAll(".stream-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tr = btn.closest("tr");
      const id = tr.dataset.id;
      if (!(await showConfirm(t("sa_confirm_delete_stream")))) return;
      if (!(await showPasswordConfirm(t("sa_pwconfirm_stream")))) return;
      try {
        await apiDelete(`/api/super/streams/${id}`);
        await loadStreamCatalog();
        loadAndRenderStreams();
      } catch (err) {
        setErrorMsg(msg, err.message);
      }
    });
  });
}

/* ==================================================================
   Manage Super Admins — Owner-only screen (nav item itself is hidden
   for an IT Lead, and every write here is also enforced server-side by
   requireOwner). Live from /api/super/super-admins.
   ================================================================== */
function superAdminsSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="user-cog"></i> ${t("sa_nav_super_admins")}</h3><p class="hint">${t("za_loading")}</p></div>`;
}
async function loadAndRenderSuperAdmins() {
  try {
    const admins = await apiGet("/api/super/super-admins");
    renderSuperAdminsPanel(admins);
  } catch (err) {
    document.getElementById("content").innerHTML = errorPanel(err);
  }
}
function renderSuperAdminsPanel(admins) {
  const titleCellOpts = (current) =>
    SUPER_ADMIN_TITLES.map(
      (ti) =>
        `<option value="${ti}" ${ti === current ? "selected" : ""}>${ti === "Owner" ? t("sa_role_owner") : t("sa_role_it_lead")}</option>`,
    ).join("");
  const adminsById = {};
  admins.forEach((a) => {
    adminsById[a.admin_id] = a;
  });
  const rows = admins.length
    ? admins
        .map(
          (a) => `
    <tr data-id="${a.admin_id}">
      <td>${[a.first_name, a.middle_name, a.last_name].filter(Boolean).join(" ") || "—"}</td>
      <td>${a.admin_id}</td>
      <td>
        <select class="sa-admin-title-select" data-current="${a.title}">${titleCellOpts(a.title)}</select>
      </td>
      <td>${a.contact_number || "—"}</td>
      <td>${a.is_restricted ? `<span class="badge">${t("sa_it_specialist")}</span>` : `<span class="hint">${t("sa_full_access")}</span>`}</td>
      <td>
        <button class="btn ghost sm sa-admin-reset">${t("sa_reset_password")}</button>
        <button class="btn ghost sm sa-admin-access">${t("sa_manage_access")}</button>
      </td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="hint">${t("sa_super_admins_empty")}</td></tr>`;
  const titleOpts = SUPER_ADMIN_TITLES.map(
    (ti) =>
      `<option value="${ti}">${ti === "Owner" ? t("sa_role_owner") : t("sa_role_it_lead")}</option>`,
  ).join("");

  document.getElementById("content").innerHTML = `
  <div class="panel">
    <h3><i data-lucide="user-plus"></i> ${t("sa_create_super_admin")}</h3>
    <div class="form-grid">
      <div class="form-field">
        <label for="sa_new_title">${t("sa_f_title")}</label>
        <select id="sa_new_title">${titleOpts}</select>
      </div>
      <div class="form-field">
        <label for="sa_new_first">${t("sa_f_first_name")}</label>
        <input type="text" id="sa_new_first" placeholder="${t("sa_f_first_name")}">
      </div>
      <div class="form-field">
        <label for="sa_new_middle">${t("sa_f_middle_name")}</label>
        <input type="text" id="sa_new_middle" placeholder="${t("sa_f_middle_name")}">
      </div>
      <div class="form-field">
        <label for="sa_new_last">${t("sa_f_last_name")}</label>
        <input type="text" id="sa_new_last" placeholder="${t("sa_f_last_name")}">
      </div>
      <div class="form-field">
        <label for="sa_new_contact">${t("sa_f_contact")}</label>
        <input type="text" id="sa_new_contact" placeholder="09xxxxxxxx">
      </div>
      <div class="form-field">
        <label for="sa_new_email">${t("sa_f_email")}</label>
        <input type="email" id="sa_new_email" placeholder="name@example.com">
      </div>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnCreateSuperAdmin">${t("sa_create_super_admin")}</button>
    </div>
    <p class="hint" id="superAdminFormMsg"></p>
  </div>
  <div class="panel">
    <h3><i data-lucide="user-cog"></i> ${t("sa_nav_super_admins")}</h3>
    <p class="hint">${t("sa_it_specialist_hint")}</p>
    <div class="table-wrap"><table>
      <tr><th>${t("sa_th_name")}</th><th>${t("sa_th_id")}</th><th>${t("sa_th_title")}</th><th>${t("sa_f_contact")}</th><th>${t("sa_th_access")}</th><th>${t("za_th_actions")}</th></tr>
      ${rows}
    </table></div>
  </div>`;

  const msg = document.getElementById("superAdminFormMsg");
  document.getElementById("btnCreateSuperAdmin").onclick = async () => {
    const body = {
      title: document.getElementById("sa_new_title").value,
      first_name: document.getElementById("sa_new_first").value.trim(),
      middle_name:
        document.getElementById("sa_new_middle").value.trim() || null,
      last_name: document.getElementById("sa_new_last").value.trim(),
      contact_number:
        document.getElementById("sa_new_contact").value.trim() || null,
      email: document.getElementById("sa_new_email").value.trim() || null,
    };
    if (!body.first_name || !body.last_name) {
      setErrorMsg(msg, t("sa_zonal_admin_required"));
      return;
    }
    if (!(await showPasswordConfirm(t("sa_pwconfirm_super_admin")))) return;
    try {
      const result = await apiPost("/api/super/super-admins", body);
      setSuccessMsg(msg, result.message);
      showCredentialsModal(result.admin_id, result.default_password);
      loadAndRenderSuperAdmins();
    } catch (err) {
      setErrorMsg(msg, err.message);
    }
  };

  document.querySelectorAll(".sa-admin-reset").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const adminId = btn.closest("tr").dataset.id;
      if (!(await showConfirm(t("sa_confirm_reset_password")))) return;
      if (!(await showPasswordConfirm(t("sa_pwconfirm_reset")))) return;
      try {
        const result = await apiPost(
          `/api/super/super-admins/${adminId}/reset-password`,
          {},
        );
        showCredentialsModal(adminId, result.default_password);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll(".sa-admin-title-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const adminId = sel.closest("tr").dataset.id;
      const newTitle = sel.value;
      const oldTitle = sel.dataset.current;
      if (newTitle === oldTitle) return;
      const label = newTitle === "Owner" ? t("sa_role_owner") : t("sa_role_it_lead");
      if (
        !(await showConfirm(t("sa_confirm_change_title", { admin_id: adminId, title: label })))
      ) {
        sel.value = oldTitle;
        return;
      }
      if (!(await showPasswordConfirm(t("sa_pwconfirm_change_title")))) {
        sel.value = oldTitle;
        return;
      }
      try {
        const result = await apiPut(
          `/api/super/super-admins/${adminId}/title`,
          { title: newTitle },
        );
        sel.dataset.current = newTitle;
        setSuccessMsg(document.getElementById("superAdminFormMsg"), result.message);
        if (adminId === CURRENT_USER.user_id) {
          CURRENT_USER.title = newTitle;
          renderTopChrome();
        }
        renderNav();
      } catch (err) {
        sel.value = oldTitle;
        alert(err.message);
      }
    });
  });

  document.querySelectorAll(".sa-admin-access").forEach((btn) => {
    btn.addEventListener("click", () => {
      const adminId = btn.closest("tr").dataset.id;
      openSuperAdminAccessModal(adminsById[adminId]);
    });
  });
}

// Screens/actions an IT Specialist can be granted — mirrors
// SUPER_ADMIN_PERMISSION_KEYS in server.js exactly.
const SUPER_ADMIN_PERMISSION_KEYS = [
  "manage_schools",
  "manage_zonal_admins",
  "manage_subject_dictionary",
  "manage_roster",
  "manage_streams",
  "view_audit_log",
];
// "IT Specialist" isn't a new title — it's this restriction flag layered
// on an existing Owner/IT Lead account. Turning it on narrows that
// account to only the screens checked below; turning it off restores
// full access without losing whatever was checked, in case it's
// switched back on later.
function openSuperAdminAccessModal(admin) {
  const backdrop = document.createElement("div");
  backdrop.className = "confirm-modal-backdrop";
  backdrop.innerHTML = `
    <div class="confirm-modal" role="dialog" aria-modal="true">
      <div class="confirm-modal-icon"><i data-lucide="shield-check"></i></div>
      <h3 class="confirm-modal-title">${t("sa_manage_access")} — ${admin.admin_id}</h3>
      <label class="checklist-row">
        <input type="checkbox" id="saAccessRestricted" ${admin.is_restricted ? "checked" : ""}>
        <b>${t("sa_it_specialist")}</b> — ${t("sa_it_specialist_hint")}
      </label>
      <div class="checklist" id="saAccessPermList"><p class="hint">${t("za_loading")}</p></div>
      <p class="confirm-modal-error" id="saAccessError" role="alert" style="display:none"></p>
      <div class="confirm-modal-actions">
        <button class="btn ghost" id="saAccessCancel">${t("za_cancel")}</button>
        <button class="btn primary" id="saAccessSave">${t("za_save")}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  if (window.lucide) lucide.createIcons();

  const permListEl = backdrop.querySelector("#saAccessPermList");
  const restrictedChk = backdrop.querySelector("#saAccessRestricted");
  const renderPermChecks = (permissions) => {
    permListEl.innerHTML = SUPER_ADMIN_PERMISSION_KEYS.map(
      (k) => `
      <label class="checklist-row"><input type="checkbox" class="sa-access-perm-check" data-key="${k}" ${permissions[k] ? "checked" : ""}> ${t("sa_perm_" + k)}</label>`,
    ).join("");
  };
  apiGet(`/api/super/super-admins/${admin.admin_id}/permissions`)
    .then((res) => renderPermChecks(res.permissions))
    .catch(() => {
      permListEl.innerHTML = `<p class="hint">${t("sa_permissions_empty")}</p>`;
    });

  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("#saAccessCancel").addEventListener("click", close);
  backdrop.querySelector("#saAccessSave").addEventListener("click", async () => {
    const isRestricted = restrictedChk.checked;
    const permissions = {};
    backdrop.querySelectorAll(".sa-access-perm-check").forEach((chk) => {
      permissions[chk.dataset.key] = chk.checked;
    });
    close();
    if (!(await showPasswordConfirm(t("sa_pwconfirm_permissions")))) return;
    try {
      await apiPut(`/api/super/super-admins/${admin.admin_id}/restricted`, {
        is_restricted: isRestricted,
      });
      await apiPut(`/api/super/super-admins/${admin.admin_id}/permissions`, {
        permissions,
      });
      loadAndRenderSuperAdmins();
    } catch (err) {
      alert(err.message);
    }
  });
}

/* ==================================================================
   Profile Settings — the Super Admin's own account: avatar upload,
   display name, and self-serve password change. Synchronous (no
   network round trip needed to render) since everything it needs is
   already sitting in CURRENT_USER from boot(); only the two form
   submits below hit the network. current_password is required to set
   a new one, same "prove you're still you" gate every other
   credential change in this app uses, but NOT required just to update
   the display name — mirrors POST /api/super/account exactly.
   ================================================================== */
function accountSettingsSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="user-circle"></i> ${t("sa_nav_account")}</h3><p class="hint">${t("za_loading")}</p></div>`;
}
function renderAccountSettingsPanel() {
  const u = CURRENT_USER;
  const roleLabel =
    u.title === "Owner"
      ? t("sa_role_owner")
      : u.title === "IT Lead"
        ? t("sa_role_it_lead")
        : t("sa_role_title");
  const [first, ...rest] = (u.admin_full_name || "").split(" ").filter(Boolean);
  const last = rest.length ? rest[rest.length - 1] : "";
  const middle = rest.length > 1 ? rest.slice(0, -1).join(" ") : "";

  document.getElementById("content").innerHTML = `
  <div class="panel">
    <h3><i data-lucide="image"></i> ${t("sa_account_avatar")}</h3>
    <div class="account-avatar-row">
      <div class="avatar account-avatar-preview" id="acctAvatarPreview">
        ${u.avatar_url ? `<img class="avatar-img" src="${u.avatar_url}" alt="">` : initialsOf(u.admin_full_name || roleLabel)}
      </div>
      <div>
        <label class="btn ghost sm" for="acctAvatarFile">${t("sa_account_upload_avatar")}</label>
        <input type="file" id="acctAvatarFile" accept="image/*" style="display:none;">
        <p class="hint">${t("sa_account_avatar_hint")}</p>
      </div>
    </div>
    <p class="hint" id="acctAvatarMsg"></p>
  </div>

  <div class="panel">
    <h3><i data-lucide="id-card"></i> ${t("sa_account_details")}</h3>
    <div class="form-grid">
      <div class="form-field"><label>${t("sa_th_id")}</label><input type="text" value="${u.user_id}" disabled></div>
      <div class="form-field"><label>${t("sa_f_title")}</label><input type="text" value="${roleLabel}" disabled></div>
      <div class="form-field"><label for="acctFirst">${t("sa_f_first_name")}</label><input type="text" id="acctFirst" value="${first || ""}"></div>
      <div class="form-field"><label for="acctMiddle">${t("sa_f_middle_name")}</label><input type="text" id="acctMiddle" value="${middle}"></div>
      <div class="form-field"><label for="acctLast">${t("sa_f_last_name")}</label><input type="text" id="acctLast" value="${last}"></div>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnSaveAcctName">${t("za_save")}</button>
    </div>
    <p class="hint" id="acctNameMsg"></p>
  </div>

  <div class="panel">
    <h3><i data-lucide="lock"></i> ${t("sa_account_password")}</h3>
    <div class="form-grid">
      <div class="form-field"><label for="acctCurrentPw">${t("sa_account_current_password")}</label><input type="password" id="acctCurrentPw" autocomplete="current-password"></div>
      <div class="form-field"><label for="acctNewPw">${t("sa_account_new_password")}</label><input type="password" id="acctNewPw" autocomplete="new-password"></div>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnSaveAcctPw">${t("sa_account_change_password")}</button>
    </div>
    <p class="hint" id="acctPwMsg"></p>
  </div>`;

  const avatarFileEl = document.getElementById("acctAvatarFile");
  const avatarMsg = document.getElementById("acctAvatarMsg");
  avatarFileEl.addEventListener("change", async () => {
    const file = avatarFileEl.files[0];
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append("avatar", file);
      const result = await apiUpload("/api/super/upload-avatar", formData);
      CURRENT_USER.avatar_url = result.avatar_url;
      document.getElementById("acctAvatarPreview").innerHTML =
        `<img class="avatar-img" src="${result.avatar_url}" alt="">`;
      renderTopChrome();
      setSuccessMsg(avatarMsg, t("sa_account_avatar_updated"));
    } catch (err) {
      setErrorMsg(avatarMsg, err.message);
    }
  });

  const nameMsg = document.getElementById("acctNameMsg");
  document.getElementById("btnSaveAcctName").onclick = async () => {
    const body = {
      first_name: document.getElementById("acctFirst").value.trim(),
      middle_name: document.getElementById("acctMiddle").value.trim() || null,
      last_name: document.getElementById("acctLast").value.trim(),
    };
    if (!body.first_name || !body.last_name) {
      setErrorMsg(nameMsg, t("sa_zonal_admin_required"));
      return;
    }
    try {
      await apiPost("/api/super/account", body);
      CURRENT_USER.admin_full_name = [
        body.first_name,
        body.middle_name,
        body.last_name,
      ]
        .filter(Boolean)
        .join(" ");
      renderTopChrome();
      setSuccessMsg(nameMsg, t("sa_account_name_updated"));
    } catch (err) {
      setErrorMsg(nameMsg, err.message);
    }
  };

  const pwMsg = document.getElementById("acctPwMsg");
  document.getElementById("btnSaveAcctPw").onclick = async () => {
    const current_password = document.getElementById("acctCurrentPw").value;
    const new_password = document.getElementById("acctNewPw").value;
    if (!current_password || !new_password) {
      setErrorMsg(pwMsg, t("sa_account_password_required"));
      return;
    }
    try {
      await apiPost("/api/super/account", { current_password, new_password });
      document.getElementById("acctCurrentPw").value = "";
      document.getElementById("acctNewPw").value = "";
      setSuccessMsg(pwMsg, t("sa_account_password_updated"));
    } catch (err) {
      setErrorMsg(pwMsg, err.message);
    }
  };
}

/* ---------------- Page router ----------------------------------------- */
function render() {
  if (!navHasPage(activePage)) activePage = "sa_nav_dashboard";
  renderNav();
  renderTopChrome();
  const c = document.getElementById("content");
  if (activePage === "sa_nav_dashboard") {
    c.innerHTML = dashboardSkeletonHTML();
    loadAndRenderDashboard();
  } else if (activePage === "sa_nav_regions") {
    c.innerHTML = regionsSkeletonHTML();
    loadAndRenderRegions();
  } else if (activePage === "sa_nav_zonal_admins") {
    c.innerHTML = zonalAdminsSkeletonHTML();
    loadAndRenderZonalAdmins();
  } else if (activePage === "sa_nav_permissions") {
    c.innerHTML = permissionsSkeletonHTML();
    loadAndRenderPermissions();
  } else if (activePage === "sa_nav_schools") {
    c.innerHTML = schoolsSkeletonHTML();
    loadAndRenderSchools();
  } else if (activePage === "sa_nav_schools_archive") {
    c.innerHTML = archivedSchoolsSkeletonHTML();
    loadAndRenderArchivedSchools();
  } else if (activePage === "sa_nav_grade_mapping") {
    c.innerHTML = gradeMappingSkeletonHTML();
    loadAndRenderGradeMapping();
  } else if (activePage === "sa_nav_streams") {
    c.innerHTML = streamsSkeletonHTML();
    loadAndRenderStreams();
  } else if (activePage === "sa_nav_subjects") {
    c.innerHTML = subjectsSkeletonHTML();
    loadAndRenderSubjects();
  } else if (activePage === "sa_nav_roster") {
    c.innerHTML = rosterSkeletonHTML();
    loadAndRenderRoster();
  } else if (activePage === "sa_nav_emis_roster") {
    c.innerHTML = emisRequestsSkeletonHTML();
    loadAndRenderEmisRequests();
  } else if (activePage === "sa_nav_ease_candidates") {
    c.innerHTML = easeResultsSkeletonHTML();
    loadAndRenderEaseResults();
  } else if (activePage === "sa_nav_audit") {
    c.innerHTML = auditSkeletonHTML();
    loadAndRenderAuditLog();
  } else if (activePage === "sa_nav_super_admins") {
    c.innerHTML = superAdminsSkeletonHTML();
    loadAndRenderSuperAdmins();
  } else if (activePage === "sa_nav_account") {
    c.innerHTML = accountSettingsSkeletonHTML();
    renderAccountSettingsPanel();
  } else c.innerHTML = genericPanel(activePage, "file-text");
}

/* ---------------- Session bootstrap — GET /api/me ---------------------
   guard.js has already bounced us to /login.html if the auth_token
   cookie is missing/invalid; this confirms the account is specifically
   super_admins (not any other role landing on this portal by mistake). */
async function loadCurrentUser() {
  const me = await apiGet("/api/me");
  if (me.role !== "super_admins") {
    handleUnauthorized();
    throw new Error("Not a super admin account");
  }
  CURRENT_USER = me;
  role = "super";
  // Only a restricted ("IT Specialist") account needs this — an
  // unrestricted Owner/IT Lead sees every nav item regardless, same as
  // before this feature existed.
  CURRENT_USER_SUPER_PERMISSIONS = null;
  if (me.is_restricted) {
    try {
      const res = await apiGet("/api/super/account/permissions");
      CURRENT_USER_SUPER_PERMISSIONS = res.permissions;
    } catch (err) {
      CURRENT_USER_SUPER_PERMISSIONS = {};
    }
  }
}

function wireChrome() {
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    if (!(await showConfirm(t("za_logout_confirm")))) return;
    try {
      await apiPost("/api/logout");
    } catch (err) {
      /* best-effort; redirect regardless */
    }
    window.location.href = "/login.html";
  });
  document
    .getElementById("navOpenBtn")
    .addEventListener("click", openMobileNav);
  document
    .getElementById("navCloseBtn")
    .addEventListener("click", closeMobileNav);
  document
    .getElementById("navOverlay")
    .addEventListener("click", closeMobileNav);

  const brandBadgeImg = document.getElementById("brandBadgeImg");
  if (brandBadgeImg) {
    brandBadgeImg.addEventListener("error", () => {
      brandBadgeImg.style.display = "none";
      const fallbackId = brandBadgeImg.dataset.fallbackTarget;
      const fallbackEl = fallbackId
        ? document.getElementById(fallbackId)
        : brandBadgeImg.nextElementSibling;
      if (fallbackEl) fallbackEl.style.display = "flex";
    });
  }
  document.querySelectorAll(".lang-switch-btn[data-lang]").forEach((btn) => {
    btn.addEventListener("click", () => setLang(btn.dataset.lang));
  });

  // Clicking the topbar avatar/name jumps straight to Profile Settings —
  // same destination as the "sa_nav_account" nav item, just a faster
  // path to it since it's the thing right under your thumb.
  const whoBlock = document.getElementById("avatarInit")?.closest(".who");
  if (whoBlock) {
    whoBlock.style.cursor = "pointer";
    whoBlock.addEventListener("click", () => {
      activePage = "sa_nav_account";
      render();
    });
  }
}

let lucideRaf = null;
function scheduleLucideRender() {
  if (lucideRaf) return;
  lucideRaf = requestAnimationFrame(() => {
    lucideRaf = null;
    if (window.lucide) window.lucide.createIcons();
  });
}
new MutationObserver(scheduleLucideRender).observe(document.body, {
  childList: true,
  subtree: true,
});

async function boot() {
  try {
    await loadCurrentUser();
  } catch (err) {
    return;
  }
  // Loaded once up front (not per-screen) so Schools/Subjects/Roster all
  // see the current Stream Setup catalog immediately, same as SCHOOL_LEVELS
  // being a load-time constant — see loadStreamCatalog() above.
  await loadStreamCatalog();
  wireChrome();
  render();
  scheduleLucideRender();
}

window.onSisLangChange = () => {
  if (CURRENT_USER) render();
};
document.addEventListener("DOMContentLoaded", boot);

// Governance layer: WHO may do WHAT, decided by the school's governance model.
//
// Public school   -> staffed through the zonal workflow
//                    (Teacher Development Coordinator proposes / Head of Education approves).
// Private school  -> staffed by its own Managing Director; the zonal office is bypassed for
//                    hiring, appointments and finance. The zone still SUPERVISES it
//                    (every school keeps its zone_id).
//
// Everything in this file is a pure function: no database, no Express. server.js loads the
// school row and the user (from the JWT) and asks userCan(). That keeps the rules in ONE
// place, easy to read and to test (node governance.test.mjs), instead of being scattered
// as if/else through the routes.
//
// The governance model is DERIVED from schools.school_type ('PUBLIC' | 'PRIVATE') — the
// column Super Admin already sets on the School Type dropdown — so there is one source of
// truth, never two columns that could disagree.
//
// Unknown capability, unknown school type, missing user or missing school  ->  DENY.

export const GOVERNANCE_MODELS = Object.freeze({ PUBLIC: "public", PRIVATE: "private" });

export const TITLES = Object.freeze({
  HEAD_OF_EDUCATION: "Head of Education",
  TDC: "Teacher Development Coordinator",
  SUPERVISOR: "Supervisor",
  MANAGING_DIRECTOR: "Managing Director",
  PRINCIPAL: "Principal",
});

// Titles a Managing Director may appoint inside their own school.
export const MD_APPOINTABLE_TITLES = Object.freeze(["Principal", "Admin VP", "Academic VP"]);

// Who is the ONLY channel allowed to staff a school of each model.
export const STAFFING_CHANNEL_BY_MODEL = Object.freeze({
  public: "zonal",
  private: "managing_director",
});

// Finance capabilities that exist for private schools only.
export const PRIVATE_ONLY_FINANCE_CAPABILITIES = Object.freeze(["manage_tuition", "private_payroll"]);

export function governanceModelOf(school) {
  const raw = String(school?.school_type ?? school?.governance_model ?? "").toUpperCase();
  if (raw === "PRIVATE") return GOVERNANCE_MODELS.PRIVATE;
  if (raw === "PUBLIC") return GOVERNANCE_MODELS.PUBLIC;
  return null; // unknown -> every rule below denies
}

// ---- small predicates ----------------------------------------------------
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

const isZonalInZone = (u, s) => u.role === "zonal_admins" && sameId(u.zone_id, s.zone_id);
const isHoe = (u) => u.title === TITLES.HEAD_OF_EDUCATION;
const isTdc = (u) => u.title === TITLES.TDC;
const isSupervisor = (u) => u.title === TITLES.SUPERVISOR;
const isMdOf = (u, s) =>
  u.role === "school_admins" && u.title === TITLES.MANAGING_DIRECTOR && sameId(u.school_id, s.id);
const isPrincipalOf = (u, s) =>
  u.role === "school_admins" && u.title === TITLES.PRINCIPAL && sameId(u.school_id, s.id);
const isFinanceOf = (u, s) => u.role === "finance_users" && sameId(u.school_id, s.id);

// ---- the rules -----------------------------------------------------------
// Each rule: (user, school, model) => boolean, where model is "public" | "private".
export const RULES = Object.freeze({
  // Oversight applies to EVERY school, public or private, in the user's zone.
  // A Supervisor never gets more than inspection. If the caller supplies the
  // supervisor's delegated school list (server.js always does, from
  // zone_admin_schools) the school must also be on it — the system's existing,
  // stricter rule. Without the list it is zone-wide, as in the original spec.
  inspect_school: (u, s) => {
    if (u.role === "super_admins") return true;
    if (!isZonalInZone(u, s)) return false;
    if (isSupervisor(u)) {
      return Array.isArray(u.delegated_school_ids)
        ? u.delegated_school_ids.map(Number).includes(Number(s.id))
        : true;
    }
    return isHoe(u) || isTdc(u);
  },

  // ---- staffing: zonal workflow for public, Managing Director for private ----
  // Direct hire (teacher). HoE always; a TDC only with the delegated permission.
  recruit_staff: (u, s, m) => {
    if (m === "public")
      return isZonalInZone(u, s) && (isHoe(u) || (isTdc(u) && !!u.permissions?.hire_teacher));
    if (m === "private") return isMdOf(u, s);
    return false;
  },
  // Direct appointment of a school admin / Principal / VP.
  appoint_leadership: (u, s, m) => {
    if (m === "public")
      return (
        isZonalInZone(u, s) && (isHoe(u) || (isTdc(u) && !!u.permissions?.appoint_school_admin))
      );
    if (m === "private") return isMdOf(u, s);
    return false;
  },
  // Public workflow only: a TDC proposes, the HoE approves. Private schools have no
  // proposal step — the Managing Director acts directly.
  propose_staff: (u, s, m) => m === "public" && isZonalInZone(u, s) && isTdc(u),
  approve_staff_proposal: (u, s, m) => m === "public" && isZonalInZone(u, s) && isHoe(u),

  // Super Admin sets up the Managing Director when the private school is registered.
  appoint_managing_director: (u, s, m) => m === "private" && u.role === "super_admins",

  // The Managing Director recruits the school's Finance officer (private
  // schools); the Principal does the same at a public school — Finance
  // verifies registration payments everywhere, not just at private
  // schools (tuition itself is the private-only piece, see
  // manage_tuition/private_payroll below).
  recruit_finance: (u, s, m) => {
    if (m === "private") return isMdOf(u, s);
    if (m === "public") return isPrincipalOf(u, s);
    return false;
  },

  // ---- money: private schools only, and only their own finance staff ----
  manage_tuition: (u, s, m) => m === "private" && isFinanceOf(u, s),
  private_payroll: (u, s, m) => m === "private" && isFinanceOf(u, s),
  // Read-only summary for the school's own leadership — same reasoning
  // as recruit_finance above: not private-only.
  view_finance_summary: (u, s, m) => {
    if (m === "private") return isMdOf(u, s) || isPrincipalOf(u, s);
    if (m === "public") return isPrincipalOf(u, s);
    return false;
  },
});

export function userCan(user, capability, school) {
  if (!user || !school) return false;
  const rule = Object.prototype.hasOwnProperty.call(RULES, capability) ? RULES[capability] : null;
  if (!rule) return false; // unknown capability -> deny
  const model = governanceModelOf(school);
  if (!model) return false; // unknown school type -> deny
  return rule(user, school, model) === true;
}

// Are the tuition / payroll modules switched on for this school at all?
export function financeModulesEnabled(school) {
  return governanceModelOf(school) === GOVERNANCE_MODELS.PRIVATE;
}

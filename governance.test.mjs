// Run:  node governance.test.mjs      (no dependencies, no database)
import {
  userCan, governanceModelOf, financeModulesEnabled, RULES,
  STAFFING_CHANNEL_BY_MODEL, PRIVATE_ONLY_FINANCE_CAPABILITIES,
} from "./governance.js";

let pass = 0, fail = 0;
const check = (label, cond) => { cond ? pass++ : fail++; if (!cond) console.log("FAIL  " + label); };

// ---- fixtures -------------------------------------------------------------
const PUB = { id: 10, zone_id: 3, school_type: "PUBLIC" };
const PRV = { id: 20, zone_id: 3, school_type: "PRIVATE" };
const PRV_OTHER_ZONE = { id: 21, zone_id: 9, school_type: "PRIVATE" };
const PUB_OTHER_ZONE = { id: 11, zone_id: 9, school_type: "PUBLIC" };

const hoe = { role: "zonal_admins", title: "Head of Education", zone_id: 3 };
const tdcFull = { role: "zonal_admins", title: "Teacher Development Coordinator", zone_id: 3, permissions: { hire_teacher: true, appoint_school_admin: true, transfer_teacher: true } };
const tdcNone = { role: "zonal_admins", title: "Teacher Development Coordinator", zone_id: 3, permissions: { hire_teacher: false, appoint_school_admin: false } };
const tdcHireOnly = { role: "zonal_admins", title: "Teacher Development Coordinator", zone_id: 3, permissions: { hire_teacher: true, appoint_school_admin: false } };
const supervisor = { role: "zonal_admins", title: "Supervisor", zone_id: 3 };
const supervisorAssigned = { ...supervisor, delegated_school_ids: [20] };
const supervisorOtherAssign = { ...supervisor, delegated_school_ids: [10] };
const hoeOtherZone = { ...hoe, zone_id: 9 };
const md20 = { role: "school_admins", title: "Managing Director", school_id: 20, zone_id: 3 };
const md21 = { role: "school_admins", title: "Managing Director", school_id: 21, zone_id: 9 };
const principal20 = { role: "school_admins", title: "Principal", school_id: 20, zone_id: 3 };
const principal10 = { role: "school_admins", title: "Principal", school_id: 10, zone_id: 3 };
const adminVp20 = { role: "school_admins", title: "Admin VP", school_id: 20, zone_id: 3 };
const fin20 = { role: "finance_users", school_id: 20, zone_id: 3 };
const fin10 = { role: "finance_users", school_id: 10, zone_id: 3 };
const sa = { role: "super_admins" };
const teacher20 = { role: "teachers", school_id: 20 };
const student20 = { role: "students", school_id: 20 };
const guardian = { role: "guardians" };

const can = (u, cap, s) => userCan(u, cap, s);

// ---- 1. governance model derivation --------------------------------------
check("PRIVATE -> private", governanceModelOf({ school_type: "PRIVATE" }) === "private");
check("PUBLIC -> public", governanceModelOf({ school_type: "PUBLIC" }) === "public");
check("lowercase/other spelling tolerated", governanceModelOf({ school_type: "private" }) === "private");
check("governance_model property also understood", governanceModelOf({ governance_model: "public" }) === "public");
check("missing type -> null (deny)", governanceModelOf({}) === null && governanceModelOf(null) === null);
check("garbage type -> null (deny)", governanceModelOf({ school_type: "GOVERNMENT" }) === null);
check("staffing channel map", STAFFING_CHANNEL_BY_MODEL.public === "zonal" && STAFFING_CHANNEL_BY_MODEL.private === "managing_director");

// ---- 2. universal oversight (inspect_school) ------------------------------
check("HoE inspects public school in zone", can(hoe, "inspect_school", PUB));
check("HoE inspects PRIVATE school in zone", can(hoe, "inspect_school", PRV));
check("TDC inspects private school in zone", can(tdcNone, "inspect_school", PRV));
check("Supervisor inspects PUBLIC school (zone match)", can(supervisor, "inspect_school", PUB));
check("Supervisor inspects PRIVATE school (zone match)", can(supervisor, "inspect_school", PRV));
check("Supervisor blocked from a school in ANOTHER zone (public)", !can(supervisor, "inspect_school", PUB_OTHER_ZONE));
check("Supervisor blocked from a school in ANOTHER zone (private)", !can(supervisor, "inspect_school", PRV_OTHER_ZONE));
check("Supervisor with delegation list: assigned private school OK", can(supervisorAssigned, "inspect_school", PRV));
check("Supervisor with delegation list: unassigned school denied", !can(supervisorOtherAssign, "inspect_school", PRV));
check("HoE of another zone cannot inspect", !can(hoeOtherZone, "inspect_school", PRV));
check("Super Admin inspects anything", can(sa, "inspect_school", PRV) && can(sa, "inspect_school", PUB));
check("school staff / students / guardians do not get inspect_school", [md20, principal20, fin20, teacher20, student20, guardian].every((u) => !can(u, "inspect_school", PRV)));

// ---- 3. supervisors have ZERO hiring / finance power ----------------------
const everyCap = Object.keys(RULES).filter((c) => c !== "inspect_school");
for (const s of [PUB, PRV, PRV_OTHER_ZONE]) {
  for (const sup of [supervisor, supervisorAssigned]) {
    for (const cap of everyCap) check(`Supervisor denied ${cap} on ${s.school_type}`, !can(sup, cap, s));
  }
}

// ---- 4. public governance: zonal workflow ---------------------------------
check("public: HoE recruit_staff", can(hoe, "recruit_staff", PUB));
check("public: HoE appoint_leadership", can(hoe, "appoint_leadership", PUB));
check("public: TDC with permission recruits", can(tdcFull, "recruit_staff", PUB));
check("public: TDC without permission cannot recruit directly", !can(tdcNone, "recruit_staff", PUB));
check("public: TDC hire-only can recruit but not appoint", can(tdcHireOnly, "recruit_staff", PUB) && !can(tdcHireOnly, "appoint_leadership", PUB));
check("public: any TDC may PROPOSE", can(tdcNone, "propose_staff", PUB) && can(tdcFull, "propose_staff", PUB));
check("public: HoE may APPROVE proposals", can(hoe, "approve_staff_proposal", PUB));
check("public: TDC may not approve", !can(tdcFull, "approve_staff_proposal", PUB));
check("public: HoE cannot PROPOSE (acts directly)", !can(hoe, "propose_staff", PUB));
check("public: HoE of another zone denied", !can(hoeOtherZone, "recruit_staff", PUB));
check("public: no Managing Director route", !can(md20, "recruit_staff", PUB) && !can({ ...md20, school_id: 10 }, "recruit_staff", PUB));
check("public: Principal cannot recruit or appoint", !can(principal10, "recruit_staff", PUB) && !can(principal10, "appoint_leadership", PUB));

// ---- 5. private governance: Managing Director, zone bypassed --------------
check("private: Managing Director recruits", can(md20, "recruit_staff", PRV));
check("private: Managing Director appoints leadership", can(md20, "appoint_leadership", PRV));
check("private: HoE CANNOT recruit", !can(hoe, "recruit_staff", PRV));
check("private: HoE CANNOT appoint", !can(hoe, "appoint_leadership", PRV));
check("private: fully-delegated TDC CANNOT recruit/appoint", !can(tdcFull, "recruit_staff", PRV) && !can(tdcFull, "appoint_leadership", PRV));
check("private: TDC cannot PROPOSE (no proposal step)", !can(tdcFull, "propose_staff", PRV));
check("private: HoE cannot APPROVE proposals", !can(hoe, "approve_staff_proposal", PRV));
check("private: Super Admin does not recruit staff directly", !can(sa, "recruit_staff", PRV) && !can(sa, "appoint_leadership", PRV));
check("private: MD of ANOTHER private school denied", !can(md21, "recruit_staff", PRV) && !can(md21, "appoint_leadership", PRV));
check("private: Principal / Admin VP cannot recruit or appoint", !can(principal20, "recruit_staff", PRV) && !can(adminVp20, "appoint_leadership", PRV));
check("private: only Super Admin appoints the Managing Director", can(sa, "appoint_managing_director", PRV) && !can(hoe, "appoint_managing_director", PRV) && !can(md20, "appoint_managing_director", PRV));
check("public: no Managing Director appointment at all", !can(sa, "appoint_managing_director", PUB));
check("private: MD recruits Finance", can(md20, "recruit_finance", PRV));
check("private: HoE / Principal / Supervisor cannot recruit Finance", !can(hoe, "recruit_finance", PRV) && !can(principal20, "recruit_finance", PRV) && !can(supervisor, "recruit_finance", PRV));
check("public: nobody recruits Finance", [hoe, tdcFull, md20, principal10, sa].every((u) => !can(u, "recruit_finance", PUB)));
check("MD of another school cannot recruit Finance here", !can(md21, "recruit_finance", PRV));

// ---- 6. financial segmentation --------------------------------------------
for (const cap of PRIVATE_ONLY_FINANCE_CAPABILITIES) {
  check(`${cap}: private finance staff of THIS school allowed`, can(fin20, cap, PRV));
  check(`${cap}: DISABLED for public schools (even for finance staff)`, !can(fin10, cap, PUB) && !can(fin20, cap, PUB));
  check(`${cap}: finance staff of ANOTHER school denied`, !can({ ...fin20, school_id: 999 }, cap, PRV));
  for (const [name, u] of Object.entries({ hoe, tdcFull, supervisor, sa, md20, principal20, adminVp20, teacher20, student20, guardian })) {
    check(`${cap}: ${name} denied on private`, !can(u, cap, PRV));
  }
}
check("finance summary: MD + Principal of the school (private)", can(md20, "view_finance_summary", PRV) && can(principal20, "view_finance_summary", PRV));
check("finance summary: not for other schools' MD / zone / supervisor", !can(md21, "view_finance_summary", PRV) && !can(hoe, "view_finance_summary", PRV) && !can(supervisor, "view_finance_summary", PRV));
check("finance summary: nobody on a public school", [md20, principal10, hoe, sa, fin10].every((u) => !can(u, "view_finance_summary", PUB)));
check("financeModulesEnabled: private only", financeModulesEnabled(PRV) && !financeModulesEnabled(PUB) && !financeModulesEnabled({}));

// ---- 7. fail closed --------------------------------------------------------
check("unknown capability denied (even for Super Admin)", !can(sa, "delete_everything", PRV) && !can(hoe, "", PUB));
check("prototype-key capability denied", !can(sa, "constructor", PRV) && !can(sa, "__proto__", PRV) && !can(sa, "toString", PRV));
check("missing user / school denied", !userCan(null, "inspect_school", PRV) && !userCan(hoe, "inspect_school", null) && !userCan(undefined, "recruit_staff", undefined));
check("school with unknown type denied everywhere", Object.keys(RULES).every((cap) => !can(sa, cap, { id: 1, zone_id: 3, school_type: "???" }) && !can(hoe, cap, { id: 1, zone_id: 3 })));
check("string vs number ids compare correctly", can({ ...md20, school_id: "20" }, "recruit_staff", { ...PRV, id: 20 }));
check("user with no zone cannot inspect via zone match", !can({ role: "zonal_admins", title: "Supervisor", zone_id: null }, "inspect_school", { ...PRV, zone_id: null }));
check("student/teacher/guardian: no governance capability at all", [teacher20, student20, guardian].every((u) => Object.keys(RULES).every((c) => !can(u, c, PRV) && !can(u, c, PUB))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

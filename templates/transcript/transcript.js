/* Fills the Grade 9-12 transcript grid from DATA (injected by the server —
   see renderTranscriptHtml in server.js). Unlike certificate.js (one
   grade/year per page), this template shows up to four grade levels
   side by side, so the row layout is built entirely here rather than
   templated per-token. */

// Canonical subject order matches the school's fixed curriculum list —
// real subject names from the database are matched against this
// (case-insensitively) so scores land in the right row regardless of
// exact capitalization on file. Anything in the data that doesn't
// match gets appended as an extra row rather than silently dropped.
const CANONICAL_SUBJECTS = [
  "Nuer/Dha-Anywaa", "Federal language", "English", "Mathematics", "Physics",
  "Chemistry", "Biology", "Economics", "Geography", "History",
  "Citizenship", "Agriculture", "ICT", "Physical Education"
];

const GRADE_LEVELS = [9, 10, 11, 12];

function norm(s) {
  return (s || "").toString().trim().toLowerCase();
}

function fmt(v) {
  return (v === null || v === undefined || v === "") ? "" : v;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function fillSlot(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || "";
}

const yearByLevel = {};
(DATA.years || []).forEach(y => { yearByLevel[y.class_level] = y; });

// --- Header fields ---
fillSlot("f-student-id", DATA.student_id);
fillSlot("f-student-name", DATA.student_name);
fillSlot("f-stream", DATA.stream);
fillSlot("f-sex", DATA.sex);
fillSlot("f-age", DATA.age);
fillSlot("f-date-admission", DATA.date_of_admission);
fillSlot("f-date-leaving", DATA.date_of_leaving);
fillSlot("f-registrar-name", DATA.registrar_name);
fillSlot("f-issue-date", DATA.issue_date);

GRADE_LEVELS.forEach(level => {
  const y = yearByLevel[level];
  fillSlot(`yr-header-${level}`, y && y.ec_year ? `${y.ec_year} E.C` : "20___ E.C");
});

if (DATA.photo_data_uri) {
  const box = document.getElementById("photo-box");
  if (box) box.innerHTML = `<img src="${DATA.photo_data_uri}" alt="" style="width:100%;height:100%;object-fit:cover;">`;
}

// --- Subject rows ---
function subjectScoresForLevel(y, subjectName) {
  if (!y) return { s1: "", s2: "", avg: "" };
  const found = (y.subjects || []).find(s => norm(s.name) === norm(subjectName));
  if (!found) return { s1: "", s2: "", avg: "" };
  const avg = (found.s1 != null && found.s2 != null) ? round1((found.s1 + found.s2) / 2) : "";
  return { s1: fmt(found.s1), s2: fmt(found.s2), avg };
}

function buildDataRow(label, cellsForLevel, remark) {
  const cells = GRADE_LEVELS.map(level => {
    const c = cellsForLevel(level) || { s1: "", s2: "", avg: "" };
    return `<td>${fmt(c.s1)}</td><td>${fmt(c.s2)}</td><td>${fmt(c.avg)}</td>`;
  }).join("");
  return `<tr><td class="subject-col">${label}</td>${cells}<td>${remark || ""}</td></tr>`;
}

const rows = [];

CANONICAL_SUBJECTS.forEach(name => {
  rows.push(buildDataRow(name, level => subjectScoresForLevel(yearByLevel[level], name)));
});

// Any real subject names in the data that don't match the canonical
// list (e.g. an elective specific to this school) still get a row,
// appended after the standard curriculum rows, rather than being
// dropped from the printed transcript.
const seenNames = new Set(CANONICAL_SUBJECTS.map(norm));
const extraNames = new Set();
(DATA.years || []).forEach(y => (y.subjects || []).forEach(s => {
  if (!seenNames.has(norm(s.name))) extraNames.add(s.name);
}));
extraNames.forEach(name => {
  rows.push(buildDataRow(name, level => subjectScoresForLevel(yearByLevel[level], name)));
});

// --- Meta rows: Absent / Conduct / Total / Average / Rank ---
rows.push(buildDataRow("Absent", level => {
  const y = yearByLevel[level];
  if (!y) return { s1: "", s2: "", avg: "" };
  const total = (y.days_absent_s1 ?? 0) + (y.days_absent_s2 ?? 0);
  return { s1: fmt(y.days_absent_s1), s2: fmt(y.days_absent_s2), avg: total || "" };
}));

// Conduct isn't currently tracked as data in the system — left blank
// rather than guessed at.
rows.push(buildDataRow("Conduct", () => ({ s1: "", s2: "", avg: "" })));

rows.push(buildDataRow("Total", level => {
  const y = yearByLevel[level];
  if (!y) return { s1: "", s2: "", avg: "" };
  return { s1: fmt(y.total_s1), s2: fmt(y.total_s2), avg: "" };
}));

rows.push(buildDataRow("Average", level => {
  const y = yearByLevel[level];
  if (!y) return { s1: "", s2: "", avg: "" };
  return { s1: fmt(y.avg_s1), s2: fmt(y.avg_s2), avg: fmt(y.avg_year) };
}));

rows.push(buildDataRow("Rank", level => {
  const y = yearByLevel[level];
  if (!y || y.rank == null) return { s1: "", s2: "", avg: "" };
  return { s1: "", s2: "", avg: `${y.rank} / ${y.class_size}` };
}));

document.getElementById("transcript-body").innerHTML = rows.join("");
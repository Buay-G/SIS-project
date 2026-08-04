/* Fills the Grade 9-12 transcript grid from DATA (injected by the server —
   see renderTranscriptHtml/buildYearSummaries in server.js). Unlike
   certificate.js (one grade/year per page), this template shows up to
   four grade levels side by side, so the row layout is built entirely
   here rather than templated per-token.

   Subject rows come entirely from DATA — the school's own Subject
   Configuration (same source the report card reads), not a fixed
   hardcoded curriculum list. A subject's row spans all four years; each
   year's own three columns (S1/S2/AV) get struck through independently
   when that subject doesn't apply to that particular year's stream
   (DATA.years[].subjects[].applicable === false) — a row can be a mix
   of real scores in one year and a struck-through gap in another, since
   a student's stream can change year to year (e.g. General in Grade
   9/10, Natural Science from Grade 11 on). */

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
// The row set is the union of subject names across every year present,
// sorted alphabetically (matching Subject Configuration's own
// ordering) — a subject configured for only one year's stream still
// gets its own row spanning the whole table, blank/struck-through in
// the years it doesn't apply to.
const subjectNames = [...new Set(
  (DATA.years || []).flatMap(y => (y.subjects || []).map(s => s.name))
)].sort((a, b) => a.localeCompare(b));

// applicable === false -> struck through, blank cells (configured, but
// not for this year's stream). applicable === true, or missing
// entirely for backward compatibility with data that predates this
// flag -> a normal cell. Not found in that year at all (the subject
// didn't exist in configuration then) -> a plain blank cell, no
// strikethrough, since that's simply not information we have.
function subjectScoresForLevel(y, subjectName) {
  if (!y) return { s1: "", s2: "", avg: "", applicable: null };
  const found = (y.subjects || []).find(s => norm(s.name) === norm(subjectName));
  if (!found) return { s1: "", s2: "", avg: "", applicable: null };
  const applicable = found.applicable !== false;
  const avg = (applicable && found.s1 != null && found.s2 != null) ? round1((found.s1 + found.s2) / 2) : "";
  return {
    s1: applicable ? fmt(found.s1) : "",
    s2: applicable ? fmt(found.s2) : "",
    avg,
    applicable
  };
}

function buildDataRow(label, cellsForLevel, remark) {
  const cells = GRADE_LEVELS.map(level => {
    const c = cellsForLevel(level) || { s1: "", s2: "", avg: "", applicable: null };
    const notApplicable = c.applicable === false;
    const cls = notApplicable ? ' class="not-applicable"' : "";
    // A plain empty <td> has no text for text-decoration:line-through to
    // strike through, so a not-applicable cell and a not-yet-graded one
    // were rendering identically (both just blank). A visible dash gives
    // the strikethrough something to draw through and makes the two
    // states distinguishable at a glance.
    return `<td${cls}>${notApplicable ? "—" : fmt(c.s1)}</td><td${cls}>${notApplicable ? "—" : fmt(c.s2)}</td><td${cls}>${notApplicable ? "—" : fmt(c.avg)}</td>`;
  }).join("");
  return `<tr><td class="subject-col">${label}</td>${cells}<td>${remark || ""}</td></tr>`;
}

const rows = [];

subjectNames.forEach(name => {
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
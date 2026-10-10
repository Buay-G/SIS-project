/* Fills the Grade 9-12 transcript grid from DATA (injected by the server —
   see renderTranscriptHtml/buildYearSummaries in server.js). Unlike
   certificate.js (one grade/year per page), this template shows up to
   four grade levels as separate blocks (9th & 10th on the top row, 11th
   & 12th below), built entirely here rather than templated per-token.

   Subject rows come entirely from DATA — the school's own Subject
   Configuration (same source the report card reads), not a fixed
   hardcoded curriculum list. A subject's row spans all four years; each
   year's own three columns (S1/S2/AV) get struck through independently
   when that subject doesn't apply to that particular year's stream
   (DATA.years[].subjects[].applicable === false) — a row can be a mix
   of real scores in one year and a struck-through gap in another, since
   a student's stream can change year to year (e.g. General in Grade
   9/10, Natural Science or Social Science from Grade 11 on). */

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

function fillImage(id, dataUri, alt) {
  const el = document.getElementById(id);
  if (el && dataUri) el.innerHTML = `<img src="${dataUri}" alt="${alt || ''}">`;
}

const yearByLevel = {};
(DATA.years || []).forEach(y => { yearByLevel[y.class_level] = y; });

// --- Header fields ---
fillSlot("f-student-id", DATA.student_id);
fillSlot("f-student-name", DATA.student_name);
// Stream is shown exactly as the school system stores it — the full
// descriptive label ("General" / "Natural Science" / "Social Science"),
// never an abbreviation.
fillSlot("f-stream", DATA.stream);
fillSlot("f-sex", DATA.sex);
fillSlot("f-date-admission", DATA.date_of_admission);
fillSlot("f-date-leaving", DATA.date_of_leaving);
fillSlot("f-registrar-name", DATA.registrar_name);
fillSlot("f-registrar-date", DATA.issue_date);
fillSlot("f-principal-name", DATA.principal_name);
fillSlot("f-principal-date", DATA.issue_date);
fillSlot("farewell-note", DATA.farewell_message);

// School name = school name + school level combined (e.g. "NEWLAND
// SECONDARY SCHOOL"), same combination the report card/certificate/ID
// card use — computed server-side (school_display_name) so every
// document capitalizes and joins it identically in one place.
fillSlot("f-school-name", DATA.school_display_name || DATA.school_name);
fillSlot("f-school-name-amh", DATA.school_name_amh);

// Zone logo watermark — the logo the Super/Zonal Admin uploaded for the
// zone this school belongs to; stays hidden when the zone has none.
if (DATA.zone_logo_data_uri) {
  const wm = document.getElementById("zone-watermark");
  if (wm) { wm.src = DATA.zone_logo_data_uri; wm.hidden = false; }
}

if (DATA.photo_data_uri) {
  const box = document.getElementById("photo-box");
  if (box) box.innerHTML = `<img src="${DATA.photo_data_uri}" alt="">`;
}

// Registrar/Principal signature images and the Principal's uploaded
// school seal — each falls back to its existing placeholder (blank
// underline / dashed "Seal" ring) when nothing's on file, same
// graceful-degradation the report card and certificate already use.
fillImage("f-registrar-sign", DATA.registrar_signature_data_uri, "Registrar signature");
fillImage("f-principal-sign", DATA.principal_signature_data_uri, "Principal signature");
if (DATA.school_seal_data_uri) {
  const seal = document.getElementById("school-seal");
  if (seal) seal.innerHTML = `<img src="${DATA.school_seal_data_uri}" alt="School seal">`;
}

// Verification QR code, below the student photo — encodes the same
// verify_url the printed footer/other documents' QR codes use, so
// scanning it opens this transcript's verification page.
if (DATA.verify_url && typeof qrcode !== "undefined") {
  const qrBox = document.getElementById("qr-code");
  if (qrBox) {
    try {
      const qr = qrcode(0, "M");
      qr.addData(DATA.verify_url);
      qr.make();
      qrBox.innerHTML = qr.createSvgTag({ scalable: true });
    } catch (err) {
      console.error("QR render failed:", err);
    }
  }
}

// --- Grade blocks ---
// Each grade level gets its own block (9th & 10th on the top row, 11th &
// 12th below), built from THAT year's own record: its stream
// (DATA.years[].stream) and its own subject list. Grades 9/10 therefore
// share one subject set, while 11/12 follow the student's Natural or
// Social Science stream. Subjects flagged applicable === false for that
// year's stream are simply left out of the block, so no strike-through
// is needed any more.
//
// A grade with no record at all (never enrolled here that year) still
// gets a block, with empty rows and one red diagonal drawn by CSS
// (.not-attended). Its row labels are borrowed from its paired grade
// (9<->10, 11<->12) when that one exists, so the empty block still
// lines up with its neighbour.
const SIBLING = { 9: 10, 10: 9, 11: 12, 12: 11 };
const BLANK_ROWS = 12;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]
  ));
}

function cell(v) { return `<td>${esc(fmt(v))}</td>`; }

function subjectRowsFor(level) {
  const y = yearByLevel[level];
  const src = y || yearByLevel[SIBLING[level]];
  if (!src) return Array.from({ length: BLANK_ROWS }, () => '<tr><td class="subject-col"></td><td></td><td></td><td></td></tr>');
  return (src.subjects || [])
    .filter(s => s.applicable !== false)
    .map(s => s.name)
    .sort((a, b) => a.localeCompare(b))
    .map(name => {
      const found = y && (y.subjects || []).find(s => norm(s.name) === norm(name));
      const s1 = found ? found.s1 : "";
      const s2 = found ? found.s2 : "";
      const avg = (found && found.s1 != null && found.s2 != null) ? round1((found.s1 + found.s2) / 2) : "";
      return `<tr><td class="subject-col">${esc(name)}</td>${cell(s1)}${cell(s2)}${cell(avg)}</tr>`;
    });
}

// Absent / Total / Average / Rank — same green "meta-row" band as before.
// (Conduct is still left off: it isn't tracked anywhere in the system, so
// it would only print as a permanently blank row.)
function summaryRowsFor(level) {
  const y = yearByLevel[level];
  const row = (label, a, b, c) =>
    `<tr class="meta-row"><td class="subject-col">${label}</td>${cell(a)}${cell(b)}${cell(c)}</tr>`;
  if (!y) {
    return row("Absent", "", "", "") + row("Total", "", "", "") + row("Average", "", "", "") +
      '<tr class="meta-row"><td class="subject-col">Rank</td><td colspan="3"></td></tr>';
  }
  const absentTotal = (y.days_absent_s1 ?? 0) + (y.days_absent_s2 ?? 0);
  // One rank applies to the whole year, so it is a single merged cell.
  const rank = (y.rank != null) ? `${y.rank} / ${y.class_size}` : "";
  return row("Absent", y.days_absent_s1, y.days_absent_s2, absentTotal || "") +
    row("Total", y.total_s1, y.total_s2, "") +
    row("Average", y.avg_s1, y.avg_s2, y.avg_year) +
    `<tr class="meta-row"><td class="subject-col">Rank</td><td colspan="3">${esc(rank)}</td></tr>`;
}

const COLGROUP = '<colgroup><col class="c-sub"><col><col><col></colgroup>';

function buildGradeBlock(level) {
  const y = yearByLevel[level];
  const year = y && y.ec_year ? `${esc(y.ec_year)} E.C` : "20___ E.C";
  const stream = y ? esc(y.stream || "") : "—";
  return `<div class="grade-block${y ? "" : " not-attended"}">
    <div class="gb-head"><span>${year}</span><span>Grade ${level}</span></div>
    <div class="gb-stream"><span>Stream</span><span>${stream}</span></div>
    <div class="gb-subjects">
      <table class="gb-table">${COLGROUP}
        <thead><tr><th class="subject-col">Subjects</th><th>I</th><th>II</th><th>AV</th></tr></thead>
        <tbody>${subjectRowsFor(level).join("")}</tbody>
      </table>
    </div>
    <table class="gb-table">${COLGROUP}<tbody>${summaryRowsFor(level)}</tbody></table>
  </div>`;
}

document.getElementById("grade-grid").innerHTML = GRADE_LEVELS.map(buildGradeBlock).join("");

// --- Fit the whole document onto exactly one printed page ---
// The subject rows come from each school's own Subject Configuration
// (see the comment atop this file), so the transcript's total height
// isn't fixed — a school with a long subject list can end up taller
// than a single A4 page's printable area. Rather than letting that
// spill onto a second sheet or clipping content, shrink the whole page
// down uniformly (one transform: scale()) just enough to fit — but
// only when it's actually needed, so a short transcript still prints
// at its normal, more readable size.
//
// server.js calls page.emulateMediaType('print') before setContent, so
// print CSS (and this measurement) reflects the real print layout, not
// the on-screen one — same reasoning drawNotAttendedLines above relies
// on for its own positions.
function fitToOnePage() {
  const wrap = document.getElementById("page-scale-wrap");
  const page = document.querySelector(".page");
  const grid = document.getElementById("grade-grid");
  if (!wrap || !page) return;

  // Reset from any earlier pass before re-measuring.
  page.style.transform = "";
  wrap.style.height = "";
  if (grid) grid.style.removeProperty("--u");

  // A4's 297mm minus @page's 4mm top+bottom margin, converted to real
  // pixels with a throwaway probe instead of a hardcoded constant.
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute; visibility:hidden; height:289mm; width:0;";
  document.body.appendChild(probe);
  const targetHeightPx = probe.getBoundingClientRect().height;
  document.body.removeChild(probe);
  if (!targetHeightPx) return;

  const height = () => page.getBoundingClientRect().height;
  if (height() <= targetHeightPx) return; // already fits at normal size

  // 1) Shrink the font size and row height of the grade blocks, a little
  //    at a time, until the page fits ONE sheet. A longer subject list
  //    just gets smaller type instead of a second page.
  const MIN_U = 0.45;
  let u = 1;
  while (grid && height() > targetHeightPx && u > MIN_U) {
    u = Math.round((u - 0.02) * 100) / 100;
    grid.style.setProperty("--u", u);
  }

  // 2) Last resort (an extreme subject count): scale the whole page the
  //    rest of the way. Together with the print clip in transcript.css,
  //    this means a second page can never be produced.
  const actual = height();
  if (actual > targetHeightPx) {
    page.style.transform = `scale(${targetHeightPx / actual})`;
    wrap.style.height = `${targetHeightPx}px`;
  }
}

fitToOnePage();
// Also covers a registrar previewing/printing this file directly from
// a browser (rather than via the server's Puppeteer route), where
// print CSS only becomes active during the actual print action.
window.addEventListener("beforeprint", fitToOnePage);
window.addEventListener("afterprint", () => {
  const wrap = document.getElementById("page-scale-wrap");
  const page = document.querySelector(".page");
  const grid = document.getElementById("grade-grid");
  if (page) page.style.transform = "";
  if (wrap) wrap.style.height = "";
  if (grid) grid.style.removeProperty("--u");
});
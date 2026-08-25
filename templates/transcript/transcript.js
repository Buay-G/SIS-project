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

GRADE_LEVELS.forEach(level => {
  const y = yearByLevel[level];
  fillSlot(`yr-header-${level}`, y && y.ec_year ? `${y.ec_year} E.C` : "20___ E.C");
});

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
// not for this year's stream — e.g. a Natural Science-only subject in a
// Social Science year, or vice versa, for a Grade 11/12 student).
// applicable === true, or missing entirely for backward compatibility
// with data that predates this flag -> a normal cell. Not found in that
// year at all (the subject didn't exist in configuration then) -> a
// plain blank cell, no strikethrough, since that's simply not
// information we have.
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

function buildDataRow(label, cellsForLevel, rowClass) {
  const cells = GRADE_LEVELS.map(level => {
    // No record at all for this grade — the student was never
    // enrolled here that year (e.g. transferred out after Grade 9, so
    // Grades 10/11/12 simply never happened for them at this school).
    // This is a different situation from a subject that's merely not
    // offered in their stream (the gray double-strike below), so it's
    // marked "not-attended" instead — checked first, before
    // cellsForLevel() even runs, so it applies uniformly to subject
    // rows AND the Absent/Total/Average rows that share this builder.
    // data-level/data-sub let drawNotAttendedLines() find exactly
    // which cell is which column afterward — the class itself carries
    // no visual style; the single diagonal line per column is drawn
    // separately, on the SVG overlay.
    if (!yearByLevel[level]) {
      return [0, 1, 2].map(sub => `<td class="not-attended" data-level="${level}" data-sub="${sub}"></td>`).join("");
    }
    const c = cellsForLevel(level) || { s1: "", s2: "", avg: "", applicable: null };
    const notApplicable = c.applicable === false;
    const cls = notApplicable ? ' class="not-applicable"' : "";
    // A plain empty <td> has no text for text-decoration:line-through to
    // strike through, so a not-applicable cell and a not-yet-graded one
    // were rendering identically (both just blank). A visible dash gives
    // the double-line strikethrough something to draw through and makes
    // the two states distinguishable at a glance.
    return `<td${cls}>${notApplicable ? "—" : fmt(c.s1)}</td><td${cls}>${notApplicable ? "—" : fmt(c.s2)}</td><td${cls}>${notApplicable ? "—" : fmt(c.avg)}</td>`;
  }).join("");
  const trCls = rowClass ? ` class="${rowClass}"` : "";
  return `<tr${trCls}><td class="subject-col">${label}</td>${cells}</tr>`;
}

// Rank gets its own row builder: a single rank applies to the whole
// year, not per-semester, so it's one merged cell spanning that year's
// I/II/AV columns (colspan="3") rather than two blank cells plus a
// value — matching how the school actually reads a year's rank.
function buildRankRow(label, rowClass) {
  const cells = GRADE_LEVELS.map(level => {
    const y = yearByLevel[level];
    if (!y) return `<td class="not-attended" data-level="${level}" data-sub="merged" colspan="3"></td>`;
    const val = (y.rank != null) ? `${y.rank} / ${y.class_size}` : "";
    return `<td colspan="3">${val}</td>`;
  }).join("");
  const trCls = rowClass ? ` class="${rowClass}"` : "";
  return `<tr${trCls}><td class="subject-col">${label}</td>${cells}</tr>`;
}

const rows = [];

subjectNames.forEach(name => {
  rows.push(buildDataRow(name, level => subjectScoresForLevel(yearByLevel[level], name)));
});

// --- Meta rows: Absent / Total / Average / Rank ---
// (Conduct dropped — it isn't tracked as data anywhere in the system,
// so it only ever rendered as a permanently blank row; better to leave
// it off than print an empty line on every transcript.)
// All four get the "meta-row" class so CSS fills them with the same
// green as the header band, setting them apart from ordinary subject
// rows.
rows.push(buildDataRow("Absent", level => {
  const y = yearByLevel[level];
  if (!y) return { s1: "", s2: "", avg: "" };
  const total = (y.days_absent_s1 ?? 0) + (y.days_absent_s2 ?? 0);
  return { s1: fmt(y.days_absent_s1), s2: fmt(y.days_absent_s2), avg: total || "" };
}, "meta-row"));

rows.push(buildDataRow("Total", level => {
  const y = yearByLevel[level];
  if (!y) return { s1: "", s2: "", avg: "" };
  return { s1: fmt(y.total_s1), s2: fmt(y.total_s2), avg: "" };
}, "meta-row"));

rows.push(buildDataRow("Average", level => {
  const y = yearByLevel[level];
  if (!y) return { s1: "", s2: "", avg: "" };
  return { s1: fmt(y.avg_s1), s2: fmt(y.avg_s2), avg: fmt(y.avg_year) };
}, "meta-row"));

rows.push(buildRankRow("Rank", "meta-row"));

document.getElementById("transcript-body").innerHTML = rows.join("");

// For each grade the student has no record for at all, draw ONE
// continuous diagonal line per column (I/II/AV) spanning just the
// subject rows — from the top of the first subject row down to the top
// of the Absent row, stopping there rather than continuing through the
// Absent/Total/Average/Rank summary band. Needs real pixel positions,
// so it runs after the rows above are actually in the DOM and laid
// out; getBoundingClientRect forces that layout pass.
function drawNotAttendedLines() {
  const svg = document.getElementById("not-attended-lines");
  const wrap = document.querySelector(".table-wrap");
  const tbody = document.getElementById("transcript-body");
  if (!svg || !wrap || !tbody) return;

  const bodyRows = tbody.querySelectorAll("tr");
  if (bodyRows.length === 0) return;
  const firstRow = bodyRows[0];
  // The Absent row is the first ".meta-row" — its own top edge is the
  // same for every column, so it's the one number every line needs,
  // regardless of which grade/column it belongs to.
  const firstMetaRow = tbody.querySelector("tr.meta-row");

  const wrapRect = wrap.getBoundingClientRect();
  svg.setAttribute("width", wrapRect.width);
  svg.setAttribute("height", wrapRect.height);
  svg.setAttribute("viewBox", `0 0 ${wrapRect.width} ${wrapRect.height}`);

  const strokeColor = getComputedStyle(document.documentElement).getPropertyValue("--danger").trim() || "#c22";
  const bottomY = firstMetaRow
    ? firstMetaRow.getBoundingClientRect().top - wrapRect.top
    : (bodyRows[bodyRows.length - 1].getBoundingClientRect().bottom - wrapRect.top);

  GRADE_LEVELS.forEach(level => {
    if (yearByLevel[level]) return; // this grade has a real record — nothing to draw

    // The first subject row always has 3 separate not-attended cells
    // for a missing grade (one per I/II/AV) — their edges give each
    // line's exact horizontal band.
    const topCells = firstRow.querySelectorAll(`td.not-attended[data-level="${level}"]`);
    if (topCells.length === 0) return;

    topCells.forEach(cell => {
      const r = cell.getBoundingClientRect();
      // Corner-to-corner within the cell's own width — top-left of the
      // first row down to bottom-right just above the Absent row — so
      // the line stays inside its own column's band instead of
      // crossing into the next one, matching a single clean diagonal
      // stroke rather than a strictly vertical line.
      const x1 = (r.left - wrapRect.left) + r.width * 0.2;
      const y1 = r.top - wrapRect.top;
      const x2 = (r.left - wrapRect.left) + r.width * 0.8;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", x1);
      line.setAttribute("y1", y1);
      line.setAttribute("x2", x2);
      line.setAttribute("y2", bottomY);
      line.setAttribute("stroke", strokeColor);
      line.setAttribute("stroke-width", "1.3");
      svg.appendChild(line);
    });
  });
}

drawNotAttendedLines();

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
  if (!wrap || !page) return;

  // Reset from any earlier pass (e.g. a browser's own beforeprint/
  // afterprint cycle re-running this) before re-measuring.
  page.style.transform = "";
  wrap.style.height = "";

  // Convert the @page rule's printable content height (A4's 297mm
  // minus its own 4mm top+bottom margin — see the @page rule in
  // transcript.css) into real pixels via a throwaway probe element,
  // rather than a hardcoded mm-to-px constant, so this keeps working
  // correctly if @page's size/margin ever changes.
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute; visibility:hidden; height:289mm; width:0;";
  document.body.appendChild(probe);
  const targetHeightPx = probe.getBoundingClientRect().height;
  document.body.removeChild(probe);

  const actualHeightPx = page.getBoundingClientRect().height;
  if (!targetHeightPx || actualHeightPx <= targetHeightPx) return; // already fits at natural size

  const scale = targetHeightPx / actualHeightPx;
  page.style.transform = `scale(${scale})`;
  // transform only shrinks how the box LOOKS, not the layout footprint
  // it still occupies — without collapsing the wrapper to the scaled
  // height, the print engine would keep reserving the original,
  // unscaled height and add a blank second page under the shrunk one.
  wrap.style.height = `${targetHeightPx}px`;
}

fitToOnePage();
// Also covers a registrar previewing/printing this file directly from
// a browser (rather than via the server's Puppeteer route), where
// print CSS only becomes active during the actual print action.
window.addEventListener("beforeprint", fitToOnePage);
window.addEventListener("afterprint", () => {
  const wrap = document.getElementById("page-scale-wrap");
  const page = document.querySelector(".page");
  if (page) page.style.transform = "";
  if (wrap) wrap.style.height = "";
});
const SUBJECTS = DATA.subjects;
const CONDUCT_S1 = DATA.conduct_s1;
const CONDUCT_S2 = DATA.conduct_s2;
const CONDUCT_YEAR = DATA.conduct_year;
const ABSENT_DAYS_S1 = DATA.absent_days_s1;
const ABSENT_DAYS_S2 = DATA.absent_days_s2;
const RANK = DATA.rank;
const CLASS_SIZE = DATA.class_size;

function descriptor(v){
  if (v == null) return "";
  if (v >= 90) return "Excellent";
  if (v >= 80) return "Very Good";
  if (v >= 60) return "Satisfactory";
  if (v >= 50) return "Fair";
  return "Poor";
}
// 1st, 2nd, 3rd, 4th, 11th–13th special-cased, 21st, 22nd, 23rd, ...
function ordinal(n){
  if (n == null) return "";
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}
const fmt = v => v == null ? '<span class="score na">—</span>' : `<span class="score">${v}</span>`;
const r1 = n => Math.round(n * 10) / 10;
// Every "Average" value on the sheet — the per-subject Average column
// and the summary Average row — is shown to one decimal place with a
// "%" sign (e.g. "94.5%"), never a bare/rounded-off integer. Marks
// themselves (S1, S2, Total) are literal point totals, not
// percentages, so they're left as plain numbers.
const pct = n => n == null ? null : `${Number(n).toFixed(1)}%`;
// Some subjects won't have an Amharic name on file — omit the "/ ..."
// half rather than printing "/ undefined" or a blank slash.
const subjLabel = s => s.amh
  ? `<span class="en">${s.en}</span> <span class="amh">/ ${s.amh}</span>`
  : `<span class="en">${s.en}</span>`;

const taken = SUBJECTS.filter(s => s.applicable !== false && s.s1 != null && s.s2 != null);
const sum = (arr, fn) => arr.reduce((t,s)=>t + fn(s), 0);
const s1Total = sum(taken, s => s.s1);
const s2Total = sum(taken, s => s.s2);
// Total row's 3rd column is the grand total (S1 + S2 marks summed) —
// a plain point sum, not a percentage, matching how the Days Absent
// row's 3rd column is already just S1 + S2 with no "%". The Average
// *row* below is where the /% figures belong (mean-of-marks, not a
// sum), and that's kept as a separate calculation (s1Avg/s2Avg/yearAvg).
const grandTotal = s1Total + s2Total;
// No subject has both semesters scored yet (a freshly-issued sheet
// before marks are synced) — s1Total/taken.length would be 0/0 = NaN,
// which does two bad things downstream: it prints the literal text
// "NaN" on the document, and descriptor(NaN) falls through every
// `>=` check (NaN comparisons are always false) to the LAST branch,
// mislabeling a student with zero data as "Poor" rather than showing
// nothing is on file yet. Treating "no subjects taken" as null instead
// of computing keeps both the totals row and the rating row honest —
// same "print blank rather than fabricate/misreport" rule the rest of
// this sheet already follows for missing scores.
const s1Avg = taken.length ? s1Total / taken.length : null;
const s2Avg = taken.length ? s2Total / taken.length : null;
const yearAvg = (s1Avg != null && s2Avg != null) ? (s1Avg + s2Avg) / 2 : null;
const naDash = v => v == null ? '—' : v;

let rows = SUBJECTS.map(s => {
  // A subject flagged not-applicable (outside the student's stream) is
  // shown for context but never carries a score, even if a stray mark
  // exists for it in the data — that mark shouldn't have been entered
  // for this student's stream in the first place.
  const applicable = s.applicable !== false;
  const s1 = applicable ? s.s1 : null;
  const s2 = applicable ? s.s2 : null;
  const avg = (s1 != null && s2 != null) ? r1((s1 + s2)/2) : null;
  return `<tr${applicable ? '' : ' class="not-applicable"'}>
    <td class="subject">${subjLabel(s)}</td>
    <td>${fmt(s1)}</td>
    <td>${fmt(s2)}</td>
    <td>${avg != null ? `<span class="score">${pct(avg)}</span>` : '<span class="score na">—</span>'}</td>
    <td class="rating">${avg != null ? descriptor(avg) : '—'}</td>
  </tr>`;
}).join("");

// Same null-vs-zero distinction as the averages above: if BOTH semesters'
// absence counts are unrecorded, the total is "not on file", not
// literally zero days absent — those mean different things on a report
// card, so don't collapse them.
const absentTotal = (ABSENT_DAYS_S1 == null && ABSENT_DAYS_S2 == null) ? null : (ABSENT_DAYS_S1 ?? 0) + (ABSENT_DAYS_S2 ?? 0);

rows += `<tr class="summary">
    <td class="subject">Total <span class="amh">/ ድምር</span></td>
    <td>${naDash(taken.length ? s1Total : null)}</td><td>${naDash(taken.length ? s2Total : null)}</td><td>${naDash(taken.length ? grandTotal : null)}</td><td class="rating">—</td>
  </tr>
  <tr class="summary">
    <td class="subject">Average <span class="amh">/ አማካይ</span></td>
    <td>${s1Avg != null ? pct(r1(s1Avg)) : '—'}</td><td>${s2Avg != null ? pct(r1(s2Avg)) : '—'}</td><td>${yearAvg != null ? pct(r1(yearAvg)) : '—'}</td>
    <td class="rating">${yearAvg != null ? descriptor(yearAvg) : '—'}</td>
  </tr>
  <tr>
    <td class="subject">Conduct <span class="amh">/ ስነ ምግባር</span></td>
    <td>${CONDUCT_S1 || '—'}</td><td>${CONDUCT_S2 || '—'}</td><td>${CONDUCT_YEAR || '—'}</td><td class="rating">—</td>
  </tr>
  <tr>
    <td class="subject">Days Absent <span class="amh">/ የቀሩበት ቀናት</span></td>
    <td>${ABSENT_DAYS_S1 ?? '—'}</td><td>${ABSENT_DAYS_S2 ?? '—'}</td><td>${naDash(absentTotal)}</td><td class="rating">—</td>
  </tr>
  <tr class="rank">
    <td class="subject">Rank <span class="amh">/ ደረጃ</span></td>
    <td colspan="4">${RANK != null ? `${ordinal(RANK)} out of ${CLASS_SIZE}` : '—'}</td>
  </tr>`;

document.getElementById("marks-body").innerHTML = rows;

// Sizing for the student-info panel, header, and table type is deliberately
// larger by default (see certificate.css) so a report card with few
// subjects doesn't leave a mostly-blank page. A student with a long
// subject list (a full 14-item stream sheet is the realistic max) needs
// noticeably tighter rows for everything to still fit on one printed
// page, though — the same font size that looks right for 6 rows runs
// well past one page at 14. This class is the switch between those two
// cases; certificate.css's print rules define what "compact" tightens.
// The threshold is set below the realistic max (14) with headroom, not
// at it, since summary rows (Total/Average/Conduct/Days Absent/Rank)
// add to the printed row count too, on top of the subject rows.
document.body.classList.toggle("many-subjects", SUBJECTS.length > 9);

/* ===================== QR Code generator ===================== */
/* Self-contained QR encoder (byte mode, algorithmic — no external library).
   Based on the public-domain Project Nayuki QR Code generator. */
const qrcodegen = (function(){
  function appendBits(val, len, bb){
    for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
  }
  function getBit(x, i){ return ((x >>> i) & 1) !== 0; }

  const Ecc = {
    LOW:      { ordinal:0, formatBits:1 },
    MEDIUM:   { ordinal:1, formatBits:0 },
    QUARTILE: { ordinal:2, formatBits:3 },
    HIGH:     { ordinal:3, formatBits:2 }
  };
  const MODE_BYTE = { modeBits:0x4, ccbits:[8,16,16] };
  function numCharCountBits(mode, ver){ return mode.ccbits[Math.floor((ver + 7) / 17)]; }

  const ECC_CW_PER_BLOCK = [
    [-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
    [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]
  ];
  const NUM_EC_BLOCKS = [
    [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
    [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
    [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
    [-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]
  ];

  function rsMultiply(x, y){
    let z = 0;
    for (let i = 7; i >= 0; i--){
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
  function rsComputeDivisor(degree){
    const result = [];
    for (let i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    let root = 1;
    for (let i = 0; i < degree; i++){
      for (let j = 0; j < result.length; j++){
        result[j] = rsMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = rsMultiply(root, 0x02);
    }
    return result;
  }
  function rsComputeRemainder(data, divisor){
    const result = divisor.map(() => 0);
    for (const b of data){
      const factor = b ^ result.shift();
      result.push(0);
      for (let i = 0; i < divisor.length; i++) result[i] ^= rsMultiply(divisor[i], factor);
    }
    return result;
  }

  function getNumRawDataModules(ver){
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2){
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function getNumDataCodewords(ver, ecl){
    return Math.floor(getNumRawDataModules(ver) / 8)
      - ECC_CW_PER_BLOCK[ecl.ordinal][ver] * NUM_EC_BLOCKS[ecl.ordinal][ver];
  }

  function QrCode(version, ecl, dataCodewords, msk){
    this.version = version;
    this.ecl = ecl;
    this.size = version * 4 + 17;
    this.modules = [];
    this.isFunction = [];
    const rowF = [], rowM = [];
    for (let i = 0; i < this.size; i++){ rowF.push(false); rowM.push(false); }
    for (let i = 0; i < this.size; i++){ this.modules.push(rowM.slice()); this.isFunction.push(rowF.slice()); }
    this.drawFunctionPatterns();
    const allCw = this.addEccAndInterleave(dataCodewords);
    this.drawCodewords(allCw);
    if (msk === -1){
      let minPenalty = Infinity;
      for (let i = 0; i < 8; i++){
        this.applyMask(i); this.drawFormatBits(i);
        const p = this.getPenaltyScore();
        if (p < minPenalty){ msk = i; minPenalty = p; }
        this.applyMask(i);
      }
    }
    this.mask = msk;
    this.applyMask(msk);
    this.drawFormatBits(msk);
    this.isFunction = null;
  }

  QrCode.prototype.getModule = function(x, y){
    return x >= 0 && x < this.size && y >= 0 && y < this.size && this.modules[y][x];
  };
  QrCode.prototype.setFunctionModule = function(x, y, isDark){
    this.modules[y][x] = isDark; this.isFunction[y][x] = true;
  };
  QrCode.prototype.getAlignmentPatternPositions = function(){
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step = (this.version === 32) ? 26 :
      Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  };
  QrCode.prototype.drawFinderPattern = function(x, y){
    for (let dy = -4; dy <= 4; dy++){
      for (let dx = -4; dx <= 4; dx++){
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size)
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };
  QrCode.prototype.drawAlignmentPattern = function(x, y){
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  };
  QrCode.prototype.drawFunctionPatterns = function(){
    for (let i = 0; i < this.size; i++){
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);
    const pos = this.getAlignmentPatternPositions();
    const n = pos.length;
    for (let i = 0; i < n; i++){
      for (let j = 0; j < n; j++){
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)))
          this.drawAlignmentPattern(pos[i], pos[j]);
      }
    }
    this.drawFormatBits(0);
    this.drawVersion();
  };
  QrCode.prototype.drawFormatBits = function(mask){
    const data = (this.ecl.formatBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
    this.setFunctionModule(8, this.size - 8, true);
  };
  QrCode.prototype.drawVersion = function(){
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++){
      const color = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunctionModule(a, b, color);
      this.setFunctionModule(b, a, color);
    }
  };
  QrCode.prototype.addEccAndInterleave = function(data){
    const ver = this.version, ecl = this.ecl;
    const numBlocks = NUM_EC_BLOCKS[ecl.ordinal][ver];
    const blockEccLen = ECC_CW_PER_BLOCK[ecl.ordinal][ver];
    const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
    const numShort = numBlocks - rawCodewords % numBlocks;
    const shortLen = Math.floor(rawCodewords / numBlocks);
    const blocks = [];
    const rsDiv = rsComputeDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++){
      const dat = data.slice(k, k + shortLen - blockEccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsComputeRemainder(dat, rsDiv);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const result = [];
    for (let i = 0; i < blocks[0].length; i++){
      for (let j = 0; j < blocks.length; j++){
        if (i !== shortLen - blockEccLen || j >= numShort) result.push(blocks[j][i]);
      }
    }
    return result;
  };
  QrCode.prototype.drawCodewords = function(data){
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2){
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++){
        for (let j = 0; j < 2; j++){
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8){
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  };
  QrCode.prototype.applyMask = function(mask){
    for (let y = 0; y < this.size; y++){
      for (let x = 0; x < this.size; x++){
        let invert = false;
        switch (mask){
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + (x * y) % 3) % 2 === 0; break;
        }
        if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  };
  QrCode.prototype.finderPenaltyCountPatterns = function(rh){
    const n = rh[1];
    const core = n > 0 && rh[2] === n && rh[3] === n * 3 && rh[4] === n && rh[5] === n;
    return (core && rh[0] >= n * 4 && rh[6] >= n ? 1 : 0)
         + (core && rh[6] >= n * 4 && rh[0] >= n ? 1 : 0);
  };
  QrCode.prototype.finderPenaltyAddHistory = function(len, rh){
    if (rh[0] === 0) len += this.size;
    rh.pop(); rh.unshift(len);
  };
  QrCode.prototype.finderPenaltyTerminate = function(color, len, rh){
    if (color){ this.finderPenaltyAddHistory(len, rh); len = 0; }
    len += this.size;
    this.finderPenaltyAddHistory(len, rh);
    return this.finderPenaltyCountPatterns(rh);
  };
  QrCode.prototype.getPenaltyScore = function(){
    let result = 0;
    const size = this.size, m = this.modules;
    for (let y = 0; y < size; y++){
      let color = false, run = 0, rh = [0,0,0,0,0,0,0];
      for (let x = 0; x < size; x++){
        if (m[y][x] === color){ run++; if (run === 5) result += 3; else if (run > 5) result++; }
        else { this.finderPenaltyAddHistory(run, rh); if (!color) result += this.finderPenaltyCountPatterns(rh) * 40; color = m[y][x]; run = 1; }
      }
      result += this.finderPenaltyTerminate(color, run, rh) * 40;
    }
    for (let x = 0; x < size; x++){
      let color = false, run = 0, rh = [0,0,0,0,0,0,0];
      for (let y = 0; y < size; y++){
        if (m[y][x] === color){ run++; if (run === 5) result += 3; else if (run > 5) result++; }
        else { this.finderPenaltyAddHistory(run, rh); if (!color) result += this.finderPenaltyCountPatterns(rh) * 40; color = m[y][x]; run = 1; }
      }
      result += this.finderPenaltyTerminate(color, run, rh) * 40;
    }
    for (let y = 0; y < size - 1; y++)
      for (let x = 0; x < size - 1; x++){
        const c = m[y][x];
        if (c === m[y][x+1] && c === m[y+1][x] && c === m[y+1][x+1]) result += 3;
      }
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y][x]) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  };

  function encodeText(text, ecl){
    const utf8 = unescape(encodeURIComponent(text));
    const bytes = [];
    for (let i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i));

    let version;
    for (version = 1; ; version++){
      const capacityBits = getNumDataCodewords(version, ecl) * 8;
      const ccbits = numCharCountBits(MODE_BYTE, version);
      const usedBits = 4 + ccbits + bytes.length * 8;
      if (usedBits <= capacityBits) break;
      if (version >= 40) throw new Error("Data too long");
    }

    const bb = [];
    appendBits(MODE_BYTE.modeBits, 4, bb);
    appendBits(bytes.length, numCharCountBits(MODE_BYTE, version), bb);
    for (const b of bytes) appendBits(b, 8, bb);

    const capacityBits = getNumDataCodewords(version, ecl) * 8;
    appendBits(0, Math.min(4, capacityBits - bb.length), bb);
    appendBits(0, (8 - bb.length % 8) % 8, bb);
    for (let padByte = 0xEC; bb.length < capacityBits; padByte ^= 0xEC ^ 0x11)
      appendBits(padByte, 8, bb);

    const dataCw = [];
    while (dataCw.length * 8 < bb.length) dataCw.push(0);
    bb.forEach((b, i) => { dataCw[i >>> 3] |= b << (7 - (i & 7)); });

    return new QrCode(version, ecl, dataCw, -1);
  }

  function render(el, text, ecl){
    const qr = encodeText(text, ecl || Ecc.MEDIUM);
    const size = qr.size, border = 2, dim = size + border * 2;
    const parts = [];
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (qr.getModule(x, y))
          parts.push("M" + (x + border) + "," + (y + border) + "h1v1h-1z");
    el.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim +
      '" width="100%" height="100%" shape-rendering="crispEdges">' +
      '<rect width="100%" height="100%" fill="#ffffff"/>' +
      '<path d="' + parts.join(" ") + '" fill="#1c3327"/></svg>';
  }

  return { Ecc, encodeText, render };
})();

qrcodegen.render(
  document.getElementById("cert-qr"),
  DATA.verify_url,
  qrcodegen.Ecc.MEDIUM
);

/* ===================== Print/PDF button =====================
   certificate.html now contains only the marks-sheet page (the
   recommendation page lives in its own recommendation.html), so
   printing no longer needs to hide a sibling page — a plain
   window.print() produces exactly one clean landscape page. */
function printPage() {
  window.print();
}

/* ===================== Fit to one printed page =====================
   The "many-subjects" compact class above buys back some height for a
   long subject list, but it's a fixed-tier guess — it can't know the
   actual rendered height (which also depends on things it can't see:
   how long the school/region names are, whether the Amharic font's
   real line metrics run taller than assumed, how many bio fields have
   long values that wrap to a second line, etc). Guessing wrong in
   either direction is bad: too little compaction and the signature
   strip spills onto an unbordered second page (the exact bug this is
   fixing); too much and short report cards print needlessly tiny.

   So instead of guessing, this measures the ACTUAL rendered height of
   #page-1 against the real one-page budget (--page-content-h, defined
   once in certificate.css) and, only if it doesn't fit, shrinks the
   whole sheet with CSS `zoom`. zoom is used deliberately instead of
   `transform:scale()` — zoom rescales the element's own box (so the
   parent, and the page's pagination math, see the smaller size too),
   where transform only rescales what's painted. That's the same
   reasoning already noted in certificate.css's print block re: why a
   visual-only scale doesn't fix page-break overflow.

   For this to measure the layout that will actually be printed (not
   the on-screen preview layout, which uses different font sizes/
   padding under @media print), the server must call
   page.emulateMediaType('print') BEFORE page.setContent() so print
   styles are already active while this script runs — see
   renderCertificateHtml's callers in server.js. */
function fitToOnePage(){
  const sheet = document.getElementById("page-1");
  if (!sheet) return;

  const PX_PER_MM = 96 / 25.4; // CSS px is fixed at 96/in regardless of media/DPI
  const availMm = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--page-content-h")
  ) || 281;
  const availablePx = availMm * PX_PER_MM;

  const naturalPx = sheet.getBoundingClientRect().height;
  if (naturalPx <= availablePx) return; // already fits — leave it full size

  // 0.985 leaves a hair of slack for sub-pixel rounding; 0.55 is a
  // floor so a pathological case (e.g. every subject's Amharic name is
  // unusually long) degrades to "small but legible" rather than
  // shrinking to nothing while still overflowing.
  const scale = Math.max(0.55, Math.min(1, (availablePx / naturalPx) * 0.985));
  sheet.style.zoom = scale;
}

// document.fonts.ready (not just DOMContentLoaded) matters here: the
// Amharic spans throughout the sheet only get their real metrics once
// Noto Serif Ethiopic has actually loaded, and measuring against
// fallback-font metrics beforehand would compute the wrong scale.
// Server-side, page.evaluate(() => document.fonts.ready) is awaited
// AFTER setContent() and BEFORE page.pdf(), so Puppeteer doesn't
// generate the PDF until this handler (registered first, so it runs
// first once the promise settles) has already applied the zoom.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(fitToOnePage);
} else {
  fitToOnePage();
}
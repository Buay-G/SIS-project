const PR = DATA.recommendation;
const STUDENT_NAME = DATA.student_name;
const GRADE = DATA.grade;
const SECTION = DATA.section;
const STUDENT_ID = DATA.student_id;
const ACADEMIC_YEAR = DATA.academic_year;

const lineText = `${STUDENT_NAME} · Grade ${GRADE} (${SECTION}) · Student ID ${STUDENT_ID} · ${ACADEMIC_YEAR}`;
const studentLine = document.getElementById("student-line");
if (studentLine) {
  studentLine.textContent = lineText;
}

function fillSlot(selector, text) {
  const el = document.querySelector(selector);
  if (el) el.textContent = text || " ";
}

function truncateComment(text, maxLength = 500) {
  if (text == null) return "";
  const normalized = String(text).trim();
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength).trim() + "…";
}

fillSlot("#principal-name", PR.principal_name || " ");
fillSlot(".director-strip .slot:nth-child(3) .rule", PR.date || " ");

const commentBlocks = {
  first_semester: {
    comment: PR.first_semester_comment,
    homeroom: PR.first_semester_home_room_teacher,
    parent: PR.first_semester_parent_name,
    selector: "#first-semester",
    homeroomSelector: "#first-homeroom-name",
    parentSelector: "#first-parent-name"
  },
  second_semester: {
    comment: PR.second_semester_comment,
    homeroom: PR.second_semester_home_room_teacher,
    parent: PR.second_semester_parent_name,
    selector: "#second-semester",
    homeroomSelector: "#second-homeroom-name",
    parentSelector: "#second-parent-name"
  }
};

for (const block of Object.values(commentBlocks)) {
  const commentEl = document.querySelector(block.selector);
  if (commentEl) commentEl.textContent = truncateComment(block.comment) || " ";

  const homeroomEl = document.querySelector(block.homeroomSelector);
  if (homeroomEl) homeroomEl.textContent = truncateComment(block.homeroom) || " ";

  const parentEl = document.querySelector(block.parentSelector);
  if (parentEl) parentEl.textContent = truncateComment(block.parent) || " ";
}

/* ===================== QR Code generator ===================== */
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

  QrCode.prototype.drawFunctionPatterns = function(){
    this.drawFinderPattern(0, 0);
    this.drawFinderPattern(this.size - 7, 0);
    this.drawFinderPattern(0, this.size - 7);
    this.drawAlignmentPatterns();
    this.drawTimingPatterns();
    this.drawFormatBits(0);
  };

  QrCode.prototype.drawFinderPattern = function(x, y){
    for (let dy = -1; dy <= 7; dy++){
      for (let dx = -1; dx <= 7; dx++){
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size){
          const isDark = (dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 &&
            (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4)));
          this.setFunctionModule(xx, yy, isDark);
        }
      }
    }
  };

  QrCode.prototype.drawAlignmentPatterns = function(){
    const positions = this.getAlignmentPatternPositions();
    for (const x of positions){
      for (const y of positions){
        if ((x === 6 && y === 6) || (x === 6 && y === this.size - 7) || (x === this.size - 7 && y === 6)) continue;
        for (let dy = -2; dy <= 2; dy++){
          for (let dx = -2; dx <= 2; dx++){
            this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }
  };

  QrCode.prototype.drawTimingPatterns = function(){
    for (let i = 8; i < this.size - 8; i++){
      const bit = (i % 2) === 0;
      if (!this.isFunction[6][i]) this.setFunctionModule(6, i, bit);
      if (!this.isFunction[i][6]) this.setFunctionModule(i, 6, bit);
    }
  };

  QrCode.prototype.drawCodewords = function(data){
    let i = 0, inc = -1, bitIndex = 7;
    for (let x = this.size - 1; x > 0; x -= 2){
      if (x === 6) x--;
      for (let y = (inc < 0 ? this.size - 1 : 0); y >= 0 && y < this.size; y += inc){
        for (let xx = 0; xx < 2; xx++){
          const xxPos = x - xx;
          if (!this.isFunction[y][xxPos]){
            const dark = bitIndex < 0 ? false : ((data[i] >>> bitIndex) & 1) !== 0;
            this.modules[y][xxPos] = dark;
            bitIndex--;
            if (bitIndex < 0){
              i++;
              bitIndex = 7;
            }
          }
        }
      }
      inc = -inc;
    }
  };

  QrCode.prototype.applyMask = function(mask){
    for (let y = 0; y < this.size; y++){
      for (let x = 0; x < this.size; x++){
        if (!this.isFunction[y][x]){
          let invert;
          switch (mask){
            case 0: invert = (x + y) % 2 === 0; break;
            case 1: invert = y % 2 === 0; break;
            case 2: invert = x % 3 === 0; break;
            case 3: invert = (x + y) % 3 === 0; break;
            case 4: invert = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break;
            case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
            case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
            case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
            default: invert = false;
          }
          if (invert) this.modules[y][x] = !this.modules[y][x];
        }
      }
    }
  };

  QrCode.prototype.getPenaltyScore = function(){
    let result = 0;
    for (let y = 0; y < this.size; y++){
      let runColor = this.modules[y][0];
      let runLength = 1;
      for (let x = 1; x < this.size; x++){
        if (this.modules[y][x] === runColor){ runLength++; }
        else {
          if (runLength >= 5) result += 3 + (runLength - 5);
          runColor = this.modules[y][x];
          runLength = 1;
        }
      }
      if (runLength >= 5) result += 3 + (runLength - 5);
    }
    for (let x = 0; x < this.size; x++){
      let runColor = this.modules[0][x];
      let runLength = 1;
      for (let y = 1; y < this.size; y++){
        if (this.modules[y][x] === runColor){ runLength++; }
        else {
          if (runLength >= 5) result += 3 + (runLength - 5);
          runColor = this.modules[y][x];
          runLength = 1;
        }
      }
      if (runLength >= 5) result += 3 + (runLength - 5);
    }
    return result;
  };

  function getNumDataCodewords(ver, ecl){
    return Math.floor(getNumRawDataModules(ver) / 8)
      - ECC_CW_PER_BLOCK[ecl.ordinal][ver] * NUM_EC_BLOCKS[ecl.ordinal][ver];
  }
  function toUtf8Bytes(str){
    const bytes = [];
    for (let i = 0; i < str.length; i++){
      const code = str.charCodeAt(i);
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800){
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0xd800 || code >= 0xe000){
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        i++;
        const codePoint = 0x10000 + (((code & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
        bytes.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
      }
    }
    return bytes;
  }

  function encodeText(text, ecl){
    const data = toUtf8Bytes(text);
    const ver = 1;
    const dataCodewords = [];
    dataCodewords.push(MODE_BYTE.modeBits << 4 | numCharCountBits(MODE_BYTE, ver));
    for (const byte of data) dataCodewords.push(byte);
    const raw = [];
    for (let i = 0; i < dataCodewords.length; i++) raw.push(dataCodewords[i]);
    return qrcodegen.QrCode.encodeText(text, ecl);
  }

  function render(el, text, ecl){
    const qr = qrcodegen.QrCode.encodeText(text, ecl || Ecc.MEDIUM);
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

  return { Ecc, encodeText, render, QrCode };
})();

const qrTarget = document.getElementById("rec-qr");
const qrUrl = DATA.verify_url || window.location.href;
if (qrTarget && qrUrl) {
  qrcodegen.render(qrTarget, qrUrl, qrcodegen.Ecc.MEDIUM);
}
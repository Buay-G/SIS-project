// ==========================================================
// ETHIOPIAN CALENDAR — conversion, formatting, and holiday data.
// Loaded before script.js. Exposes a single global: EthCal.
//
// Conversion is JDN-based (Julian Day Number), epoch-anchored so it
// works for any Gregorian date without a lookup table. Verified against
// known reference dates (Ethiopian New Year 2018 EC = 11 Sep 2025 GC,
// Ethiopian Christmas 2018 EC = 7 Jan 2026 GC, etc.).
// ==========================================================
(function (global) {
    const JD_EPOCH_OFFSET_AMETE_MIHRET = 1724221;

    function gregorianToJDN(year, month, day) {
        const a = Math.floor((14 - month) / 12);
        const y = year + 4800 - a;
        const m = month + 12 * a - 3;
        return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
    }

    function jdnToGregorian(jdn) {
        const a = jdn + 32044;
        const b = Math.floor((4 * a + 3) / 146097);
        const c = a - Math.floor((146097 * b) / 4);
        const d = Math.floor((4 * c + 3) / 1461);
        const e = c - Math.floor((1461 * d) / 4);
        const m = Math.floor((5 * e + 2) / 153);
        const day = e - Math.floor((153 * m + 2) / 5) + 1;
        const month = m + 3 - 12 * Math.floor(m / 10);
        const year = 100 * b + d - 4800 + Math.floor(m / 10);
        return { year, month, day };
    }

    function isEthiopianLeap(year) {
        return ((year % 4) === 3);
    }

    function ethiopianToJDN(year, month, day) {
        return JD_EPOCH_OFFSET_AMETE_MIHRET + 365 * (year - 1) + Math.floor(year / 4) + 30 * (month - 1) + (day - 1);
    }

    function jdnToEthiopian(jdn) {
        const n = jdn - JD_EPOCH_OFFSET_AMETE_MIHRET;
        const c4 = Math.floor(n / 1461); // 1461 = 4*365 + 1 (one 4-year cycle)
        const rem = n - c4 * 1461;
        let yOffset = Math.floor(rem / 365);
        if (yOffset > 3) yOffset = 3;
        const year = c4 * 4 + yOffset + 1;
        const dayOfYear = n - (365 * (year - 1) + Math.floor(year / 4));
        const month = Math.floor(dayOfYear / 30) + 1;
        const day = dayOfYear - (month - 1) * 30 + 1;
        return { year, month, day };
    }

    function toEthiopian(input) {
        const d = (input instanceof Date) ? input : new Date(input + 'T00:00:00');
        if (isNaN(d.getTime())) return null;
        return jdnToEthiopian(gregorianToJDN(d.getFullYear(), d.getMonth() + 1, d.getDate()));
    }

    function toGregorian(year, month, day) {
        const g = jdnToGregorian(ethiopianToJDN(year, month, day));
        return g;
    }

    function toGregorianDate(year, month, day) {
        const g = toGregorian(year, month, day);
        return new Date(g.year, g.month - 1, g.day);
    }

    const MONTHS_EN = ['Meskerem', 'Tikimt', 'Hidar', 'Tahsas', 'Tir', 'Yekatit', 'Megabit', 'Miyazya', 'Ginbot', 'Sene', 'Hamle', 'Nehase', 'Pagume'];
    const MONTHS_AM = ['መስከረም', 'ጥቅምት', 'ኅዳር', 'ታኅሣሥ', 'ጥር', 'የካቲት', 'መጋቢት', 'ሚያዝያ', 'ግንቦት', 'ሰኔ', 'ሐምሌ', 'ነሐሴ', 'ጳጉሜ'];
    const WEEKDAYS_AM = ['እሁድ', 'ሰኞ', 'ማክሰኞ', 'ረቡዕ', 'ሐሙስ', 'ዓርብ', 'ቅዳሜ'];

    function monthName(month, lang) {
        const arr = lang === 'am' ? MONTHS_AM : MONTHS_EN;
        return arr[month - 1] || '';
    }

    function weekdayName(date, lang) {
        if (lang === 'am') return WEEKDAYS_AM[date.getDay()];
        return date.toLocaleDateString('en-US', { weekday: 'long' });
    }

    // "16 Meskerem 2019 (GC: Sep 26, 2026)" / Amharic equivalent.
    function formatWithGC(input, opts) {
        opts = opts || {};
        const lang = opts.lang || 'en';
        const eth = toEthiopian(input);
        if (!eth) return '';
        const d = (input instanceof Date) ? input : new Date(input + 'T00:00:00');
        const gcLabel = opts.gcLabel || 'GC';
        const gcStr = d.toLocaleDateString(lang === 'am' ? 'en-GB' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        const ethStr = `${eth.day} ${monthName(eth.month, lang)} ${eth.year}`;
        if (opts.gcOnly) return gcStr;
        if (opts.ethOnly) return ethStr;
        return `${ethStr} (${gcLabel}: ${gcStr})`;
    }

    // ---------- Holidays ----------
    // Fixed: same Ethiopian calendar month/day every year (converted
    // automatically, so always accurate — including leap-year shifts).
    const FIXED_HOLIDAYS = [
        { key: 'holiday_enkutatash', month: 1, day: 1 },
        { key: 'holiday_meskel', month: 1, day: 17 },
        { key: 'holiday_buhe', month: 12, day: 13 },
        { key: 'holiday_genna', month: 4, day: 29 },
        { key: 'holiday_timkat', month: 5, day: 11 },
        { key: 'holiday_adwa', month: 6, day: 23 },
        { key: 'holiday_labor', month: 8, day: 23 },
        { key: 'holiday_patriots', month: 8, day: 27 },
        { key: 'holiday_derg', month: 9, day: 20 },
    ];

    // Movable holidays are computed algorithmically below, NOT from a
    // hardcoded date table — so they stay correct for every future year,
    // not just the next one or two, with no manual updates ever needed.

    // Orthodox Easter (Fasika): Meeus's algorithm for Julian-calendar
    // Easter, then shifted onto the Gregorian calendar (13-day offset,
    // valid 1900–2099; the offset itself changes very rarely over
    // centuries, same as any Julian/Gregorian conversion).
    function orthodoxEasterGregorian(year) {
        const a = year % 4, b = year % 7, c = year % 19;
        const d = (19 * c + 15) % 30;
        const e = (2 * a + 4 * b - d + 34) % 7;
        const month = Math.floor((d + e + 114) / 31);
        const day = ((d + e + 114) % 31) + 1;
        const julianOffsetDays = 13;
        return new Date(Date.UTC(year, month - 1, day) + julianOffsetDays * 86400000);
    }

    // Tabular (civil) Islamic calendar — the standard arithmetic
    // approximation used across calendaring software. Real observance can
    // shift by a day either way depending on local moon sighting, which is
    // exactly why these are always flagged "tentative" in the UI.
    const ISLAMIC_EPOCH_JDN = 1948440;
    function islamicToJDN(year, month, day) {
        return day + Math.ceil(29.5 * (month - 1)) + (year - 1) * 354 + Math.floor((3 + 11 * year) / 30) + ISLAMIC_EPOCH_JDN - 1;
    }
    function gregorianToIslamicYear(gDate) {
        const jdn = gregorianToJDN(gDate.getFullYear(), gDate.getMonth() + 1, gDate.getDate());
        let y = Math.floor((30 * (jdn - ISLAMIC_EPOCH_JDN) + 10646) / 10631);
        while (islamicToJDN(y + 1, 1, 1) <= jdn) y++;
        while (islamicToJDN(y, 1, 1) > jdn) y--;
        return y;
    }
    function islamicDateToGregorian(year, month, day) {
        return jdnToGregorian(islamicToJDN(year, month, day));
    }
    function islamicDateToGregorianDateObj(year, month, day) {
        const g = islamicDateToGregorian(year, month, day);
        return new Date(g.year, g.month - 1, g.day);
    }

    // Returns the next `count` holidays from `fromDate` onward (default:
    // today), each as { key, date (Date obj), tentative, daysAway }.
    function getUpcomingHolidays(fromDate, count) {
        count = count || 6;
        const from = fromDate || new Date();
        const fromMidnight = new Date(from.getFullYear(), from.getMonth(), from.getDate());
        const fromEth = toEthiopian(fromMidnight);
        const fromHijri = gregorianToIslamicYear(fromMidnight);
        const occurrences = [];

        FIXED_HOLIDAYS.forEach(h => {
            [fromEth.year, fromEth.year + 1].forEach(ey => {
                occurrences.push({ key: h.key, date: toGregorianDate(ey, h.month, h.day), tentative: false });
            });
        });

        [fromMidnight.getFullYear(), fromMidnight.getFullYear() + 1].forEach(gy => {
            const easter = orthodoxEasterGregorian(gy);
            const goodFriday = new Date(easter.getTime() - 2 * 86400000);
            occurrences.push({ key: 'holiday_fasika', date: easter, tentative: false });
            occurrences.push({ key: 'holiday_good_friday', date: goodFriday, tentative: false });
        });

        [fromHijri, fromHijri + 1].forEach(hy => {
            occurrences.push({ key: 'holiday_eid_fitr', date: islamicDateToGregorianDateObj(hy, 10, 1), tentative: true });
            occurrences.push({ key: 'holiday_eid_adha', date: islamicDateToGregorianDateObj(hy, 12, 10), tentative: true });
            occurrences.push({ key: 'holiday_mawlid', date: islamicDateToGregorianDateObj(hy, 3, 12), tentative: true });
        });

        return occurrences
            .filter(o => o.date >= fromMidnight)
            .sort((a, b) => a.date - b.date)
            .map(o => ({ ...o, daysAway: Math.round((o.date - fromMidnight) / 86400000) }))
            .slice(0, count);
    }

    global.EthCal = {
        toEthiopian, toGregorian, toGregorianDate,
        monthName, weekdayName, formatWithGC, isEthiopianLeap,
        getUpcomingHolidays,
    };
})(window);
// Baza trzyma ISO UTC; raporty i widoki mysla dniami w strefie Europe/Warsaw.
// en-CA daje z Intl bezposrednio 'YYYY-MM-DD' — porownania okresow robimy leksykalnie.

export function dayWarsaw(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

export function monthRangeWarsaw(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month ?? ''));
  if (!m) return null;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  // dzien 0 nastepnego miesiaca = ostatni dzien tego (luty i lata przestepne za darmo)
  const last = new Date(Date.UTC(Number(m[1]), mo, 0)).getUTCDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` };
}

export function monthShift(month, delta) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month ?? ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Sam dzień po polsku (DD.MM.YYYY) — do maili, gdzie godzina jest szumem.
// Gotowy dzień 'YYYY-MM-DD' (tak zwraca quoteValidity) przestawiamy wprost:
// przepuszczenie go przez Date zrobiłoby z niego północ UTC i przy strefach
// ujemnych cofnęłoby datę o dobę.
export const fmtDayPL = (v) => {
  if (!v) return '';
  const dzien = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  if (dzien) return `${dzien[3]}.${dzien[2]}.${dzien[1]}`;
  const d = dayWarsaw(v);
  return d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '';
};

// Dzień słownie po polsku („20 września 2026") — do treści maili, gdzie „20.09.2026"
// czyta się jak numer katalogowy, a nie jak termin.
//
// ⚠️ MIESIĄC W DOPEŁNIACZU wpisany wprost, bez `Intl`. `toLocaleDateString('pl-PL', …)`
// oddaje formę zależną od wersji ICU w środowisku uruchomieniowym (raz „września", raz
// „wrzesień"), a to jest tekst wysyłany klientowi — ma brzmieć tak samo z kontenera, z testu
// i z komputera operatora.
const MIESIACE_DOPELNIACZ = [
  'stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
  'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia',
];

export const fmtDaySlownie = (v) => {
  if (!v) return '';
  // Gotowy dzień 'YYYY-MM-DD' bierzemy WPROST — z tego samego powodu, co w `fmtDayPL`:
  // przepuszczenie go przez `Date` zrobiłoby północ UTC i potrafiłoby cofnąć datę o dobę.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v)) || (() => {
    const d = dayWarsaw(v);
    return d ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(d) : null;
  })();
  if (!m) return '';
  const mies = MIESIACE_DOPELNIACZ[Number(m[2]) - 1];
  if (!mies) return '';
  // Dzień bez wiodącego zera: „5 września", nie „05 września".
  return `${Number(m[3])} ${mies} ${m[1]}`;
};

// Format daty na kartach i listach.
export const fmtPL = (v) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 16).replace('T', ' ');
  const parts = new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = (t) => parts.find((x) => x.type === t)?.value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
};

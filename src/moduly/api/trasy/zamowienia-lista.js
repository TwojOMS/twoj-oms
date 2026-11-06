import { blad, czytajStronicowanie, strona } from '../odpowiedzi.js';
import { wymagajZakresu } from '../zakres.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import { ETYKIETY, wyliczStatus } from '../../../domena/status.js';
import { chceFakture, daneFaktury } from '../../../domena/dane-faktury.js';
import { grosze } from '../../../domena/kwoty.js';
import { pobierzZamowienie } from '../../../oms/db/zamowienia.js';
import { statusyWKolejnosci } from '../../../oms/db/statusy.js';
import { dostawaZamowienia } from '../../api-panelu/trasy/api-zamowienia-z-karty.js';

function poprawnaData(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const strefaWarszawa = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', timeZoneName: 'longOffset' });
function dataUtc(s) {
  if (!s) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  // Starsze daty sklepowe zapisano w lokalnym czasie Warszawy.
  const lokalna = Date.parse(`${s.replace(' ', 'T')}Z`);
  if (!Number.isFinite(lokalna)) return null;
  const przesuniecie = strefaWarszawa.formatToParts(new Date(lokalna)).find(p => p.type === 'timeZoneName')?.value;
  const m = /^GMT([+-])(\d\d):(\d\d)$/.exec(przesuniecie ?? '');
  if (!m) return null;
  const minuty = (Number(m[2]) * 60 + Number(m[3])) * (m[1] === '+' ? 1 : -1);
  return new Date(lokalna - minuty * 60_000).toISOString();
}

function pozycja(z) {
  const surowe = z.surowe_json ? JSON.parse(z.surowe_json) : {};
  return {
    id: z.id, numer: z.numer, kanal: z.sklep, status: wyliczStatus(z),
    utworzone_at: dataUtc(z.utworzone_at), klient: {
      imie: z.klient?.first_name ?? null, nazwisko: z.klient?.last_name ?? null,
      email: z.klient?.email ?? null,
    }, suma_gr: grosze(z.kwota_brutto, 'zamówienie'), waluta: surowe.currency ?? 'PLN',
  };
}

export function trasaZamowieniaLista(app, { db }) {
  const ochrona = { preHandler: wymagajZakresu('zamowienia:odczyt') };
  app.get('/zamowienia', ochrona, async (req, reply) => {
    const q = req.query;
    const { po, ile } = czytajStronicowanie(q);
    const wlasny = q.status && statusyWKolejnosci(db).some(s => s.klucz === q.status);
    if ((q.status && !Object.hasOwn(ETYKIETY, q.status) && !wlasny)
      || (q.od !== undefined && !poprawnaData(q.od)) || (q.do !== undefined && !poprawnaData(q.do))) {
      return blad(reply, 400, 'filtr', 'Nieprawidłowy filtr zamówień.');
    }
    const warunki = ['id > ?'];
    const parametry = [];
    if (q.kanal) { warunki.push('sklep = ?'); parametry.push(q.kanal); }
    if (q.numer) { warunki.push('numer = ?'); parametry.push(q.numer); }
    // Okno z zapasem dla czasu lokalnego i nietypowych stref, także dat nierozumianych przez SQLite.
    if (q.od) { warunki.push("(julianday(utworzone_at) >= julianday(?, '-1 day') OR julianday(utworzone_at) IS NULL)"); parametry.push(q.od); }
    if (q.do) { warunki.push("(julianday(utworzone_at) < julianday(?, '+2 days') OR julianday(utworzone_at) IS NULL)"); parametry.push(q.do); }
    const indeks = (q.od || q.do) && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'zamowienia_julianday_utworzenia'").get()
      ? ' INDEXED BY zamowienia_julianday_utworzenia' : '';
    const zapytanie = db.prepare(`SELECT id, utworzone_at FROM zamowienia${indeks} WHERE ${warunki.join(' AND ')} ORDER BY id LIMIT 200`);
    const wynik = [];
    let ostatnie = po;
    while (wynik.length < ile) {
      const kandydaci = zapytanie.all(ostatnie, ...parametry);
      if (!kandydaci.length) break;
      for (const w of kandydaci) {
        ostatnie = w.id;
        const dzien = dzienWarszawa(w.utworzone_at);
        if ((q.od && (!dzien || dzien < q.od)) || (q.do && (!dzien || dzien > q.do))) continue;
        const z = pobierzZamowienie(db, w.id);
        if (q.status && wyliczStatus(z) !== q.status) continue;
        wynik.push(pozycja(z));
        if (wynik.length === ile) break;
      }
      if (kandydaci.length < 200) break;
    }
    return strona(wynik, ile);
  });
  app.get('/zamowienia/:id', ochrona, async (req, reply) => {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
    const z = Number.isSafeInteger(id) && id > 0 ? pobierzZamowienie(db, id) : null;
    if (!z) return blad(reply, 404, 'brak', 'Nie ma takiego zamówienia.');
    return {
      ...pozycja(z),
      pozycje: z.pozycje.map(p => ({ nazwa: p.nazwa, sku: p.sku ?? null, ilosc: p.ilosc,
        cena_brutto_gr: grosze(p.cena_brutto, 'pozycja'), stawka_vat: p.vat ?? null })),
      dostawa: dostawaZamowienia(z),
      platnosc: { metoda: z.metoda_platnosci ?? null, oplacone: Boolean(z.oplacone_at) },
      faktura: { chce: chceFakture(z), nip: daneFaktury(z).nip ?? null },
    };
  });
}

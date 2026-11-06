import { blad, czytajStronicowanie, strona } from '../odpowiedzi.js';
import { wymagajZakresu } from '../zakres.js';
import { adresSklepu } from '../../magazyn/karta.js';

function dataUtc(s) {
  if (!s) return null;
  // Daty kart pochodzą z zegara OMS (UTC), również starszy zapis SQLite bez strefy.
  const iso = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function poprawnaData(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(s)) return false;
  const dzien = s.slice(0, 10);
  const d = new Date(`${dzien}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === dzien
    && Number(s.slice(11, 13)) < 24 && Number.isFinite(Date.parse(s));
}

function produktDoApi(p) {
  let zdjecia;
  try { zdjecia = JSON.parse(p.zdjecia_json); } catch { zdjecia = []; }
  return {
    kanal: p.kanal, id_w_sklepie: p.produkt_id, nazwa: p.nazwa, cena_gr: p.cena_gr,
    dostepna_w_sklepie: p.zniknal_at === null,
    zdjecia: Array.isArray(zdjecia) ? zdjecia.map(adresSklepu).filter(Boolean) : [],
  };
}

function serializuj(w, produkty) {
  return {
    id: w.id, sku: w.sku, nazwa: w.nazwa, opis: w.opis, ean: w.ean,
    cena_gr: w.cena_gr, stawka_vat: w.stawka_vat, kategoria: w.kategoria_glowna,
    wymiary: { szerokosc_mm: w.szerokosc_mm, wysokosc_mm: w.wysokosc_mm, glebokosc_mm: w.glebokosc_mm },
    waga_g: w.waga_g, wycofana: Boolean(w.wycofana),
    utworzony_at: dataUtc(w.utworzony_at), zmieniony_at: dataUtc(w.zmieniony_at),
    w_sklepach: produkty.map(produktDoApi),
  };
}

export function kartaDoApi(db, wiersz) {
  return serializuj(wiersz, db.prepare('SELECT * FROM produkty_sklepowe WHERE karta_id = ? ORDER BY id').all(wiersz.id));
}

export function etagKarty(wiersz) {
  return `"${wiersz.zmieniony_at}"`;
}

export function trasyProduktyOdczyt(app, { db }) {
  const ochrona = { preHandler: wymagajZakresu('produkty:odczyt') };
  app.get('/produkty', ochrona, async (req, reply) => {
    const q = req.query;
    const { po, ile } = czytajStronicowanie(q);
    const wycofane = q.wycofane ?? 'nie';
    // Powtórzony parametr (`?sku=a&sku=b`) przychodzi jako tablica — to błąd filtra, nie 500.
    const tekstLubBrak = (w) => w === undefined || typeof w === 'string';
    if (!['tak', 'nie', 'wszystkie'].includes(wycofane)
      || !tekstLubBrak(q.sku) || !tekstLubBrak(q.kategoria)
      || (q.zmienione_od !== undefined && !poprawnaData(q.zmienione_od))) {
      return blad(reply, 400, 'filtr', 'Nieprawidłowy filtr produktów.');
    }
    const warunki = ['id > ?'];
    const parametry = [];
    if (q.kategoria !== undefined) { warunki.push('kategoria_glowna = ?'); parametry.push(q.kategoria); }
    if (wycofane !== 'wszystkie') { warunki.push('wycofana = ?'); parametry.push(wycofane === 'tak' ? 1 : 0); }
    const zapytanie = db.prepare(`SELECT * FROM karty_produktow WHERE ${warunki.join(' AND ')} ORDER BY id LIMIT 200`);
    const wynik = [];
    let ostatnie = po;
    const sku = q.sku === undefined ? null : q.sku.trim().toUpperCase();
    const od = q.zmienione_od === undefined ? null : new Date(q.zmienione_od).toISOString();
    // Normalizacja SKU identyczna z zajeteSku, także dla liter spoza ASCII.
    while (wynik.length < ile) {
      const kandydaci = zapytanie.all(ostatnie, ...parametry);
      if (!kandydaci.length) break;
      for (const w of kandydaci) {
        ostatnie = w.id;
        if (sku !== null && String(w.sku ?? '').trim().toUpperCase() !== sku) continue;
        const data = dataUtc(w.zmieniony_at);
        if (od !== null && (!data || data < od)) continue;
        wynik.push(w);
        if (wynik.length === ile) break;
      }
      if (kandydaci.length < 200) break;
    }
    const produkty = new Map(wynik.map(w => [w.id, []]));
    if (wynik.length) {
      for (const p of db.prepare(`SELECT * FROM produkty_sklepowe WHERE karta_id IN (${wynik.map(() => '?').join(',')}) ORDER BY id`).all(...wynik.map(w => w.id))) {
        produkty.get(p.karta_id).push(p);
      }
    }
    return strona(wynik.map(w => serializuj(w, produkty.get(w.id))), ile);
  });
  app.get('/produkty/:id', ochrona, async (req, reply) => {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
    const w = Number.isSafeInteger(id) && id > 0 ? db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id) : null;
    if (!w) return blad(reply, 404, 'brak', 'Nie ma takiego produktu.');
    reply.header('ETag', etagKarty(w));
    return kartaDoApi(db, w);
  });
}

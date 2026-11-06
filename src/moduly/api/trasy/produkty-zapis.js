import { parsujKarteZApi, wymiaryKompletne } from '../../../domena/karta-z-api.js';
import { utworzKarte, zapiszKarte } from '../../../oms/db/magazyn.js';
import { zIdempotencja } from '../idempotencja.js';
import { wymagajZakresu } from '../zakres.js';
import { etagKarty, kartaDoApi } from './produkty-odczyt.js';

const blad = (status, kod, powod, reszta = {}) => ({ status, cialo: { kod, powod, ...reszta } });
const wiersz = (db, id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);
const kluczSku = (sku) => String(sku ?? '').trim().toUpperCase();

/**
 * Karta (inna niż `pomin`), która ma to SKU — porównanie jak `zajeteSku` (`src/oms/db/magazyn.js`): trim
 * i wielkie litery w JS (także polskie; SQLite `UPPER` zna tylko ASCII). Tylko karty: numer produktu
 * w sklepie nie blokuje karty, tak jak na ekranie karty w MAGAZYNIE (`kartaZeSku`).
 */
function kartaZTymSamymSku(db, sku, pomin = null) {
  const szukane = kluczSku(sku);
  if (!szukane) return null;
  for (const w of db.prepare("SELECT id, sku FROM karty_produktow WHERE sku IS NOT NULL AND TRIM(sku) <> '' ORDER BY id").all()) {
    if (w.id !== pomin && kluczSku(w.sku) === szukane) return w;
  }
  return null;
}

/**
 * Sprawdzenie SKU i zapis w jednej transakcji: dwa równoległe POST z tym samym SKU nie założą dwóch kart.
 * W `zIdempotencja` transakcja jest już otwarta — wtedy bez własnego BEGIN.
 */
function wTransakcji(db, praca) {
  if (db.isTransaction) return praca();
  db.exec('BEGIN IMMEDIATE');
  try {
    const wynik = praca();
    db.exec('COMMIT');
    return wynik;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

const odrzucenie = (wynik) => blad(400, wynik.kod, wynik.powod, { pole: wynik.pole });
const niepelneWymiary = () => blad(400, 'wymiary', 'Podaj szerokość i wysokość razem (głębokość opcjonalnie) albo żaden wymiar.');
const skuZajete = (inna) => blad(409, 'sku_zajete', `SKU jest już zajęte przez kartę #${inna.id}.`, { id: inna.id });

/** Zapis kart produktów kluczem z `produkty:zapis` — wyłącznie przez `utworzKarte` i `zapiszKarte`. */
export function trasyProduktyZapis(app, { db, teraz }) {
  const ochrona = { preHandler: wymagajZakresu('produkty:zapis') };

  app.post('/produkty', ochrona, async (req, reply) => zIdempotencja(db, req, reply, 'POST /produkty',
    () => wTransakcji(db, () => {
      const wynik = parsujKarteZApi(req.body, { czesciowa: false });
      if (!wynik.ok) return odrzucenie(wynik);
      if (!wymiaryKompletne(wynik.karta)) return niepelneWymiary();
      const inna = kartaZTymSamymSku(db, wynik.karta.sku);
      if (inna) return skuZajete(inna);
      const id = utworzKarte(db, wynik.karta, { at: teraz().toISOString() });
      const w = wiersz(db, id);
      // Ciało przed nagłówkami: wyjątek w kartaDoApi (ROLLBACK) nie zostawi w 500 Location cofniętej karty.
      const cialo = kartaDoApi(db, w);
      reply.header('ETag', etagKarty(w));
      reply.header('Location', `/api/v1/produkty/${id}`);
      return { status: 201, cialo };
    })));

  app.patch('/produkty/:id', ochrona, async (req, reply) => {
    const surowe = String(req.params.id);
    return zIdempotencja(db, req, reply, `PATCH /produkty/${surowe}`, () => wTransakcji(db, () => {
      const id = /^\d+$/.test(surowe) ? Number(surowe) : NaN;
      const w = Number.isSafeInteger(id) && id > 0 ? wiersz(db, id) : null;
      if (!w) return blad(404, 'brak', 'Nie ma takiego produktu.');
      const ifMatch = req.headers['if-match'];
      if (typeof ifMatch !== 'string' || !ifMatch.trim()) {
        return blad(428, 'if_match', 'Zmiana karty wymaga nagłówka If-Match z ETag pobranej karty.');
      }
      if (ifMatch.trim() !== etagKarty(w)) {
        return blad(409, 'zmieniona', 'Karta zmieniła się od pobrania; pobierz ją ponownie.', { karta: kartaDoApi(db, w) });
      }
      const wynik = parsujKarteZApi(req.body, { czesciowa: true });
      if (!wynik.ok) return odrzucenie(wynik);
      const zmiany = wynik.karta;
      // Sprawdzamy tylko, gdy żądanie zmienia wymiary: stara karta z połowicznym wymiarem (sprzed tej reguły)
      // nie może blokować zmiany nazwy czy ceny.
      if (Object.hasOwn(req.body, 'wymiary') && !wymiaryKompletne({ ...w, ...zmiany })) return niepelneWymiary();
      if (Object.keys(zmiany).length) {
        const inna = kartaZTymSamymSku(db, zmiany.sku, w.id);
        if (inna) return skuZajete(inna);
        zapiszKarte(db, w.id, zmiany, { at: teraz().toISOString() });
      }
      const po = wiersz(db, w.id);
      const cialo = kartaDoApi(db, po);
      reply.header('ETag', etagKarty(po));
      return { status: 200, cialo };
    }));
  });
}

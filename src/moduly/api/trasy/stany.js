import { blad, czytajStronicowanie } from '../odpowiedzi.js';
import { wymagajZakresu } from '../zakres.js';
import { zIdempotencja } from '../idempotencja.js';
import { dodajRuch, przelacznikStanow, stanyKart } from '../../../oms/db/stany-magazynowe.js';
import { RODZAJE_RUCHU } from '../../../domena/stany-magazynowe.js';

const kluczSku = sku => String(sku ?? '').trim().toUpperCase();
const wylaczone = () => ({ status: 409, cialo: { kod: 'stany_wylaczone', powod: 'Stany magazynowe są wyłączone.' } });
const odrzuc = (powod) => ({ status: 400, cialo: { kod: 'walidacja', powod } });

function waliduj(cialo) {
  if (!cialo || typeof cialo !== 'object' || Array.isArray(cialo)) return 'Ciało musi być obiektem.';
  if (Object.keys(cialo).some(p => !['sku', 'karta_id', 'rodzaj', 'ilosc', 'powod'].includes(p))) return 'Nieznane pole ruchu.';
  const maSku = Object.hasOwn(cialo, 'sku');
  const maId = Object.hasOwn(cialo, 'karta_id');
  if (maSku === maId) return 'Podaj dokładnie jedno z pól sku i karta_id.';
  if (maSku && (typeof cialo.sku !== 'string' || !cialo.sku.trim())) return 'SKU musi być niepustym tekstem.';
  if (maId && (!Number.isSafeInteger(cialo.karta_id) || cialo.karta_id <= 0)) return 'karta_id musi być dodatnią liczbą całkowitą.';
  if (!RODZAJE_RUCHU.includes(cialo.rodzaj) || !['przyjecie', 'korekta'].includes(cialo.rodzaj)) return 'Dozwolone rodzaje to przyjecie i korekta.';
  if (!Number.isSafeInteger(cialo.ilosc) || cialo.ilosc === 0 || (cialo.rodzaj === 'przyjecie' && cialo.ilosc < 0)) return 'Nieprawidłowa ilość ruchu.';
  if (cialo.powod !== undefined && (typeof cialo.powod !== 'string' || cialo.powod.length > 500)) return 'Powód musi być tekstem do 500 znaków.';
  if (cialo.rodzaj === 'korekta' && !cialo.powod?.trim()) return 'Korekta wymaga niepustego powodu.';
  return null;
}

export function trasyStany(app, { db, teraz }) {
  app.get('/stany', { preHandler: wymagajZakresu('stany:odczyt') }, async (req, reply) => {
    const przelacznik = przelacznikStanow(db);
    if (!przelacznik.wlaczone) {
      const { status, cialo } = wylaczone();
      return reply.code(status).send(cialo);
    }
    const { po, ile } = czytajStronicowanie(req.query);
    if (req.query.sku !== undefined && typeof req.query.sku !== 'string') return blad(reply, 400, 'filtr', 'Nieprawidłowy filtr SKU.');
    const sku = req.query.sku === undefined ? null : kluczSku(req.query.sku);
    const stany = stanyKart(db);
    const granica = przelacznik.granica;
    const od = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(granica) ? granica : `${granica.replace(' ', 'T')}Z`).toISOString();
    const pozycje = [];
    const zapytanie = db.prepare('SELECT id, sku FROM karty_produktow WHERE id > ? ORDER BY id LIMIT 200');
    let ostatnie = po;
    while (pozycje.length < ile) {
      const karty = zapytanie.all(ostatnie);
      if (!karty.length) break;
      for (const karta of karty) {
        ostatnie = karta.id;
        if (sku !== null && kluczSku(karta.sku) !== sku) continue;
        pozycje.push({ karta_id: karta.id, sku: karta.sku, stan: stany.stany.get(karta.id)?.stan ?? 0, od });
        if (pozycje.length === ile) break;
      }
      if (karty.length < 200) break;
    }
    return { pozycje, nastepny: pozycje.length === ile ? pozycje.at(-1).karta_id : null };
  });

  app.post('/stany/ruchy', { preHandler: wymagajZakresu('stany:zapis') }, async (req, reply) => {
    if (req.headers['idempotency-key'] === undefined) return blad(reply, 428, 'idempotencja', 'Wymagany jest nagłówek Idempotency-Key.');
    // Wymagany nagłówek sprawia, że zIdempotencja obejmuje odczyty i zapis jedną transakcją.
    return zIdempotencja(db, req, reply, 'POST /stany/ruchy', () => {
      if (!przelacznikStanow(db).wlaczone) return wylaczone();
      const powodBledu = waliduj(req.body);
      if (powodBledu) return odrzuc(powodBledu);
      const dane = req.body;
      const karta = dane.karta_id !== undefined
        ? db.prepare('SELECT id, sku FROM karty_produktow WHERE id = ?').get(dane.karta_id)
        : db.prepare('SELECT id, sku FROM karty_produktow ORDER BY id').all().find(w => kluczSku(w.sku) === kluczSku(dane.sku));
      if (!karta) return { status: 404, cialo: { kod: 'brak', powod: 'Nie ma takiej karty produktu.' } };
      const powod = dane.powod?.trim() ?? null;
      const { dopisano } = dodajRuch(db, { kartaId: karta.id, rodzaj: dane.rodzaj, ilosc: dane.ilosc, powod,
        klucz: `api:${req.kluczApi.id}:${req.headers['idempotency-key']}`,
        konto: { id: null, login: `api:${req.kluczApi.nazwa}` }, at: teraz().toISOString() });
      // Klucz ruchu już zajęty (np. po wygaśnięciu pamięci odpowiedzi) — nie udajemy zapisu, którego nie ma.
      if (!dopisano) return { status: 409, cialo: { kod: 'idempotencja', powod: 'Ruch z tym Idempotency-Key został już zapisany.' } };
      return { status: 201, cialo: { karta_id: karta.id, sku: karta.sku, rodzaj: dane.rodzaj, ilosc: dane.ilosc,
        powod, stan: stanyKart(db).stany.get(karta.id)?.stan ?? 0 } };
    });
  });
}

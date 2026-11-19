// Karta produktu i ekran wyniku mówią, na co czeka oferta, która jeszcze nie wyszła do Allegro — tym samym
// warunkiem, którym pętla ofert pomija konto; nagłówek oferty pokazuje nazwę konta, nie klucz ani `ext:`.
import { beforeEach, afterEach, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/przykladowe-definicje-kanalow.js';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { wstawOferte, zmienOferte, zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';

const KONTO = 'allegro_swietlik';
const NAZWA = 'Świetlik';
const T0 = '2026-11-14T08:00:00.000Z';
const OFERTY = ['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'];
const jwt = (scope) => ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
const WSTRZYMANE = `Czeka: konto ${NAZWA} ma oferty wstrzymane — nic nie wyjdzie do Allegro, dopóki nie włączysz „Oferty: czynne” w kroku Oferty konta.`;
const KROK = `/ustawienia/integracje/allegro/${KONTO}/oferty#allegro-oferty-ustawienia`;

let db, app;
const get = (url) => app.inject({ method: 'GET', url, headers: auth });
const naglowki = (html) => [...html.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]);

beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' }, definicje: definicjeKanalowHistoryczne },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': { [KONTO]: {} },
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) =>
          typ === 'allegro' ? [{ klucz: KONTO, nazwa: NAZWA, autoryzacja: 'polaczone', srodowisko: 'produkcja' }] : [],
        zapisyZablokowane: () => false,
        konfliktKlucza: () => false,
      },
    },
  });
  await app.ready();
  db.prepare(
    `INSERT INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
  VALUES (?, ?, ?, '2026-11-14T11:00:00Z', '2027-01-01T00:00:00Z', '2026-11-14T10:00:00Z')`,
  ).run(
    KONTO,
    szyfrTestowy(db, 'tokeny_kanalu', 'access_token', KONTO, jwt(OFERTY)),
    szyfrTestowy(db, 'tokeny_kanalu', 'refresh_token', KONTO, 'REFRESH-ATRAPA'),
  );
});
afterEach(async () => {
  await app.close();
  db.close();
});

function kartaZOferta(oferta = {}) {
  const kartaId = utworzKarte(db, { nazwa: 'Lampa stołowa Gliwka', sku: 'GLW-1', cena_gr: 5900 }, { at: T0 });
  const o = wstawOferte(db, {
    kartaId,
    kanal: KONTO,
    idZewnetrzne: `ext:TEST-K${kartaId}`,
    stan: 'do_wyslania',
    pochodzenie: 'oms',
    tryb: 'zarzadzana',
    ...oferta,
  });
  return { kartaId, ofertaId: o.id };
}
const czynne = (wartosc) => zapiszUstawieniaOfertKonta(db, KONTO, { czynne: wartosc }, { teraz: T0 });

it('nagłówek oferty przed wysłaniem: nazwa konta, bez klucza konta i bez ext: na całej karcie', async () => {
  const { kartaId } = kartaZOferta();
  const k = await get(`/magazyn/${kartaId}`);
  expect(k.statusCode).toBe(200);
  expect(naglowki(k.body)).toContain(`Allegro · ${NAZWA}`);
  expect(naglowki(k.body).filter((h) => h.includes(KONTO))).toEqual([]);
  expect(k.body).not.toContain('ext:');
});

it('nagłówek oferty wysłanej ma numer oferty Allegro i nie ma zdania o czekaniu', async () => {
  czynne(false);
  const { kartaId } = kartaZOferta({ idZewnetrzne: '19137921550', stan: 'nieaktywna' });
  const k = await get(`/magazyn/${kartaId}`);
  expect(naglowki(k.body)).toContain(`Allegro · ${NAZWA} · oferta 19137921550`);
  expect(k.body).toContain('Ostatni odczyt: jeszcze nie odczytano');
  expect(k.body).not.toContain('Czeka');
});

it('oferta do wysłania na koncie z wstrzymanymi ofertami → zdanie o wstrzymaniu i odnośnik do kroku Oferty', async () => {
  czynne(false);
  const { kartaId } = kartaZOferta();
  const k = await get(`/magazyn/${kartaId}`);
  expect(k.body).toContain(WSTRZYMANE);
  expect(k.body).toContain(`href="${KROK}"`);
  expect(k.body).not.toContain('Czeka na wysłanie — OMS wysyła oferty co 5 minut.');
});

it('oferta do wysłania na czynnym koncie → zdanie o przebiegu co 5 minut; termin próby w przyszłości → godzina', async () => {
  czynne(true);
  const { kartaId, ofertaId } = kartaZOferta();
  const k = await get(`/magazyn/${kartaId}`);
  expect(k.body).toContain('Czeka na wysłanie — OMS wysyła oferty co 5 minut.');
  expect(k.body).not.toContain(WSTRZYMANE);
  zmienOferte(db, ofertaId, { nastepnaProbaAt: '2099-01-02T10:15:00.000Z', blad: 'Allegro odpowiedziało 429' });
  const p = await get(`/magazyn/${kartaId}`);
  expect(p.body).toContain('Następna próba: 02.01.2099 11:15.');
  expect(p.body).toContain('Allegro odpowiedziało 429');
});

it('ekran wyniku zatwierdzenia pokazuje ten sam powód w kolumnie Stan', async () => {
  czynne(false);
  const { kartaId } = kartaZOferta();
  const r = await get(`/magazyn/oferty/wynik?konto=${KONTO}&karty=${kartaId}`);
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('do wysłania');
  expect(r.body).toContain(WSTRZYMANE);
});

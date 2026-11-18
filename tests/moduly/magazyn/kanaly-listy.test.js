import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { zapiszProduktSklepowy, utworzKarte, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { wstawOferte, zmienOferte } from '../../../src/oms/db/oferty-kanalow.ts';

// Kolumna „Kanały” na liście Magazynu — jedna plakietka na
// każde połączenie, w którym karta jest dostępna. Dane zmyślone („Pracownia Półcień”).

const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
const DEFINICJE = [
  { klucz: 'sklep_polcien', typ: 'woo', prefiks: 'SKLEP_POLCIEN', etykieta: 'Sklep Półcień' },
  { klucz: 'allegro_druga', typ: 'allegro', prefiks: 'ALLEGRO_DRUGA', etykieta: 'Allegro Półcień Druga' },
  { klucz: 'allegro_pierwsza', typ: 'allegro', prefiks: 'ALLEGRO_PIERWSZA', etykieta: 'Allegro Półcień' },
  { klucz: 'erli_polcien', typ: 'erli', prefiks: 'ERLI_POLCIEN', etykieta: 'ERLI Pracownia' },
];

let db, app;
function serwer(definicje = DEFINICJE) {
  const sklepy = Object.fromEntries(definicje.filter((d) => d.typ === 'woo').map((d) => [d.klucz, {}]));
  const kanaly = Object.fromEntries(definicje.filter((d) => d.typ === 'allegro').map((d) => [d.klucz, {}]));
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' }, definicje, sklepy, kanaly },
    magazyn: { start: () => ({ wystartowal: true }), stan: () => ({ trwa: false, kanaly: [] }) },
  });
  return app;
}
// Migracje (m.in. `oferty_kanalow`) wykonuje start serwera — przed wstawianiem danych.
beforeEach(async () => {
  db = openOmsDb(':memory:');
  await serwer().ready();
});
afterEach(async () => {
  await app?.close();
  app = null;
  db.close();
});

let nr = 0;
function produkt(kartaId, kanal, zmiany = {}) {
  const id = zapiszProduktSklepowy(db, {
    kanal,
    produkt_id: `P-${++nr}`,
    wariant_id: '',
    nazwa: 'Lampa Półcień',
    odczytane_at: '2026-11-13T06:00:00.000Z',
    ...zmiany,
  });
  powiazProdukt(db, id, kartaId);
  return id;
}
const plakietki = (html) =>
  [...html.matchAll(/<span class="plakietka plakietka--kanal ([^"]*)"([^>]*)>([^<]*)<\/span>/g)].map(
    ([, klasy, atrybuty, znak]) => ({
      klasy,
      znak,
      title: /title="([^"]*)"/.exec(atrybuty)?.[1],
      aria: /aria-label="([^"]*)"/.exec(atrybuty)?.[1],
      rola: /role="([^"]*)"/.exec(atrybuty)?.[1],
    }),
  );
const lista = async () => {
  const r = await app.inject({ url: '/magazyn', headers: auth });
  expect(r.statusCode).toBe(200);
  return r.body;
};

describe('kolumna „Kanały” na liście Magazynu', () => {
  it('Woo + dwa konta Allegro (ACTIVE) → trzy plakietki w stałej kolejności, nazwa połączenia w title', async () => {
    const karta = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    produkt(karta, 'sklep_polcien');
    produkt(karta, 'allegro_druga', { status_publikacji: 'ACTIVE' });
    produkt(karta, 'allegro_pierwsza', { status_publikacji: 'ACTIVE' });
    const html = await lista();
    expect(html).toContain('<th>Kanały</th>');
    expect(html).not.toContain('<th>Oferty</th>');
    const p = plakietki(html);
    expect(p.map((x) => x.title)).toEqual(['Allegro Półcień', 'Allegro Półcień Druga', 'Sklep Półcień']);
    expect(p.map((x) => x.aria)).toEqual(['Allegro Półcień', 'Allegro Półcień Druga', 'Sklep Półcień']);
    expect(p.map((x) => x.znak)).toEqual(['a', 'a', 'W']);
    expect(p.map((x) => x.klasy)).toEqual(['plakietka--allegro', 'plakietka--allegro', 'plakietka--woo']);
    expect(p.every((x) => x.rola === 'img')).toBe(true);
  });

  it('oferta Allegro ENDED albo INACTIVE → bez plakietki; Woo bez statusu = obecność', async () => {
    const karta = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    produkt(karta, 'allegro_pierwsza', { status_publikacji: 'ENDED' });
    produkt(karta, 'allegro_druga', { status_publikacji: 'INACTIVE' });
    produkt(karta, 'sklep_polcien');
    expect(plakietki(await lista()).map((x) => x.title)).toEqual(['Sklep Półcień']);
  });

  it('konto Allegro z definicji bez konfiguracji klienta: ENDED → bez plakietki', async () => {
    await app.close();
    app = buildOmsServer({
      db,
      config: {
        auth: { user: 'operator', pass: 'atrapa' },
        definicje: DEFINICJE,
        sklepy: { sklep_polcien: {} },
        kanaly: {},
      },
      magazyn: { start: () => ({ wystartowal: true }), stan: () => ({ trwa: false, kanaly: [] }) },
    });
    await app.ready();
    const karta = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    produkt(karta, 'allegro_pierwsza', { status_publikacji: 'ENDED' });
    produkt(karta, 'allegro_druga', { status_publikacji: 'ACTIVE' });
    expect(plakietki(await lista()).map((x) => x.title)).toEqual(['Allegro Półcień Druga']);
  });

  it('produkt z ustawionym zniknal_at → bez plakietki, a karta bez kanałów ma kreskę', async () => {
    const karta = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    const a = produkt(karta, 'allegro_pierwsza', { status_publikacji: 'ACTIVE' });
    const w = produkt(karta, 'sklep_polcien');
    db.prepare("UPDATE produkty_sklepowe SET zniknal_at = '2026-11-12T06:00:00.000Z' WHERE id IN (?, ?)").run(a, w);
    const html = await lista();
    expect(html).toContain('<th>Kanały</th>');
    expect(plakietki(html)).toEqual([]);
  });

  it('ERLI w błędzie → plakietka wyszarzona ze stanem i błędem w title', async () => {
    const karta = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    const o = wstawOferte(db, { kartaId: karta, kanal: 'erli_polcien', idZewnetrzne: 'LMP-01', stan: 'blad' });
    zmienOferte(db, o.id, { blad: 'Brak cennika dostaw' });
    const [p, ...reszta] = plakietki(await lista());
    expect(reszta).toEqual([]);
    expect(p.klasy).toBe('plakietka--erli plakietka--nieaktywna');
    expect(p.znak).toBe('e');
    expect(p.title).toBe('ERLI Pracownia — błąd: Brak cennika dostaw');
    expect(p.aria).toBe(p.title);
  });

  it('ERLI aktywna → zwykła plakietka, obok Allegro w kolejności po typie', async () => {
    const karta = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    produkt(karta, 'sklep_polcien');
    wstawOferte(db, { kartaId: karta, kanal: 'erli_polcien', idZewnetrzne: 'LMP-01', stan: 'aktywna' });
    produkt(karta, 'allegro_pierwsza', { status_publikacji: 'ACTIVE' });
    const p = plakietki(await lista());
    expect(p.map((x) => [x.klasy, x.title])).toEqual([
      ['plakietka--allegro', 'Allegro Półcień'],
      ['plakietka--erli', 'ERLI Pracownia'],
      ['plakietka--woo', 'Sklep Półcień'],
    ]);
  });

  it('firma bez kanałów → bez kolumny', async () => {
    utworzKarte(db, { nazwa: 'Lampa Półcień' });
    await app.close();
    const r = await serwer([]).inject({ url: '/magazyn', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Lampa Półcień');
    expect(r.body).not.toContain('<th>Kanały</th>');
    expect(r.body).not.toContain('<th>Oferty</th>');
  });
});

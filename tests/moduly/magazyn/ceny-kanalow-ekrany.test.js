import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { powiazProdukt, utworzKarte, zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { jako } from '../../pomoc/panel-konta-testowe.js';

const PODGLAD = '/magazyn/ceny-kanalow/podglad';
const ZATWIERDZ = '/magazyn/ceny-kanalow/zatwierdz';
const PRZYCISK_LISTY = 'Wyślij ceny do kanałów — dla zaznaczonych';
const BRUTTO = 'sklep_polcien';
const NETTO = 'sklep_promien';
const ALLEGRO = 'aukcje_polcien';
const definicje = [
  { klucz: BRUTTO, typ: 'woo', prefiks: 'SKLEP_POLCIEN', etykieta: 'Sklep Półcień' },
  { klucz: NETTO, typ: 'woo', prefiks: 'SKLEP_PROMIEN', etykieta: 'Sklep Promień' },
  { klucz: ALLEGRO, typ: 'allegro', prefiks: 'AUKCJE_POLCIEN', etykieta: 'Allegro Półcień' },
];
const klucz = (id) => `${BRUTTO}|produkt:${id}`;
const podpis = (r) => /name="podpis" value="([^"]+)"/u.exec(r.body)?.[1];
const poleWyboru = (r, nazwa) =>
  [...r.body.matchAll(/<input\b[^>]+type="checkbox"[^>]*>/gu)].find(([tag]) => tag.includes(`name="${nazwa}"`))?.[0];

let app, db, karta, produkty, zapiszCenyHurtem;

function post(url, pola, login = 'opiekun', origin = 'http://localhost') {
  return app.inject({
    method: 'POST',
    url,
    headers: { ...jako(db, login), origin, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(pola).toString(),
  });
}
const podglad = () => post(PODGLAD, { karty: karta });
const formularzListy = (html) => /<form method="post" action="\/magazyn\/hurt">([\s\S]*?)<\/form>/u.exec(html)?.[1];
const przyciskListy = (formularz) =>
  [...formularz.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/gu)].find(
    ([, , tekst]) => tekst.trim() === PRZYCISK_LISTY,
  );

beforeEach(async () => {
  db = openOmsDb(':memory:');
  karta = utworzKarte(db, { nazwa: 'Lampa stołowa Półcień', cena_gr: 10000 });
  produkty = [
    { id: 10, name: 'Lampa mosiężna', regular_price: '95.00' },
    { id: 11, name: 'Lampa biała', regular_price: '90.00' },
    { id: 12, name: 'Lampa zielona', regular_price: '45.00' },
    { id: 13, name: 'Lampa w promocji', regular_price: '85.00', sale_price: '39.00' },
    { id: 14, name: 'Lampa wycofana', regular_price: '95.00', status: 'private' },
    { id: 15, name: 'Lampa bez zmiany', regular_price: '100.00' },
    { id: 16, name: 'Lampa granatowa', regular_price: '98.00' },
  ].map((p) => ({ type: 'simple', status: 'publish', ...p }));
  const powiaz = (kanal, id, nazwa) =>
    powiazProdukt(
      db,
      zapiszProduktSklepowy(db, {
        kanal,
        produkt_id: String(id),
        nazwa,
        status_publikacji: 'publish',
        odczytane_at: '2026-11-18T08:00:00.000Z',
      }),
      karta,
    );
  for (const p of produkty) powiaz(BRUTTO, p.id, p.name);
  powiaz(NETTO, 20, 'Lampa sklepowa netto');
  powiaz(ALLEGRO, 30, 'Lampa ze sterowaniem w Allegro');
  zalozKonto(db, { login: 'opiekun', imie: 'Opiekun', haslo: 'atrapa', rola: 'administrator', admin: true });
  zalozKonto(db, { login: 'pracownik', imie: 'Pracownik', haslo: 'atrapa', rola: 'pracownik', ekrany: ['magazyn'] });
  zapiszCenyHurtem = vi.fn(async (_rodzic, paczka) =>
    paczka.map(({ id }) => (id === '11' ? { id, ok: false, blad: 'Sklep odrzucił aktualizację' } : { id, ok: true })),
  );
  const sklep = (brutto) => ({
    ustawienieSklepu: async (klucz) => (klucz === 'woocommerce_calc_taxes' || brutto ? 'yes' : 'no'),
    pobierzStany: async (ids) => produkty.filter((p) => ids.includes(String(p.id))),
    zapiszCenyHurtem,
  });
  app = buildOmsServer({
    db,
    config: {
      auth: { user: 'serwis-testowy', pass: 'atrapa' },
      definicje,
      sklepy: { [BRUTTO]: {}, [NETTO]: {} },
      kanaly: { [ALLEGRO]: {} },
    },
    sklepy: { [BRUTTO]: sklep(true), [NETTO]: sklep(false) },
  });
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  db.close();
});

it('prowadzi z karty do podglądu i pokazuje blokady oraz domyślny wybór', async () => {
  const strona = await app.inject({ url: `/magazyn/${karta}`, headers: jako(db, 'opiekun') });
  expect(strona.statusCode).toBe(200);
  const formularz =
    /<form method="post" action="([^"]+)">\s*<input type="hidden" name="karty" value="([^"]+)">\s*<button[^>]+>Wyślij ceny do kanałów/u.exec(
      strona.body,
    );
  expect(formularz?.slice(1)).toEqual([PODGLAD, String(karta)]);
  const r = await post(formularz[1], { karty: formularz[2] });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain(`action="${ZATWIERDZ}"`);
  expect(podpis(r)).toBeTruthy();
  expect(poleWyboru(r, klucz(10))).toMatch(/\bchecked\b/u);
  expect(poleWyboru(r, klucz(12))).toBeDefined();
  expect(poleWyboru(r, klucz(12))).not.toMatch(/\b(?:checked|disabled)\b/u);
  for (const [nazwa, uwaga] of [
    [klucz(13), 'trwa promocja'],
    [klucz(14), 'status w sklepie'],
    [`${NETTO}|produkt:20`, 'sklep liczy ceny netto'],
    [`${ALLEGRO}|oferta:30`, 'cena prowadzona w Allegro'],
  ]) {
    expect(r.body).toContain(uwaga);
    expect(poleWyboru(r, nazwa)).toBeUndefined();
  }
  expect(r.body).toContain('duża zmiana');
  expect(r.body).not.toContain('Lampa bez zmiany');
});

it('pokazuje administratorowi przycisk podglądu cen w formularzu listy', async () => {
  const lista = await app.inject({ url: '/magazyn', headers: jako(db, 'opiekun') });
  expect(lista.statusCode).toBe(200);
  const formularz = formularzListy(lista.body);
  expect(formularz).toBeDefined();
  const przycisk = przyciskListy(formularz);
  expect(przycisk).toBeDefined();
  expect(przycisk[1]).toContain('type="submit"');
  expect(przycisk[1]).toContain(`formaction="${PODGLAD}"`);
});

it('ukrywa przycisk podglądu cen przed pracownikiem z dostępem do listy', async () => {
  const lista = await app.inject({ url: '/magazyn', headers: jako(db, 'pracownik') });
  expect(lista.statusCode).toBe(200);
  expect(lista.body).not.toContain(PRZYCISK_LISTY);
  expect(lista.body).not.toContain(`formaction="${PODGLAD}"`);
});

it('przechodzi z listy do podglądu cen obu zaznaczonych kart', async () => {
  const drugaKarta = utworzKarte(db, { nazwa: 'Lampa wisząca Półcień', cena_gr: 11000 });
  produkty.push({ id: 21, name: 'Lampa wisząca', regular_price: '100.00', type: 'simple', status: 'publish' });
  powiazProdukt(
    db,
    zapiszProduktSklepowy(db, {
      kanal: BRUTTO,
      produkt_id: '21',
      nazwa: 'Lampa wisząca',
      status_publikacji: 'publish',
      odczytane_at: '2026-11-18T08:00:00.000Z',
    }),
    drugaKarta,
  );
  const lista = await app.inject({ url: '/magazyn', headers: jako(db, 'opiekun') });
  expect(lista.statusCode).toBe(200);
  const formularz = formularzListy(lista.body);
  expect(formularz).toBeDefined();
  const przycisk = przyciskListy(formularz);
  const akcja = /\bformaction="([^"]+)"/u.exec(przycisk?.[1] ?? '')?.[1];
  expect(akcja).toBeDefined();
  const pola = [...formularz.matchAll(/<input type="checkbox" name="([^"]+)" value="(\d+)"[^>]*>/gu)]
    .map(([, nazwa, wartosc]) => [nazwa, wartosc])
    .filter(([, wartosc]) => [String(karta), String(drugaKarta)].includes(wartosc));
  expect(pola).toHaveLength(2);
  const r = await post(akcja, pola);
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Podgląd wysyłki cen');
  expect(poleWyboru(r, klucz(10))).toBeDefined();
  expect(poleWyboru(r, klucz(21))).toBeDefined();
  expect(zapiszCenyHurtem).not.toHaveBeenCalled();
});

it('przyjmuje 200 kart i odrzuca wybór 201 kart z komunikatem', async () => {
  const ids = [['karty', karta]];
  for (let i = 0; i < 199; i += 1) ids.push(['karty', utworzKarte(db, { nazwa: `Lampa ${i}` })]);
  expect((await post(PODGLAD, ids)).statusCode).toBe(200);
  ids.push(['karty', utworzKarte(db, { nazwa: 'Lampa zapasowa' })]);
  const r = await post(PODGLAD, ids);
  expect(r.statusCode).toBe(400);
  expect(r.body).toMatch(/zaznacz najwyżej 200 kart/iu);
});

it('odmawia podglądu pracownikowi z dostępem do magazynu', async () => {
  expect((await post(PODGLAD, { karty: karta }, 'pracownik')).statusCode).toBe(403);
});

it('odmawia zatwierdzenia pracownikowi z dostępem do magazynu', async () => {
  const r = await podglad();
  expect((await post(ZATWIERDZ, { podpis: podpis(r), [klucz(10)]: '1' }, 'pracownik')).statusCode).toBe(403);
  expect(zapiszCenyHurtem).not.toHaveBeenCalled();
});

it('odrzuca zatwierdzenie z obcego pochodzenia', async () => {
  const r = await podglad();
  expect(
    (await post(ZATWIERDZ, { podpis: podpis(r), [klucz(10)]: '1' }, 'opiekun', 'http://obcy.invalid')).statusCode,
  ).toBe(403);
  expect(zapiszCenyHurtem).not.toHaveBeenCalled();
});

it('zatwierdza wybrane pozycje i pokazuje zapisane, błędy i pominięte', async () => {
  const r = await podglad();
  produkty.find((p) => p.id === 16).regular_price = '97.00';
  const wynik = await post(ZATWIERDZ, { podpis: podpis(r), [klucz(10)]: '1', [klucz(11)]: '1', [klucz(16)]: '1' });
  expect(wynik.statusCode).toBe(200);
  for (const tekst of [
    'Zapisane (1)',
    'Błędy (1)',
    'Pominięte (1)',
    'Sklep odrzucił aktualizację',
    'cena w kanale zmieniła się od podglądu',
  ]) {
    expect(wynik.body).toContain(tekst);
  }
  expect(zapiszCenyHurtem).toHaveBeenCalledOnce();
  expect(zapiszCenyHurtem).toHaveBeenCalledWith(null, [
    { id: '10', regular_price: '100.00' },
    { id: '11', regular_price: '100.00' },
  ]);
});

it('przy wadliwym podpisie podaje powód i odsyła na kartę do ponownego podglądu', async () => {
  const wynik = await post(ZATWIERDZ, { podpis: 'wadliwy', karty: karta, [klucz(10)]: '1' });
  expect(wynik.statusCode).toBe(400);
  expect(wynik.body).toContain('Niepoprawny podpis podglądu');
  expect(wynik.body).toContain(`href="/magazyn/${karta}#sprzedaz-kanalow">otwórz podgląd ponownie</a>`);
  expect(zapiszCenyHurtem).not.toHaveBeenCalled();
});

it('odrzuca dopisanie wiersza z promocją do formularza', async () => {
  const r = await podglad();
  expect((await post(ZATWIERDZ, { podpis: podpis(r), [klucz(13)]: '1' })).statusCode).toBe(400);
  expect(zapiszCenyHurtem).not.toHaveBeenCalled();
});

it('pomija cenę, gdy promocja zacznie się po podglądzie', async () => {
  const r = await podglad();
  produkty.find((p) => p.id === 10).sale_price = '80.00';
  const wynik = await post(ZATWIERDZ, { podpis: podpis(r), [klucz(10)]: '1' });
  expect(wynik.statusCode).toBe(200);
  expect(wynik.body).toContain('Pominięte (1)');
  expect(wynik.body).toContain('trwa promocja');
  expect(zapiszCenyHurtem).not.toHaveBeenCalled();
});

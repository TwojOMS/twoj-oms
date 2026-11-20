import { afterEach, it, expect } from 'vitest';
import ejs from 'ejs';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia, ustawCzynne } from '../../../src/core/bezpieczenstwo/konta.js';
import { podmienLukiKsef } from '../../../src/oms/db/ostrzezenia.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { dodajRuch, przelaczStany } from '../../../src/oms/db/stany-magazynowe.js';
import { RODZAJE_OSTRZEZEN } from '../../../src/domena/powiadomienia.js';
import { powiadomieniaKonta } from '../../../src/oms/db/powiadomienia.js';
import { createKontekstZamowien } from '../../../src/moduly/zamowienia/kontekst.js';
import { createMigawkaPowiadomien } from '../../../src/moduly/zamowienia/services/migawka-powiadomien.js';
import { nowyPanel, jako, get, post, BASIC } from '../../pomoc/panel-konta-testowe.js';

const typy = [
  'integracja',
  'automatyzacja',
  'faktura-ksef',
  'faktura-termin',
  'pobranie-korekta',
  'zwrot-korekta',
  'przesylka',
  'niski-stan',
];
const panele = [];
afterEach(async () => {
  for (const p of panele.splice(0)) {
    await p.app.close();
    p.db.close();
  }
});
function panel() {
  const p = nowyPanel();
  panele.push(p);
  zalozKonto(p.db, { login: 'admin-test', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'sprzedawca-test', imie: 'Sprzedawca', haslo: 'h', rola: 'sprzedaz' });
  const id = kontoPoLoginie(p.db, 'sprzedawca-test').id;
  ustawUprawnienia(p.db, id, ['zamowienia']);
  return { ...p, id, admin: jako(p.db, 'admin-test'), osoba: jako(p.db, 'sprzedawca-test') };
}
const pola = (html) => html.match(/<input[^>]*type="checkbox"[^>]*>/gu) ?? [];

function migawkaFirmy(db) {
  const kontekst = createKontekstZamowien({ db, config: {} });
  return createMigawkaPowiadomien({ db, zbierz: (teraz) => kontekst.wierszeOstrzezenFirmy(teraz) });
}

it('zwykłe konto widzi aktywny dział Powiadomienia i ten sam opis na obu ekranach', async () => {
  const { app, osoba } = panel();
  const ustawienia = await get(app, '/ustawienia/powiadomienia', osoba);
  const konto = await get(app, '/konto/powiadomienia', osoba);
  expect(ustawienia.body).toContain('href="/ustawienia/powiadomienia" aria-current="page"');
  for (const ekran of [ustawienia, konto]) {
    expect(ekran.statusCode).toBe(200);
    expect(ekran.body).toContain('<h2>Co pokazuje dzwonek</h2>');
    expect(ekran.body).toContain(
      'Wybierz rodzaje powiadomień widoczne w dzwonku i na stronie Powiadomienia. Ten wybór dotyczy tylko Twojego konta. Awarii kanałów sprzedaży nie da się wyłączyć.',
    );
    expect(ekran.body).not.toContain('na Twojej liście zamówień');
  }
});

it('formularz pomija pole rodzaju, który jest zawsze widoczny', async () => {
  const html = await ejs.renderFile('src/moduly/ustawienia/widoki/ustawienia-powiadomienia.ejs', {
    zapisano: null,
    blad: null,
    niewidoczne: [],
    moznaZapisac: true,
    ukryte: [],
    rodzaje: [
      { typ: 'stale', nazwa: 'Powiadomienie stałe', opis: 'Zawsze widoczne', zawsze: true },
      { typ: 'wybieralne', nazwa: 'Powiadomienie wybieralne', opis: 'Widoczne według ustawień' },
    ],
  });

  expect(pola(html)).toEqual([expect.stringContaining('value="wybieralne"')]);
});

it('każdy zalogowany widzi siedem domyślnie zaznaczonych pól i link z Mojego konta', async () => {
  const { app, osoba, admin } = panel();
  const r = await get(app, '/ustawienia/powiadomienia', osoba);
  expect(r.statusCode).toBe(200);
  expect(pola(r.body)).toHaveLength(7);
  // Rodzaj „zawsze” nie ma pola — formularz mówi o nim jednym zdaniem (sprawdzone wyżej).
  for (const rodzaj of RODZAJE_OSTRZEZEN.filter((x) => !x.tylkoAdmin && !x.zawsze)) {
    expect(r.body.includes(rodzaj.nazwa)).toBe(true);
    expect(r.body.includes(rodzaj.opis)).toBe(true);
  }
  expect(r.body).not.toContain('value="automatyzacja"');
  for (const typ of typy.filter((t) => t !== 'automatyzacja'))
    expect(pola(r.body).find((p) => p.includes(`value="${typ}"`))).toContain('checked');
  const a = await get(app, '/ustawienia/powiadomienia', admin);
  expect(pola(a.body)).toHaveLength(8);
  expect((await get(app, '/konto', osoba)).body).toContain('href="/konto/powiadomienia"');
  expect((await get(app, '/magazyn/ustawienia', osoba)).statusCode).toBe(403);
});

it('POST zapisuje tylko wyłączone rodzaje per konto, a ponowny zapis włącza wszystko', async () => {
  const { app, db, id, osoba, admin } = panel();
  const r = await post(app, '/ustawienia/powiadomienia', osoba, { widoczne: typy.filter((t) => t !== 'faktura-ksef') });
  expect(r.statusCode).toBe(303);
  expect(
    JSON.parse(db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(`powiadomienia.ukryte.${id}`).wartosc),
  ).toEqual(['faktura-ksef']);
  const ekran = await get(app, r.headers.location, osoba);
  expect(ekran.body).toContain('Zapisano ustawienia powiadomień.');
  expect(pola(ekran.body).find((p) => p.includes('value="faktura-ksef"'))).not.toContain('checked');
  expect(pola((await get(app, '/ustawienia/powiadomienia', admin)).body).every((p) => p.includes('checked'))).toBe(
    true,
  );
  await post(app, '/ustawienia/powiadomienia', osoba, { widoczne: typy });
  expect(
    JSON.parse(db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(`powiadomienia.ukryte.${id}`).wartosc),
  ).toEqual([]);
});

it('nieznany rodzaj jest odrzucony, pusty formularz wyłącza wszystkie, pojedyncze pole też działa', async () => {
  const { app, db, id, osoba } = panel();
  expect((await post(app, '/ustawienia/powiadomienia', osoba, { widoczne: ['obcy'] })).statusCode).toBe(400);
  expect(db.prepare('SELECT * FROM ustawienia WHERE klucz = ?').get(`powiadomienia.ukryte.${id}`)).toBeUndefined();
  expect((await post(app, '/ustawienia/powiadomienia', osoba)).statusCode).toBe(303);
  expect(pola((await get(app, '/ustawienia/powiadomienia', osoba)).body).some((p) => p.includes('checked'))).toBe(
    false,
  );
  await post(app, '/ustawienia/powiadomienia', osoba, { widoczne: 'przesylka' });
  expect(
    pola((await get(app, '/ustawienia/powiadomienia', osoba)).body).filter((p) => p.includes('checked')),
  ).toHaveLength(1);
});

it('admin widzi bezpiecznik dopiero gdy wszystkie czynne konta wyłączą rodzaj', async () => {
  const { app, db, id, osoba, admin } = panel();
  const payload = { widoczne: typy.filter((t) => t !== 'faktura-ksef') };
  await post(app, '/ustawienia/powiadomienia', admin, payload);
  expect((await get(app, '/ustawienia/powiadomienia', admin)).body).not.toContain('Nikt w firmie nie widzi:');
  await post(app, '/ustawienia/powiadomienia', osoba, payload);
  expect((await get(app, '/ustawienia/powiadomienia', admin)).body).toContain(
    'Nikt w firmie nie widzi: Faktury niewysłane do KSeF.',
  );
  expect((await get(app, '/ustawienia/powiadomienia', osoba)).body).not.toContain('Nikt w firmie nie widzi:');
  await post(app, '/ustawienia/powiadomienia', osoba, { widoczne: typy });
  ustawCzynne(db, id, false);
  expect((await get(app, '/ustawienia/powiadomienia', admin)).body).toContain('Nikt w firmie nie widzi:');
});

it('konto bez id nie zapisuje; brak konta nie ukrywa ostrzeżeń', async () => {
  const p = nowyPanel();
  panele.push(p);
  podmienLukiKsef(p.db, [{ uuid: 'demo-luka', numer: 'FV-DEMO', invoiceDate: '2020-01-01' }]);
  expect((await post(p.app, '/ustawienia/powiadomienia', BASIC)).statusCode).toBe(403);
  await migawkaFirmy(p.db).przeliczTeraz();
  expect(powiadomieniaKonta(p.db, null).aktualne.map((w) => w.tekst)).toEqual([expect.stringContaining('FV-DEMO')]);
});

it('konto A ukrywa KSeF, konto B nadal widzi wiersz migawki, lustro i odrzucenia bez zmian', async () => {
  const { app, db, id, osoba } = panel();
  // Wiersz KSeF prowadzi do /faktury, więc widzi go tylko konto z prawem `faktury`.
  ustawUprawnienia(db, id, ['zamowienia', 'faktury']);
  podmienLukiKsef(db, [{ uuid: 'demo-luka', numer: 'FV-DEMO', invoiceDate: '2020-01-01' }]);
  await migawkaFirmy(db).przeliczTeraz();
  const faktury = (login) =>
    powiadomieniaKonta(db, kontoPoLoginie(db, login)).aktualne.filter((w) => w.typ === 'faktura-ksef');
  expect(faktury('sprzedawca-test')).toEqual([expect.objectContaining({ tekst: expect.stringContaining('FV-DEMO') })]);
  await post(app, '/ustawienia/powiadomienia', osoba, { widoczne: typy.filter((t) => t !== 'faktura-ksef') });
  expect(faktury('sprzedawca-test')).toEqual([]);
  expect(faktury('admin-test')).toEqual([expect.objectContaining({ tekst: expect.stringContaining('FV-DEMO') })]);
  expect(db.prepare('SELECT * FROM ksef_luki').all()).toHaveLength(1);
  expect(db.prepare('SELECT * FROM ostrzezenia_odrzucone').all()).toHaveLength(0);
});

it('w migawce niski stan podlega dostępowi, ustawieniom konta i odrzuceniu do zmiany stanu', async () => {
  const { app, db, id, osoba, admin } = panel();
  const kartaId = utworzKarte(db, { nazwa: 'Pracownia Półcień', sku: 'POLCIEN' });
  db.prepare('UPDATE karty_produktow SET prog_niskiego_stanu = 2 WHERE id = ?').run(kartaId);
  const migawka = migawkaFirmy(db);
  const wiersze = (login) =>
    powiadomieniaKonta(db, kontoPoLoginie(db, login)).aktualne.filter((w) => w.typ === 'niski-stan');
  await migawka.przeliczTeraz();
  expect(wiersze('admin-test')).toEqual([]);
  przelaczStany(db, { wlacz: true });
  await migawka.przeliczTeraz();
  expect(wiersze('sprzedawca-test')).toEqual([]);
  ustawUprawnienia(db, id, ['zamowienia', 'magazyn']);
  expect(wiersze('sprzedawca-test')).toHaveLength(1);

  expect(
    (await post(app, '/ustawienia/powiadomienia', osoba, { widoczne: typy.filter((t) => t !== 'niski-stan') }))
      .statusCode,
  ).toBe(303);
  expect(wiersze('sprzedawca-test')).toEqual([]);
  const klucz = `niski-stan:${kartaId}:0`;
  expect(wiersze('admin-test')).toEqual([
    expect.objectContaining({
      klucz,
      tekst: 'Niski stan: 1 karta (POLCIEN — 0 szt.)',
      przycisk: { href: '/magazyn?stan=niski', etykieta: 'Pokaż' },
    }),
  ]);
  expect((await post(app, '/ostrzezenia/odrzuc', admin, { klucz, powrot: '/' })).headers.location).toBe('/');
  expect(wiersze('admin-test')).toEqual([]);
  dodajRuch(db, { kartaId, rodzaj: 'korekta', ilosc: -3, powod: 'Inwentaryzacja', klucz: 'korekta' });
  await migawka.przeliczTeraz();
  expect(wiersze('admin-test')[0].tekst).toContain('Niski stan: 1 karta (POLCIEN — -3 szt.)');
});

it('POST z obcego Origin nie zapisuje ustawień', async () => {
  const { app, osoba } = panel();
  const r = await app.inject({
    method: 'POST',
    url: '/ustawienia/powiadomienia',
    headers: { ...osoba, origin: 'http://obca.invalid' },
    payload: {},
  });
  expect(r.statusCode).toBe(403);
});

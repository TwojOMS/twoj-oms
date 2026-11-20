// Akcje na powiadomieniach przez HTTP (POST + odczyt bazy): „Ignoruj”, „przeczytane”, „otwórz”.
// Pole `powrot` i adres przycisku trafiają do nagłówka Location, więc przepuszczamy tylko ścieżkę lokalną.
import { afterEach, it, expect } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, post, HTML } from '../../pomoc/panel-konta-testowe.js';

const T0 = '2026-11-18T10:00:00.000Z';
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
  const pakowaczId = zalozKonto(p.db, {
    login: 'pakowacz-test',
    imie: 'Pakowacz',
    haslo: 'h',
    rola: 'produkcja',
    ekrany: ['zamowienia'],
  });
  const wstaw = p.db.prepare(
    `INSERT INTO powiadomienia (klucz, typ, tekst, href, etykieta_przycisku, etykieta_odrzucenia, pilne,
      pierwszy_raz_at, ostatnio_at, rozwiazane_at) VALUES (?, ?, ?, ?, 'Pokaż', ?, ?, ?, ?, NULL)`,
  );
  const wiersz = (klucz, typ, href, { pilne = 0, odrzucenie = 'Ignoruj' } = {}) =>
    wstaw.run(klucz, typ, `Sprawa ${klucz}`, href, odrzucenie, pilne, T0, T0);
  wiersz('kanal:allegro_polcien:pilne', 'kanal', '/ustawienia/integracje', { pilne: 1, odrzucenie: null });
  wiersz('przesylka:p1:lampa', 'przesylka', '/zamowienia/1');
  wiersz('faktura-ksef:FV-1', 'faktura-ksef', '/faktury');
  wiersz('automatyzacja:wstrzymana:1:x', 'automatyzacja', '/zamowienia/3');
  wiersz('przesylka:obcy:1', 'przesylka', 'https://evil.invalid/x');
  wiersz('przesylka:obcy:2', 'przesylka', '//evil.invalid/x');
  wiersz('przesylka:obcy:3', 'przesylka', '/\\evil.invalid/x');
  return { ...p, pakowaczId, admin: jako(p.db, 'admin-test'), pakowacz: jako(p.db, 'pakowacz-test') };
}

const przeczytane = (db, kontoId) =>
  db
    .prepare('SELECT klucz FROM powiadomienia_przeczytane WHERE konto_id = ? ORDER BY klucz')
    .all(kontoId)
    .map((w) => w.klucz);

it('„Ignoruj” wraca tylko na ścieżkę lokalną; obcy albo brakujący powrót prowadzi na powiadomienia', async () => {
  const { app, db, pakowacz } = panel();
  const przypadki = [
    ['//evil.invalid', '/powiadomienia'],
    ['https://evil.invalid/', '/powiadomienia'],
    ['/\\evil.invalid', '/powiadomienia'],
    [undefined, '/powiadomienia'],
    ['/', '/'],
    ['/zamowienia?status=nowe', '/zamowienia?status=nowe'],
  ];
  for (const [powrot, cel] of przypadki) {
    const r = await post(app, '/ostrzezenia/odrzuc', pakowacz, { klucz: 'przesylka:p1:lampa', powrot });
    expect([r.statusCode, r.headers.location]).toEqual([303, cel]);
  }
  expect(
    db.prepare('SELECT odrzucone_przez FROM ostrzezenia_odrzucone WHERE klucz = ?').get('przesylka:p1:lampa'),
  ).toMatchObject({ odrzucone_przez: 'pakowacz-test' });
});

it('martwego kanału nie da się zignorować', async () => {
  const { app, db, admin } = panel();
  const r = await post(app, '/ostrzezenia/odrzuc', admin, { klucz: 'kanal:allegro_polcien:pilne', powrot: '/' });
  expect(r.statusCode).toBe(400);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ostrzezenia_odrzucone').get().n).toBe(0);
});

it('„przeczytane” zapisuje jeden klucz albo wszystkie widoczne — tylko dla tego konta', async () => {
  const { app, db, pakowacz, pakowaczId } = panel();
  let r = await post(app, '/powiadomienia/przeczytane', pakowacz, { klucz: 'przesylka:p1:lampa', powrot: '//evil' });
  expect([r.statusCode, r.headers.location]).toEqual([303, '/powiadomienia']);
  expect(przeczytane(db, pakowaczId)).toEqual(['przesylka:p1:lampa']);
  // Sprawa spoza praw konta nie zostawia śladu.
  await post(app, '/powiadomienia/przeczytane', pakowacz, { klucz: 'faktura-ksef:FV-1' });
  await post(app, '/powiadomienia/przeczytane', pakowacz, { klucz: 'automatyzacja:wstrzymana:1:x' });
  expect(przeczytane(db, pakowaczId)).toEqual(['przesylka:p1:lampa']);
  r = await post(app, '/powiadomienia/przeczytane', pakowacz, { wszystkie: '1', powrot: '/zamowienia' });
  expect(r.headers.location).toBe('/zamowienia');
  const wszystkie = przeczytane(db, pakowaczId);
  expect(wszystkie).toContain('kanal:allegro_polcien:pilne');
  expect(wszystkie).not.toContain('faktura-ksef:FV-1');
  expect(wszystkie).not.toContain('automatyzacja:wstrzymana:1:x');
  const adminId = db.prepare('SELECT id FROM konta WHERE login = ?').get('admin-test').id;
  expect(przeczytane(db, adminId)).toEqual([]);
});

it('„otwórz” oznacza przeczytane i prowadzi do przycisku tylko lokalnego i widocznego dla konta', async () => {
  const { app, db, pakowacz, pakowaczId } = panel();
  const otworz = (klucz) => post(app, `/powiadomienia/${encodeURIComponent(klucz)}/otworz`, pakowacz);
  let r = await otworz('przesylka:p1:lampa');
  expect([r.statusCode, r.headers.location]).toEqual([303, '/zamowienia/1']);
  for (const obcy of ['przesylka:obcy:1', 'przesylka:obcy:2', 'przesylka:obcy:3']) {
    r = await otworz(obcy);
    expect([obcy, r.headers.location]).toEqual([obcy, '/powiadomienia']);
  }
  for (const cudzy of ['faktura-ksef:FV-1', 'automatyzacja:wstrzymana:1:x', 'nie-ma:1']) {
    r = await otworz(cudzy);
    expect([cudzy, r.headers.location]).toEqual([cudzy, '/powiadomienia']);
  }
  expect(przeczytane(db, pakowaczId)).toEqual([
    'przesylka:obcy:1',
    'przesylka:obcy:2',
    'przesylka:obcy:3',
    'przesylka:p1:lampa',
  ]);
});

it('akcje bez nagłówka Origin z tej samej strony są odrzucane (CSRF)', async () => {
  const { app, db, pakowacz, pakowaczId } = panel();
  for (const url of ['/powiadomienia/przeczytane', '/powiadomienia/przesylka%3Ap1%3Alampa/otworz']) {
    const r = await app.inject({
      method: 'POST',
      url,
      headers: { ...HTML, ...pakowacz, origin: 'https://evil.invalid' },
      payload: { wszystkie: '1' },
    });
    expect([url, r.statusCode]).toEqual([url, 403]);
  }
  expect(przeczytane(db, pakowaczId)).toEqual([]);
});

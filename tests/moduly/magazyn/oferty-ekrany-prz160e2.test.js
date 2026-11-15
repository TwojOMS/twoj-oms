import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/kanaly-historyczne-fixture.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { ustawZnacznikAi } from '../../../src/moduly/magazyn/services/znacznik-ai.js';
import { ofertyKarty, wstawOferte, zmienOferte, ofertaPoId, zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { createPetlaOfert } from '../../../src/moduly/magazyn/services/petla-ofert.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

const kanal = 'erli-polcien';
const auth = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`, origin: 'http://localhost' };
let db, app, id, klient;
const post = (url, payload, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
const podglad = (zaznaczone = [id]) => post('/magazyn/oferty/podglad', { konto: kanal, zaznaczone });
const decyzja = r => ({ konto: kanal, zaznaczone: [id], podglad: /name="podglad" value="([^"]+)"/.exec(r.body)?.[1] });
const nowa = (zmiany = {}) => wstawOferte(db, { kartaId: id, kanal, idZewnetrzne: 'LMP-01', stan: 'aktywna', ...zmiany });
beforeEach(async () => {
  db = openOmsDb(':memory:');
  klient = { utworzProdukt: vi.fn(), zmienProdukt: vi.fn(), szukajProduktow: vi.fn(), zmienIlosciCeny: vi.fn(), pobierzProdukt: vi.fn() };
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' },
    // PRZ-160.P3a.02: kolumna „Kanały” bierze rodzaj i nazwę z definicji — konto ERLI testu musi w nich być.
    definicje: [...definicjeKanalowHistoryczne, { klucz: kanal, typ: 'erli', prefiks: 'ERLI_POLCIEN', etykieta: 'ERLI Półcień' }] },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: { 'kanaly.klienciKanalow': { [kanal]: klient }, 'kanaly.repozytoriumKanalow': {
      listaTypu: typ => typ === 'erli' ? [{ klucz: kanal, nazwa: 'Półcień' }] : [], zapisyZablokowane: () => false,
    } },
  });
  await app.ready();
  id = utworzKarte(db, { nazwa: 'Lampa Półcień', sku: 'LMP-01', cena_gr: 10000, stawka_vat: '23' });
  db.prepare("INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (?, 0, 'woo', 'https://polcien.example/lampa.png', '2026-11-13')").run(id);
  zapiszUstawieniaOfertKonta(db, kanal, { czynne: false, narzutProcent: 10, stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: 'Lampy', stawkaVat: '23' });
});
afterEach(async () => { await app.close(); db.close(); });

it('podgląd pokazuje dokładne ciało, ostrzeżenia i wstrzymanie; trasa nie woła kanału', async () => {
  const r = await podglad();
  expect(r.statusCode).toBe(200);
  for (const tekst of ['Oferty: wstrzymane', '110,00', 'Ilość: 5', 'Czas wysyłki: 2', 'TAX_23', 'Zdjęcia: 1', 'kategorii', 'aiGenerated', '11000']) expect(r.body).toContain(tekst);
  expect(ofertyKarty(db, id)).toHaveLength(0);
  const w = await post('/magazyn/oferty/zatwierdz', decyzja(r));
  expect(w.statusCode).toBe(200);
  expect(w.body).toContain('W kolejce: 1');
  expect(ofertyKarty(db, id)).toEqual([expect.objectContaining({ stan: 'do_wyslania', tryb: 'zarzadzana', pochodzenie: 'oms' })]);
  for (const f of Object.values(klient)) expect(f).not.toHaveBeenCalled();
});
it('bez podglądu nie tworzy wiersza', async () => {
  expect((await post('/magazyn/oferty/zatwierdz', { konto: kanal, zaznaczone: [id] })).statusCode).toBe(409);
  expect(ofertyKarty(db, id)).toHaveLength(0);
});
it('liczy ponownie po podglądzie i odmawia per karta, także usunięta', async () => {
  const drugi = utworzKarte(db, { nazwa: 'Lampa bez zdjęcia', sku: 'LMP-02' });
  const trzeci = utworzKarte(db, { nazwa: 'Lampa usunięta', sku: 'LMP-03' });
  const r = await podglad([id, drugi, trzeci]);
  expect(r.body).toContain('Dodaj co najmniej jedno zdjęcie');
  db.prepare('UPDATE karty_produktow SET cena_gr = NULL WHERE id = ?').run(id);
  db.prepare('DELETE FROM karty_produktow WHERE id = ?').run(trzeci);
  const w = await post('/magazyn/oferty/zatwierdz', { ...decyzja(r), zaznaczone: [id, drugi, trzeci], price: 1 });
  expect(w.body).toContain('Odmówiono: 3');
  expect(w.body).toContain('Karta produktu nie istnieje');
  expect(ofertyKarty(db, id)).toHaveLength(0);
});
it('istniejąca oferta jest osobną odmową; powtórne zatwierdzenie nie dubluje', async () => {
  nowa({ pochodzenie: 'przejeta', tryb: 'obserwowana' });
  const r = await podglad();
  expect(r.body).toContain('ma już ofertę');
  const w = await post('/magazyn/oferty/zatwierdz', decyzja(r));
  expect(w.body).toContain('Odmówiono: 1');
  expect(ofertyKarty(db, id)).toHaveLength(1);
});
it('braki ustawień odsyłają do kroku Oferty bez listy kart', async () => {
  zapiszUstawieniaOfertKonta(db, kanal, { stalaIlosc: null });
  const r = await podglad();
  expect(r.body).toContain(`/ustawienia/integracje/erli/${kanal}?krok=oferty`);
  expect(r.body).not.toContain('Lampa Półcień');
});
it('stara trasa znacznika karty usunięta; podgląd pokazuje decyzję pojedynczego zdjęcia', async () => {
  const r = await post(`/magazyn/${id}/oferty-ai`, { ai: 'tak' });
  expect(r.statusCode).toBe(404);
  const zdjecie = db.prepare('SELECT id FROM zdjecia_kart WHERE karta_id = ?').get(id);
  ustawZnacznikAi(db, { kartaId: id, zdjecieId: zdjecie.id, ai: 1 });
  const p = await podglad();
  expect(p.body).toContain('Zdjęcia wygenerowane przez AI: tak — zdjęcia: 1');
  expect(p.body).toContain('tego znacznika nie można później wyłączyć');
  expect(p.body).not.toContain('&#34;aiGenerated&#34;');
  const karta = await app.inject({ url: `/magazyn/${id}`, headers: auth });
  expect(karta.statusCode).toBe(200);
  expect(karta.body).not.toContain('oferty-ai');
});
it('zakres wszystkich pasujących zachowuje filtr ofert; podpis nie pozwala podmienić kart', async () => {
  const drugi = utworzKarte(db, { nazwa: 'Lampa z ofertą', sku: 'LMP-02' });
  nowa();
  const r = await post('/magazyn/oferty/podglad', { konto: kanal, zakres: 'pasujace', zawezenie: 'oferty=bez' });
  expect(r.body).toContain('Lampa z ofertą');
  expect(r.body).not.toContain('Lampa Półcień');
  expect((await post('/magazyn/oferty/zatwierdz', { ...decyzja(r), zaznaczone: [id, drugi] })).statusCode).toBe(409);
});
it('ponów czyści błąd i próby; obserwowana odmawia obu akcji', async () => {
  const o = nowa({ stan: 'blad' });
  zmienOferte(db, o.id, { blad: 'Błąd', liczbaProb: 3 });
  expect((await post(`/magazyn/${id}/oferty/${o.id}/ponow`, {})).statusCode).toBe(303);
  expect(ofertaPoId(db, o.id)).toMatchObject({ stan: 'do_wyslania', blad: null, liczbaProb: 0 });
  const ob = nowa({ idZewnetrzne: 'LMP-02', pochodzenie: 'przejeta', tryb: 'obserwowana', stan: 'problem' });
  for (const akcja of ['ponow', 'zdejmij']) expect((await post(`/magazyn/${id}/oferty/${ob.id}/${akcja}`, {})).statusCode).toBe(409);
});
it('zdejmij: pętla wysyła tylko inactive i nigdy nie przywraca ilości', async () => {
  const o = nowa();
  expect((await post(`/magazyn/${id}/oferty/${o.id}/zdejmij`, {})).statusCode).toBe(303);
  zapiszUstawieniaOfertKonta(db, kanal, { czynne: true });
  let status = 'active';
  const katalog = { odczytOfert: vi.fn(async () => ({ ok: true, dane: [{ externalId: o.idZewnetrzne, name: 'Lampa Półcień', status, price: 1, stock: 1, images: [] }] })),
    zmienOferte: vi.fn(async (_id, pola) => { status = pola.status; return { ok: true, dane: {} }; }),
    zmienIloscCene: vi.fn() };
  const petla = createPetlaOfert({ db, konta: () => [{ klucz: kanal, katalog }] });
  await petla.przebieg();
  await petla.przebieg();
  expect(katalog.zmienOferte.mock.calls).toEqual([[o.idZewnetrzne, { status: 'inactive' }]]);
  expect(katalog.zmienIloscCene).not.toHaveBeenCalled();
});
it('filtr i kolumna listy używają tego samego zbioru; karta pokazuje ofertę i problemy', async () => {
  const o = nowa({ stan: 'problem' });
  zmienOferte(db, o.id, { problemy: [{ kod: 'delivery', tekst: 'Popraw cennik dostaw' }], blad: 'Odmowa kanału', odczytanoAt: '2026-11-13T10:00:00Z' });
  for (const [filtr, ile] of [['bez', 0], ['z', 1], ['problem', 1]]) {
    const r = await app.inject({ url: `/magazyn?oferty=${filtr}`, headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<th>Kanały</th>');
    expect((r.body.match(/name="zaznaczone"/g) ?? []).length).toBe(ile);
    if (ile) expect(r.body).toContain('title="ERLI Półcień — problem: Odmowa kanału"');
  }
  const r = await app.inject({ url: `/magazyn/${id}`, headers: auth });
  for (const tekst of ['Popraw cennik dostaw', 'Odmowa kanału', 'Zdejmij ofertę', 'Wyślij ponownie', 'zarządzana', '13.11.2026']) expect(r.body).toContain(tekst);
});
it('odrzuca obcy CSRF oraz nie-admina', async () => {
  expect((await post('/magazyn/oferty/podglad', { konto: kanal, zaznaczone: [id] }, { ...auth, origin: 'https://obcy.example' })).statusCode).toBe(403);
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const user = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, user, ['magazyn']);
  const headers = { origin: 'http://localhost', cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}` };
  const o = nowa();
  for (const url of ['/magazyn/oferty/podglad', '/magazyn/oferty/zatwierdz', `/magazyn/${id}/oferty/${o.id}/zdejmij`, `/magazyn/${id}/oferty/${o.id}/ponow`]) expect((await post(url, { konto: kanal, zaznaczone: [id] }, headers)).statusCode).toBe(403);
});
it('ślad podglądu starszy niż 30 min nie pozwala zatwierdzić', async () => {
  const r = await podglad();
  const teraz = Date.now();
  const zegar = vi.spyOn(Date, 'now').mockReturnValue(teraz + 31 * 60_000);
  try {
    expect((await post('/magazyn/oferty/zatwierdz', decyzja(r))).statusCode).toBe(409);
  } finally { zegar.mockRestore(); }
  expect(ofertyKarty(db, id)).toHaveLength(0);
});
it('zdejmij odmawia oferty z konfliktem — pętla jej nie dotyka, więc nic by nie wyszło', async () => {
  const o = nowa({ stan: 'problem' });
  zmienOferte(db, o.id, { problemy: [{ kod: 'konflikt', tekst: 'Produkt o tym identyfikatorze już istnieje w ERLI.' }] });
  expect((await post(`/magazyn/${id}/oferty/${o.id}/zdejmij`, {})).statusCode).toBe(409);
  expect(ofertaPoId(db, o.id).wyslanePola?.zdejmij).toBeFalsy();
});

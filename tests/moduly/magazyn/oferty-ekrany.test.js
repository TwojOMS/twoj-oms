import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/przykladowe-definicje-kanalow.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { ustawZnacznikAi } from '../../../src/moduly/magazyn/services/znacznik-ai.js';
import {
  ofertyKarty,
  wstawOferte,
  zmienOferte,
  ofertaPoId,
  zapiszUstawieniaOfertKonta,
  ustawieniaOfertKonta,
  STALA_ILOSC_ZERO,
} from '../../../src/oms/db/oferty-kanalow.ts';
import { przelaczStany } from '../../../src/oms/db/stany-magazynowe.js';
import { createPetlaOfert } from '../../../src/moduly/magazyn/services/petla-ofert.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

const kanal = 'erli-polcien';
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
let db, app, id, klient;
const post = (url, payload, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
const get = (url, headers = auth) => app.inject({ method: 'GET', url, headers });
/** Zatwierdza podgląd jak przeglądarka: POST → 303 → GET ekranu wyniku. */
const zatwierdz = async (payload) => {
  const w = await post('/magazyn/oferty/zatwierdz', payload);
  expect(w.statusCode).toBe(303);
  return get(w.headers.location);
};
const podglad = (zaznaczone = [id]) => post('/magazyn/oferty/podglad', { konto: kanal, zaznaczone });
const decyzja = (r) => ({
  konto: kanal,
  zaznaczone: [id],
  podglad: /name="podglad" value="([^"]+)"/.exec(r.body)?.[1],
});
const nowa = (zmiany = {}) =>
  wstawOferte(db, { kartaId: id, kanal, idZewnetrzne: 'LMP-01', stan: 'aktywna', ...zmiany });
beforeEach(async () => {
  db = openOmsDb(':memory:');
  klient = {
    utworzProdukt: vi.fn(),
    zmienProdukt: vi.fn(),
    szukajProduktow: vi.fn(),
    zmienIlosciCeny: vi.fn(),
    pobierzProdukt: vi.fn(),
  };
  app = buildOmsServer({
    db,
    config: {
      auth: { user: 'operator', pass: 'atrapa' },
      // Kolumna „Kanały” bierze rodzaj i nazwę z definicji — konto ERLI testu musi w nich być.
      definicje: [
        ...definicjeKanalowHistoryczne,
        { klucz: kanal, typ: 'erli', prefiks: 'ERLI_POLCIEN', etykieta: 'ERLI Półcień' },
      ],
    },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': { [kanal]: klient },
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) => (typ === 'erli' ? [{ klucz: kanal, nazwa: 'Półcień' }] : []),
        zapisyZablokowane: () => false,
      },
    },
  });
  await app.ready();
  id = utworzKarte(db, { nazwa: 'Lampa Półcień', sku: 'LMP-01', cena_gr: 10000, stawka_vat: '23' });
  db.prepare(
    "INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (?, 0, 'woo', 'https://polcien.example/lampa.png', '2026-11-13')",
  ).run(id);
  zapiszUstawieniaOfertKonta(db, kanal, {
    czynne: false,
    narzutProcent: 10,
    stalaIlosc: 5,
    czasWysylkiDni: 2,
    cennikDostaw: 'Lampy',
    stawkaVat: '23',
  });
});
afterEach(async () => {
  await app.close();
  db.close();
});

it('podgląd pokazuje nazwę sklepu, jedną linię danych, ostrzeżenia i wstrzymanie; trasa nie woła kanału', async () => {
  const r = await podglad();
  expect(r.statusCode).toBe(200);
  for (const tekst of [
    'Oferty: wstrzymane',
    '<h2>ERLI · Półcień</h2>',
    'Cena: 110,00 zł · Ilość: 5 · Czas wysyłki: 2 dni robocze · VAT 23% · Zdjęcia: 1',
    'kategorii',
    '<button class="btn btn--glowny" type="submit">Wystaw oferty (1)</button>',
  ])
    expect(r.body).toContain(tekst);
  for (const tekst of [
    'Dokładna treść wysyłki',
    'aiGenerated',
    'TAX_23',
    'Nazwa: ',
    'etapie 4',
    'Ilość w ofertach: stała',
    'W kolejce:',
    'Zatwierdź karty bez błędów',
    `ERLI · ${kanal}`,
  ])
    expect(r.body).not.toContain(tekst);
  expect(ofertyKarty(db, id)).toHaveLength(0);
  const w = await zatwierdz(decyzja(r));
  expect(w.statusCode).toBe(200);
  for (const tekst of [
    '<h1>Oferty — Półcień</h1>',
    'W kolejce do wysłania: 1. OMS wysyła oferty w tle co 5 minut — ta strona pokazuje ich stan.</p>',
    `<a href="/magazyn/${id}#produkty-karty">`,
    // ERLI nie ma warunków konta, więc w kolumnie Stan stoi zdanie domyślne.
    '<td>do wysłania<p class="pasek-uwaga">Czeka na wysłanie — OMS wysyła oferty co 5 minut.</p></td>',
    '<td>—</td>',
  ])
    expect(w.body).toContain(tekst);
  // Zdania o szkicach i aktywacji dotyczą tylko Allegro.
  expect(w.body).not.toContain('szkice');
  expect(w.body).not.toContain('staną się aktywne');
  expect(ofertyKarty(db, id)).toEqual([
    expect.objectContaining({ stan: 'do_wyslania', tryb: 'zarzadzana', pochodzenie: 'oms' }),
  ]);
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
  const w = await zatwierdz({ ...decyzja(r), zaznaczone: [id, drugi, trzeci], price: 1 });
  expect(w.body.split('nie wysłano — popraw błędy z podglądu')).toHaveLength(4);
  expect(w.body).toContain(`<a href="/magazyn/${trzeci}#produkty-karty">Karta ${trzeci}</a>`);
  expect(w.body).toContain('W kolejce do wysłania: 0.');
  expect(ofertyKarty(db, id)).toHaveLength(0);
});
it('istniejąca oferta jest osobną odmową; powtórne zatwierdzenie nie dubluje', async () => {
  nowa({ pochodzenie: 'przejeta', tryb: 'obserwowana' });
  const r = await podglad();
  expect(r.body).toContain('ma już ofertę');
  const w = await zatwierdz(decyzja(r));
  // Wcześniejsza oferta jest już w sklepie: ekran wyniku pokazuje jej stan i numer zamiast „odmowy”.
  expect(w.body).toContain('Wszystkie oferty z tej partii zostały już wysłane.');
  expect(w.body).toContain('<td>aktywna</td>');
  expect(w.body).toContain('<td>LMP-01</td>');
  expect(w.body).not.toContain('Odmówiono');
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
  const OSTRZEZENIE_AI =
    'Zdjęcia 1 mogą być wygenerowane przez AI. OMS nie oznacza tego w ERLI — jeśli tak jest, zaznacz to w panelu ERLI (tego znacznika nie da się potem wyłączyć).';
  ustawZnacznikAi(db, { kartaId: id, zdjecieId: zdjecie.id, ai: 1 });
  let p = await podglad();
  expect(p.body).toContain(OSTRZEZENIE_AI);
  expect(p.body).not.toContain('aiGenerated');
  ustawZnacznikAi(db, { kartaId: id, zdjecieId: zdjecie.id, ai: 0 });
  p = await podglad();
  expect(p.body).not.toContain('mogą być wygenerowane przez AI');
  db.prepare('UPDATE zdjecia_kart SET ai = NULL WHERE id = ?').run(zdjecie.id);
  p = await podglad();
  expect(p.body).toContain(OSTRZEZENIE_AI);
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
  for (const akcja of ['ponow', 'zdejmij'])
    expect((await post(`/magazyn/${id}/oferty/${ob.id}/${akcja}`, {})).statusCode).toBe(409);
});
it('zdejmij: pętla wysyła tylko inactive i nigdy nie przywraca ilości', async () => {
  const o = nowa();
  expect((await post(`/magazyn/${id}/oferty/${o.id}/zdejmij`, {})).statusCode).toBe(303);
  zapiszUstawieniaOfertKonta(db, kanal, { czynne: true });
  let status = 'active';
  const katalog = {
    odczytOfert: vi.fn(async () => ({
      ok: true,
      dane: [{ externalId: o.idZewnetrzne, name: 'Lampa Półcień', status, price: 1, stock: 1, images: [] }],
    })),
    zmienOferte: vi.fn(async (_id, pola) => {
      status = pola.status;
      return { ok: true, dane: {} };
    }),
    zmienIloscCene: vi.fn(),
  };
  const petla = createPetlaOfert({ db, konta: () => [{ klucz: kanal, katalog }] });
  await petla.przebieg();
  await petla.przebieg();
  expect(katalog.zmienOferte.mock.calls).toEqual([[o.idZewnetrzne, { status: 'inactive' }]]);
  expect(katalog.zmienIloscCene).not.toHaveBeenCalled();
});
it('filtr i kolumna listy używają tego samego zbioru; karta pokazuje ofertę i problemy', async () => {
  const o = nowa({ stan: 'problem' });
  zmienOferte(db, o.id, {
    problemy: [{ kod: 'delivery', tekst: 'Popraw cennik dostaw' }],
    blad: 'Odmowa kanału',
    odczytanoAt: '2026-11-13T10:00:00Z',
  });
  for (const [filtr, ile] of [
    ['bez', 0],
    ['z', 1],
    ['problem', 1],
  ]) {
    const r = await app.inject({ url: `/magazyn?oferty=${filtr}`, headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<th>Kanały</th>');
    expect((r.body.match(/name="zaznaczone"/g) ?? []).length).toBe(ile);
    if (ile) expect(r.body).toContain('title="ERLI Półcień — problem: Odmowa kanału"');
  }
  const r = await app.inject({ url: `/magazyn/${id}`, headers: auth });
  for (const tekst of [
    'Popraw cennik dostaw',
    'Odmowa kanału',
    'Zdejmij ofertę',
    'Wyślij ponownie',
    'zarządzana',
    '13.11.2026',
  ])
    expect(r.body).toContain(tekst);
});
it('odrzuca obcy CSRF oraz nie-admina', async () => {
  expect(
    (
      await post(
        '/magazyn/oferty/podglad',
        { konto: kanal, zaznaczone: [id] },
        { ...auth, origin: 'https://obcy.example' },
      )
    ).statusCode,
  ).toBe(403);
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const user = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, user, ['magazyn']);
  const headers = {
    origin: 'http://localhost',
    cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}`,
  };
  const o = nowa();
  for (const url of [
    '/magazyn/oferty/podglad',
    '/magazyn/oferty/zatwierdz',
    `/magazyn/${id}/oferty/${o.id}/zdejmij`,
    `/magazyn/${id}/oferty/${o.id}/ponow`,
  ])
    expect((await post(url, { konto: kanal, zaznaczone: [id] }, headers)).statusCode).toBe(403);
});
it('ślad podglądu starszy niż 30 min nie pozwala zatwierdzić', async () => {
  const r = await podglad();
  const teraz = Date.now();
  const zegar = vi.spyOn(Date, 'now').mockReturnValue(teraz + 31 * 60_000);
  try {
    expect((await post('/magazyn/oferty/zatwierdz', decyzja(r))).statusCode).toBe(409);
  } finally {
    zegar.mockRestore();
  }
  expect(ofertyKarty(db, id)).toHaveLength(0);
});
it('zdejmij odmawia oferty z konfliktem — pętla jej nie dotyka, więc nic by nie wyszło', async () => {
  const o = nowa({ stan: 'problem' });
  zmienOferte(db, o.id, {
    problemy: [{ kod: 'konflikt', tekst: 'Produkt o tym identyfikatorze już istnieje w ERLI.' }],
  });
  expect((await post(`/magazyn/${id}/oferty/${o.id}/zdejmij`, {})).statusCode).toBe(409);
  expect(ofertaPoId(db, o.id).wyslanePola?.zdejmij).toBeFalsy();
});

const POMOC_BRAKOW =
  'Zapiszemy to w ustawieniach konta — dotyczy wszystkich ofert ERLI tego konta. Zmienisz to później w ustawieniach konta, krok „Oferty”.';
const uzupelnij = (pola, zaznaczone = [id], headers = auth) =>
  post('/magazyn/oferty/ustawienia-konta', { konto: kanal, zaznaczone, ...pola }, headers);
const wierszKarty = (body, kartaId) => body.includes(`<a href="/magazyn/${kartaId}">`);
const bezVatNaKarcie = (kartaId) =>
  db.prepare('UPDATE karty_produktow SET stawka_vat = NULL WHERE id = ?').run(kartaId);

it('konto bez ilości, czasu, VAT i cennika: podgląd ma formularz tylko z brakującymi polami i zero wierszy kart', async () => {
  zapiszUstawieniaOfertKonta(db, kanal, {
    stalaIlosc: null,
    czasWysylkiDni: null,
    stawkaVat: null,
    cennikDostaw: null,
  });
  bezVatNaKarcie(id);
  let r = await podglad();
  expect(r.statusCode).toBe(200);
  for (const tekst of [
    '<label for="uzupelnij-stalaIlosc">Ilość w ofertach (szt.)</label>',
    '<label for="uzupelnij-czasWysylkiDni">Czas wysyłki (dni robocze)</label>',
    '<label for="uzupelnij-stawkaVat">Stawka VAT</label>',
    '<option value="zw">zw</option>',
    POMOC_BRAKOW,
    '<button class="btn btn--glowny" type="submit">Zapisz i odśwież podgląd</button>',
    `/ustawienia/integracje/erli/${kanal}?krok=oferty#erli-krok-oferty">Konfigurator — Oferty</a>`,
  ])
    expect(r.body).toContain(tekst);
  // Cennik nie jest brakiem konta w podglądzie ERLI — wybiera się go przy karcie.
  expect(r.body).not.toContain('cennik dostaw');
  expect(wierszKarty(r.body, id)).toBe(false);
  expect(r.body).not.toContain('Wystaw oferty (');
  // Tylko brakujące: konto z samym brakiem czasu nie pokazuje pól ilości i VAT.
  zapiszUstawieniaOfertKonta(db, kanal, { stalaIlosc: 5, stawkaVat: '23' });
  r = await podglad();
  expect(r.body).toContain('name="czasWysylkiDni"');
  expect(r.body).not.toContain('name="stalaIlosc"');
  expect(r.body).not.toContain('name="stawkaVat"');
});

it('zapis ilości i czasu odświeża ten sam podgląd z wierszami kart; wartości trafiają do ustawień konta', async () => {
  zapiszUstawieniaOfertKonta(db, kanal, { stalaIlosc: null, czasWysylkiDni: null });
  const r = await uzupelnij({ stalaIlosc: ' 7 ', czasWysylkiDni: '3' });
  expect(r.statusCode).toBe(200);
  expect(r.body).not.toContain('Zapisz i odśwież podgląd');
  expect(wierszKarty(r.body, id)).toBe(true);
  expect(r.body).toContain('Ilość: 7');
  expect(r.body).toContain('Czas wysyłki: 3 dni robocze');
  expect(ustawieniaOfertKonta(db, kanal)).toMatchObject({ stalaIlosc: 7, czasWysylkiDni: 3, stawkaVat: '23' });
  const w = await zatwierdz(decyzja(r));
  expect(w.body).toContain('W kolejce do wysłania: 1.');
});

it('0 sztuk → 400 z komunikatem przy polu; nic nie zapisane, także poprawny czas z tego samego formularza', async () => {
  zapiszUstawieniaOfertKonta(db, kanal, { stalaIlosc: null, czasWysylkiDni: null });
  const r = await uzupelnij({ stalaIlosc: '0', czasWysylkiDni: '3' });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('aria-invalid="true" aria-describedby="blad-uzupelnij-stalaIlosc"');
  expect(r.body).toContain(`<p class="blad-pola pasek-blokada" id="blad-uzupelnij-stalaIlosc">${STALA_ILOSC_ZERO}</p>`);
  expect(r.body).toContain('name="stalaIlosc" value="0"');
  expect(r.body).toContain('name="czasWysylkiDni" value="3"');
  expect(wierszKarty(r.body, id)).toBe(false);
  expect(ustawieniaOfertKonta(db, kanal)).toMatchObject({ stalaIlosc: null, czasWysylkiDni: null });
  expect((await uzupelnij({ czasWysylkiDni: '366' })).statusCode).toBe(400);
  expect((await uzupelnij({ stawkaVat: '99' })).statusCode).toBe(400);
  expect(ustawieniaOfertKonta(db, kanal)).toMatchObject({ czasWysylkiDni: null, stawkaVat: '23' });
});

it('nie-admin dostaje 403 na zapisie i nic się nie zmienia; konto spoza ERLI → 400', async () => {
  zapiszUstawieniaOfertKonta(db, kanal, { czasWysylkiDni: null });
  // Przed założeniem kont: logowanie podstawowe z `auth` działa jako administrator tylko bez kont w bazie.
  const obce = await post('/magazyn/oferty/ustawienia-konta', {
    konto: 'nieznane',
    zaznaczone: [id],
    czasWysylkiDni: '3',
  });
  expect(obce.statusCode).toBe(400);
  expect(ustawieniaOfertKonta(db, 'nieznane').zapisane).toBe(false);
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const user = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, user, ['magazyn']);
  const headers = {
    origin: 'http://localhost',
    cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}`,
  };
  expect((await uzupelnij({ czasWysylkiDni: '3' }, [id], headers)).statusCode).toBe(403);
  expect(ustawieniaOfertKonta(db, kanal).czasWysylkiDni).toBeNull();
});

it('VAT konta nie blokuje, gdy każda wybrana karta ma VAT; karta bez VAT przywraca pole „Stawka VAT”', async () => {
  zapiszUstawieniaOfertKonta(db, kanal, { stawkaVat: null });
  let r = await podglad();
  expect(r.body).not.toContain('Uzupełnij ustawienia');
  expect(r.body).not.toContain('name="stawkaVat"');
  expect(wierszKarty(r.body, id)).toBe(true);
  expect(r.body).toContain('VAT 23%');
  const drugi = utworzKarte(db, { nazwa: 'Lampa bez VAT', sku: 'LMP-04', cena_gr: 9000 });
  bezVatNaKarcie(drugi);
  r = await podglad([id, drugi]);
  expect(r.body).toContain('<label for="uzupelnij-stawkaVat">Stawka VAT</label>');
  expect(wierszKarty(r.body, id)).toBe(false);
  expect(wierszKarty(r.body, drugi)).toBe(false);
});

it('objęcie zarządzaniem: karta z VAT przechodzi bez VAT konta; karta bez VAT dostaje brak', async () => {
  zapiszUstawieniaOfertKonta(db, kanal, { stawkaVat: null });
  const o = nowa({ pochodzenie: 'przejeta', tryb: 'obserwowana' });
  zmienOferte(db, o.id, { odczytCenaGr: 9000, odczytIlosc: 2 });
  const url = `/magazyn/${id}/oferty/${o.id}/objecie`;
  let r = await post(`${url}/podglad`, {});
  expect(r.statusCode).toBe(200);
  expect(r.body).not.toContain('stawka VAT');
  bezVatNaKarcie(id);
  r = await post(`${url}/podglad`, {});
  expect(r.body).toContain('Uzupełnij ustawienia: stawka VAT');
});

it('po zapisie ustawień stary token podglądu nie zatwierdza; nowy z odświeżonego podglądu tak', async () => {
  const stary = await podglad();
  expect(decyzja(stary).podglad).toBeTruthy();
  const r = await uzupelnij({ stalaIlosc: '9' });
  expect(r.statusCode).toBe(200);
  expect(decyzja(r).podglad).toBeTruthy();
  expect(decyzja(r).podglad).not.toBe(decyzja(stary).podglad);
  const odmowa = await post('/magazyn/oferty/zatwierdz', decyzja(stary));
  expect(odmowa.statusCode).toBe(409);
  expect(ofertyKarty(db, id)).toHaveLength(0);
  expect((await zatwierdz(decyzja(r))).body).toContain('W kolejce do wysłania: 1.');
});

it('przy włączonych stanach magazynowych brak stałej ilości nie blokuje i nie dostaje pola', async () => {
  zapiszUstawieniaOfertKonta(db, kanal, { stalaIlosc: null });
  przelaczStany(db, { wlacz: true, konto: { id: 1, login: 'tester' }, at: '2025-01-01T00:00:00Z' });
  const r = await podglad();
  expect(r.body).not.toContain('Uzupełnij ustawienia');
  expect(r.body).not.toContain('name="stalaIlosc"');
  expect(wierszKarty(r.body, id)).toBe(true);
});

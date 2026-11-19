// Magazyn → Cenniki: lista cenników OMS, formularz (dodanie, zmiana, odmowy 400 z wpisanymi wartościami), usuwanie
// z potwierdzeniem i odmową przy kartach, dostęp jak Magazyn → Ustawienia oraz „Cenniki w kanałach” (pobranie list
// Allegro i ERLI). Klienci Allegro i usługa sklepów ERLI to atrapy; konta i nazwy zmyślone.
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { POLLER, jako, get, post } from '../../pomoc/panel-konta-testowe.js';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import {
  cennikiOms,
  dodajCennikOms,
  ustawPowiazanieCennika,
  ustawCennikKarty,
} from '../../../src/oms/db/cenniki-oms.ts';
import { zapiszUstawieniaOfertKonta, ustawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';

const ALLEGRO = 'allegro_lampy';
const ERLI = 'erli_lampy';
const T0 = '2026-11-14T08:00:00.000Z';
const jwt = (scope) => ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');
const CENNIKI_ALLEGRO = [
  { id: 'cen-a', nazwa: 'Lampy — paczkomat A' },
  { id: 'cen-c', nazwa: 'Lampy — paczkomat C' },
  { id: 'cen-kurier', nazwa: 'Lampy — kurier' },
];
const CENNIKI_ERLI = ['Paczkomat A', 'Paczkomat C', 'Kurier gabaryt'];

let db, app, admin, ewa, ola, sklepyErli, klientAllegro;

/** Atrapa usługi sklepów ERLI: stan konta i operacja „pobierz-cenniki” (prawdziwą sprawdza test modułu kanałów). */
function atrapaSklepowErli() {
  const stan = {
    klucz: ERLI,
    nazwa: 'Lampy',
    zrodlo: 'konfigurator',
    wersja: 3,
    autoryzacja: 'polaczone',
    ustawienia: { sprawdzono: true, kolizja: false },
    kluczZapisany: true,
  };
  return {
    stan,
    pobierz: vi.fn((k) => (k === ERLI ? stan : null)),
    operacja: vi.fn(async () => ({ ok: true, klucz: ERLI })),
  };
}

const pusta = () => vi.fn(async () => []);
function atrapaAllegro() {
  return {
    pobierzCenniki: vi.fn(async () => [
      { id: 'cen-a', name: 'Lampy — paczkomat A' },
      { id: 'cen-nowy', name: 'Lampy — nowy paczkomat' },
    ]),
    pobierzZwroty: pusta(),
    pobierzReklamacje: pusta(),
    pobierzGwarancje: pusta(),
    pobierzProducentow: pusta(),
    pobierzOsobyOdpowiedzialne: pusta(),
  };
}

beforeEach(async () => {
  db = openOmsDb(':memory:');
  sklepyErli = atrapaSklepowErli();
  klientAllegro = atrapaAllegro();
  app = buildOmsServer({
    poller: POLLER,
    db,
    config: {
      auth: { user: 'serwis', pass: 'tajne-haslo' },
      definicje: [
        { klucz: ALLEGRO, typ: 'allegro', prefiks: 'ALLEGRO_LAMPY', etykieta: 'lampy_allegro' },
        { klucz: ERLI, typ: 'erli', prefiks: 'ERLI_LAMPY', etykieta: 'lampy.erli' },
      ],
    },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': { [ALLEGRO]: klientAllegro, [ERLI]: { utworzProdukt: vi.fn() } },
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) =>
          typ === 'allegro'
            ? [{ klucz: ALLEGRO, nazwa: 'Lampy', autoryzacja: 'polaczone', srodowisko: 'produkcja' }]
            : typ === 'erli'
              ? [{ klucz: ERLI, nazwa: 'Lampy' }]
              : [],
        zapisyZablokowane: () => false,
        konfliktKlucza: () => false,
      },
      'kanaly.sklepyErli': sklepyErli,
    },
  });
  await app.ready();
  db.prepare(
    `INSERT OR REPLACE INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
    VALUES (?, ?, ?, '2026-11-14T11:00:00Z', '2027-01-01T00:00:00Z', '2026-11-14T10:00:00Z')`,
  ).run(
    ALLEGRO,
    szyfrTestowy(
      db,
      'tokeny_kanalu',
      'access_token',
      ALLEGRO,
      jwt(['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read']),
    ),
    szyfrTestowy(db, 'tokeny_kanalu', 'refresh_token', ALLEGRO, 'REFRESH-ATRAPA'),
  );
  zapiszUstawieniaOfertKonta(
    db,
    ALLEGRO,
    { slowniki: { pobranoAt: T0, cenniki: CENNIKI_ALLEGRO } },
    { teraz: T0, aktor: 'adam' },
  );
  db.prepare(
    `INSERT INTO konfiguracja_integracji (integracja, ustawienia_json, sekrety_json, zmieniono_at) VALUES (?, ?, '{}', ?)`,
  ).run(`erli:${ERLI}`, JSON.stringify({ cennikiDostaw: CENNIKI_ERLI, cennikiPobranoAt: T0 }), T0);
  zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(db, kontoPoLoginie(db, 'ewa').id, ['zamowienia', 'magazyn']);
  zalozKonto(db, { login: 'ola', imie: 'Ola', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(db, kontoPoLoginie(db, 'ola').id, ['magazyn', 'ustawienia']);
  admin = jako(db, 'adam');
  ewa = jako(db, 'ewa');
  ola = jako(db, 'ola');
});

const podmenu = (html) =>
  /<ul class="oms-podmenu-lista"[^>]*data-podmenu-lista="magazyn"[\s\S]*?<\/ul>/u.exec(html)?.[0] ?? '';
const pozycja = (html, napis) => new RegExp(`<a href="([^"]+)"([^>]*)>${napis}</a>`, 'u').exec(podmenu(html));
const PACZKA = {
  nazwa: 'Mała paczka',
  rodzaj: 'rozmiar',
  a_cm: '8',
  b_cm: '38',
  c_cm: '64',
  waga_kg: '25',
  [`powiazanie:${ALLEGRO}`]: 'cen-a',
  [`powiazanie:${ERLI}`]: 'Paczkomat A',
};
const dodaj = (pola, kto = admin) => post(app, '/magazyn/cenniki', kto, pola);
const liczba = () => db.prepare('SELECT COUNT(*) AS n FROM cenniki_dostaw_oms').get().n;
const karta = (n) => utworzKarte(db, { nazwa: `Lampa Gliwka ${n}`, sku: `GLW-${n}`, cena_gr: 5900 }, { at: T0 });

describe('Magazyn → Cenniki: dostęp', () => {
  it.each(['/magazyn/cenniki', '/magazyn/cenniki/nowy'])(
    'konto Sprzedaż bez uprawnienia „Ustawienia” dostaje odmowę pod %s',
    async (adres) => {
      expect((await get(app, adres, ewa)).statusCode).toBe(403);
    },
  );

  it('konto bez uprawnienia nie zapisze cennika ani nie pobierze list kanału', async () => {
    expect((await dodaj(PACZKA, ewa)).statusCode).toBe(403);
    expect(liczba()).toBe(0);
    expect((await post(app, `/magazyn/cenniki/kanal/${ERLI}/pobierz`, ewa, { wersja: '3' })).statusCode).toBe(403);
    expect(sklepyErli.operacja).not.toHaveBeenCalled();
  });

  it('konto z uprawnieniem „Ustawienia” wchodzi', async () => {
    expect((await get(app, '/magazyn/cenniki', ola)).statusCode).toBe(200);
    expect((await get(app, '/magazyn/cenniki/nowy', ola)).statusCode).toBe(200);
  });

  it('podmenu Magazynu ma „Cenniki” między „Producenci” a „Ustawienia”, tylko dla konta z uprawnieniem', async () => {
    const html = (await get(app, '/magazyn', admin)).body;
    expect(pozycja(html, 'Cenniki')?.[1]).toBe('/magazyn/cenniki');
    const menu = podmenu(html);
    expect(menu.indexOf('>Producenci<')).toBeLessThan(menu.indexOf('>Cenniki<'));
    expect(menu.indexOf('>Cenniki<')).toBeLessThan(menu.indexOf('>Ustawienia<'));
    const bez = await get(app, '/magazyn', ewa);
    expect(bez.statusCode).toBe(200);
    expect(pozycja(bez.body, 'Cenniki')).toBeNull();
  });

  it('na ekranie cenników pozycja „Cenniki” jest bieżąca, a dział Magazyn aktywny', async () => {
    const r = await get(app, '/magazyn/cenniki', admin);
    expect(pozycja(r.body, 'Cenniki')?.[2]).toContain('aria-current="page"');
    expect(pozycja(r.body, 'Produkty')?.[2]).not.toContain('aria-current');
    expect(r.body).toMatch(/<a href="\/magazyn" aria-current="page">/u);
    const nowy = await get(app, '/magazyn/cenniki/nowy', admin);
    expect(pozycja(nowy.body, 'Cenniki')?.[2]).toContain('aria-current="true"');
  });

  it('zakodowany adres nie omija odmowy', async () => {
    expect((await get(app, '/magazyn/%63enniki', ewa)).statusCode).toBe(403);
  });
});

describe('Magazyn → Cenniki: dodanie i zmiana', () => {
  it('dodaje cennik rozmiaru z powiązaniami i pokazuje go na liście', async () => {
    const r = await dodaj(PACZKA);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/magazyn/cenniki?zapisano=dodano');
    const [c] = cennikiOms(db);
    expect(c).toMatchObject({ nazwa: 'Mała paczka', rodzaj: 'rozmiar', doMm: [640, 380, 80], doG: 25000 });
    expect(c.powiazania.map((p) => [p.konto, p.cennikKanalu, p.aktor])).toEqual([
      [ALLEGRO, 'cen-a', 'adam'],
      [ERLI, 'Paczkomat A', 'adam'],
    ]);
    const lista = (await get(app, r.headers.location, admin)).body;
    expect(lista).toContain('Cennik dodany.');
    expect(lista).toContain('Mała paczka');
    expect(lista).toContain('do 64 × 38 × 8 cm, 25 kg');
    expect(lista).toContain('Lampy — paczkomat A');
    expect(lista).toContain('Allegro · lampy_allegro');
    expect(lista).toContain('ERLI · lampy.erli');
  });

  it('dodaje cennik domyślny i cennik tylko na kartę bez wymiarów', async () => {
    expect((await dodaj({ nazwa: 'Kurier', rodzaj: 'domyslny' })).statusCode).toBe(303);
    expect((await dodaj({ nazwa: 'Wysyłka paletowa', rodzaj: 'karta' })).statusCode).toBe(303);
    expect(cennikiOms(db).map((c) => [c.nazwa, c.rodzaj, c.doMm])).toEqual(
      expect.arrayContaining([
        ['Kurier', 'domyslny', null],
        ['Wysyłka paletowa', 'karta', null],
      ]),
    );
    const lista = (await get(app, '/magazyn/cenniki', admin)).body;
    expect(lista).toContain('domyślny — produkty większe od cenników rozmiaru');
    expect(lista).toContain('tylko na karcie');
  });

  it('zmienia nazwę i powiązania; niezmienione powiązanie zostaje z dawną datą i autorem', async () => {
    const id = dodajCennikOms(db, { nazwa: 'Mała paczka', doMm: [80, 380, 640], doG: 25000 }, { teraz: T0 });
    ustawPowiazanieCennika(db, { cennikId: id, konto: ALLEGRO, cennikKanalu: 'cen-a' }, { teraz: T0, aktor: 'ola' });
    ustawPowiazanieCennika(db, { cennikId: id, konto: ERLI, cennikKanalu: 'Paczkomat A' }, { teraz: T0 });
    expect((await get(app, `/magazyn/cenniki/${id}`, admin)).body).toContain('value="Mała paczka"');
    const r = await post(app, `/magazyn/cenniki/${id}`, admin, {
      ...PACZKA,
      nazwa: 'Paczkomat A',
      [`powiazanie:${ERLI}`]: '',
    });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/magazyn/cenniki?zapisano=zmieniono');
    const [c] = cennikiOms(db);
    expect(c.nazwa).toBe('Paczkomat A');
    expect(c.powiazania).toEqual([{ konto: ALLEGRO, cennikKanalu: 'cen-a', zmienionoAt: T0, aktor: 'ola' }]);
  });

  it('powiązanie z kontem, którego już nie ma, nie ma kolumny i zostaje po zapisie', async () => {
    const id = dodajCennikOms(db, { nazwa: 'Kurier' }, { teraz: T0 });
    ustawPowiazanieCennika(db, { cennikId: id, konto: 'allegro_dawne', cennikKanalu: 'cen-x' }, { teraz: T0 });
    const lista = (await get(app, '/magazyn/cenniki', admin)).body;
    expect(lista).not.toContain('allegro_dawne');
    const r = await post(app, `/magazyn/cenniki/${id}`, admin, { nazwa: 'Kurier', rodzaj: 'karta' });
    expect(r.statusCode).toBe(303);
    expect(cennikiOms(db)[0].powiazania.map((p) => p.konto)).toEqual(['allegro_dawne']);
  });

  it('drugi cennik domyślny → 400 z wpisanymi wartościami, nic nie zapisane', async () => {
    dodajCennikOms(db, { nazwa: 'Kurier', domyslny: true }, { teraz: T0 });
    const r = await dodaj({ nazwa: 'Kurier gabaryt', rodzaj: 'domyslny' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Domyślny jest już cennik „Kurier”');
    expect(r.body).toContain('value="Kurier gabaryt"');
    expect(liczba()).toBe(1);
  });

  it('zmiana jedynego domyślnego na domyślny przechodzi', async () => {
    const id = dodajCennikOms(db, { nazwa: 'Kurier', domyslny: true }, { teraz: T0 });
    const r = await post(app, `/magazyn/cenniki/${id}`, admin, { nazwa: 'Kurier DPD', rodzaj: 'domyslny' });
    expect(r.statusCode).toBe(303);
    expect(cennikiOms(db)[0]).toMatchObject({ nazwa: 'Kurier DPD', rodzaj: 'domyslny' });
  });

  it.each([
    ['mała paczka', 'Mała Paczka'],
    ['Żółta', 'ŻÓŁTA'],
    ['Paczka  mała', 'paczka mała'],
  ])('nazwa „%s” zajęta → „%s” dostaje 400', async (pierwsza, druga) => {
    dodajCennikOms(db, { nazwa: pierwsza }, { teraz: T0 });
    const r = await dodaj({ nazwa: druga, rodzaj: 'karta' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Cennik o takiej nazwie już jest');
    expect(liczba()).toBe(1);
  });

  it('zmiana cennika na jego własną nazwę inną wielkością liter przechodzi', async () => {
    const id = dodajCennikOms(db, { nazwa: 'żółta' }, { teraz: T0 });
    expect((await post(app, `/magazyn/cenniki/${id}`, admin, { nazwa: 'Żółta', rodzaj: 'karta' })).statusCode).toBe(
      303,
    );
  });

  it('nazwa dłuższa niż 60 znaków → 400 (liczone znaki, nie bajty)', async () => {
    const r = await dodaj({ nazwa: 'Ż'.repeat(61), rodzaj: 'karta' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Nazwa ma od 1 do 60 znaków');
    expect(liczba()).toBe(0);
    expect((await dodaj({ nazwa: 'Ż'.repeat(60), rodzaj: 'karta' })).statusCode).toBe(303);
  });

  it('pusta nazwa → 400', async () => {
    const r = await dodaj({ nazwa: '   ', rodzaj: 'karta' });
    expect(r.statusCode).toBe(400);
    expect(liczba()).toBe(0);
  });

  it('cennik rozmiaru bez wagi albo z błędnym wymiarem → 400 z wpisanymi wartościami', async () => {
    const r = await dodaj({ ...PACZKA, waga_kg: '' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Podaj trzy wymiary i wagę');
    expect(r.body).toContain('value="64"');
    expect((await dodaj({ ...PACZKA, a_cm: 'osiem' })).statusCode).toBe(400);
    expect(liczba()).toBe(0);
  });

  it('cennik rozmiaru z tymi samymi limitami co inny → 400', async () => {
    dodajCennikOms(db, { nazwa: 'Paczkomat', doMm: [80, 380, 640], doG: 25000 }, { teraz: T0 });
    const r = await dodaj({ ...PACZKA, a_cm: '64', c_cm: '8' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Te same wymiary i waga są już w cenniku „Paczkomat”');
    expect(liczba()).toBe(1);
  });

  it('cennik kanału spoza pobranej listy konta → 400', async () => {
    const r = await dodaj({ ...PACZKA, [`powiazanie:${ALLEGRO}`]: 'cen-obcy' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Wybierz cennik z listy konta');
    expect(liczba()).toBe(0);
  });

  it('konto ERLI bez pobranej listy: cennik wpisany tekstem, dłuższy niż 200 znaków → 400', async () => {
    db.prepare('UPDATE konfiguracja_integracji SET ustawienia_json = ? WHERE integracja = ?').run('{}', `erli:${ERLI}`);
    const formularz = (await get(app, '/magazyn/cenniki/nowy', admin)).body;
    expect(formularz).toContain('Lista cenników tego konta nie jest pobrana');
    expect(formularz).toMatch(new RegExp(`<input[^>]*name="powiazanie:${ERLI}"`, 'u'));
    const r = await dodaj({ ...PACZKA, [`powiazanie:${ERLI}`]: 'x'.repeat(201) });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('do 200 znaków');
    expect(liczba()).toBe(0);
    expect((await dodaj({ ...PACZKA, [`powiazanie:${ERLI}`]: 'Paczkomat wpisany' })).statusCode).toBe(303);
    expect(cennikiOms(db)[0].powiazania.find((p) => p.konto === ERLI)?.cennikKanalu).toBe('Paczkomat wpisany');
  });

  it('konto Allegro bez pobranej listy: bez pola do wpisania, wpisany identyfikator → 400', async () => {
    zapiszUstawieniaOfertKonta(db, ALLEGRO, { slowniki: null }, { teraz: T0, aktor: 'adam' });
    const formularz = (await get(app, '/magazyn/cenniki/nowy', admin)).body;
    expect(formularz).toContain('Allegro przyjmuje tylko cennik z listy konta');
    expect(formularz).not.toMatch(new RegExp(`<input(?![^>]*type="hidden")[^>]*name="powiazanie:${ALLEGRO}"`, 'u'));
    const r = await dodaj({ ...PACZKA, [`powiazanie:${ALLEGRO}`]: 'cen-wpisany' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Pobierz najpierw listę cenników konta');
    expect(liczba()).toBe(0);
  });

  it('zapisany cennik kanału, którego nie ma już na liście konta, zostaje i jest oznaczony', async () => {
    const id = dodajCennikOms(db, { nazwa: 'Kurier', domyslny: true }, { teraz: T0 });
    ustawPowiazanieCennika(db, { cennikId: id, konto: ALLEGRO, cennikKanalu: 'cen-stary' }, { teraz: T0 });
    expect((await get(app, '/magazyn/cenniki', admin)).body).toContain('nie ma go już w Allegro');
    expect((await get(app, `/magazyn/cenniki/${id}`, admin)).body).toContain('spoza listy konta');
    const r = await post(app, `/magazyn/cenniki/${id}`, admin, {
      nazwa: 'Kurier',
      rodzaj: 'domyslny',
      [`powiazanie:${ALLEGRO}`]: 'cen-stary',
    });
    expect(r.statusCode).toBe(303);
  });

  it('nieistniejący cennik → 404', async () => {
    expect((await get(app, '/magazyn/cenniki/999', admin)).statusCode).toBe(404);
    expect((await post(app, '/magazyn/cenniki/999', admin, { nazwa: 'X', rodzaj: 'karta' })).statusCode).toBe(404);
  });
});

describe('Magazyn → Cenniki: usuwanie', () => {
  it('cennik bez kart: potwierdzenie, potem usunięcie razem z powiązaniami', async () => {
    const id = dodajCennikOms(db, { nazwa: 'Mała paczka', doMm: [80, 380, 640], doG: 25000 }, { teraz: T0 });
    ustawPowiazanieCennika(db, { cennikId: id, konto: ALLEGRO, cennikKanalu: 'cen-a' }, { teraz: T0 });
    const potw = await get(app, `/magazyn/cenniki/${id}/usun`, admin);
    expect(potw.statusCode).toBe(200);
    expect(potw.body).toContain('Usunąć cennik „Mała paczka”?');
    const r = await post(app, `/magazyn/cenniki/${id}/usun`, admin);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/magazyn/cenniki?zapisano=usunieto');
    expect(liczba()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cenniki_dostaw_powiazania').get().n).toBe(0);
  });

  it('cennik wybrany na kartach → odmowa z liczbą kart, nic nie usunięte', async () => {
    const id = dodajCennikOms(db, { nazwa: 'Wysyłka paletowa' }, { teraz: T0 });
    ustawCennikKarty(db, { kartaId: karta(1), cennikId: id }, { teraz: T0 });
    ustawCennikKarty(db, { kartaId: karta(2), cennikId: id }, { teraz: T0 });
    const potw = await get(app, `/magazyn/cenniki/${id}/usun`, admin);
    expect(potw.body).toContain('Cennik jest wybrany na 2 kartach — zmień je najpierw');
    expect(potw.body).toContain('Lampa Gliwka 1');
    expect(potw.body).not.toMatch(/<form[^>]*action="\/magazyn\/cenniki\/\d+\/usun"/u);
    const r = await post(app, `/magazyn/cenniki/${id}/usun`, admin);
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain('Cennik jest wybrany na 2 kartach');
    expect(liczba()).toBe(1);
  });

  it('usunięcie domyślnego przy cennikach rozmiaru ostrzega o odmowie na kontach', async () => {
    const maly = dodajCennikOms(db, { nazwa: 'Mała paczka', doMm: [80, 380, 640], doG: 25000 }, { teraz: T0 });
    const dom = dodajCennikOms(db, { nazwa: 'Kurier', domyslny: true }, { teraz: T0 });
    ustawPowiazanieCennika(db, { cennikId: maly, konto: ALLEGRO, cennikKanalu: 'cen-a' }, { teraz: T0 });
    ustawPowiazanieCennika(db, { cennikId: dom, konto: ALLEGRO, cennikKanalu: 'cen-kurier' }, { teraz: T0 });
    const potw = (await get(app, `/magazyn/cenniki/${dom}/usun`, admin)).body;
    expect(potw).toContain('Produkty większe od cenników rozmiaru dostaną odmowę na kontach: Allegro · lampy_allegro');
  });
});

describe('Magazyn → Cenniki: cenniki w kanałach', () => {
  it('lista pokazuje pobrane cenniki kont z liczbą i datą pobrania', async () => {
    const html = (await get(app, '/magazyn/cenniki', admin)).body;
    expect(html).toContain(`id="kanal-${ALLEGRO}"`);
    expect(html).toContain(`id="kanal-${ERLI}"`);
    expect(html).toContain('Kurier gabaryt');
    expect(html).toContain('Pobierz cenniki z ERLI');
    expect(html).toContain('Pobierz cenniki z Allegro');
  });

  it('„Pobierz cenniki z ERLI” woła operację konta z wersją formularza i wraca z komunikatem', async () => {
    const r = await post(app, `/magazyn/cenniki/kanal/${ERLI}/pobierz`, admin, { wersja: '3' });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/magazyn/cenniki?pobrano=${ERLI}#kanal-${ERLI}`);
    expect(sklepyErli.operacja).toHaveBeenCalledWith(
      ERLI,
      'pobierz-cenniki',
      { wersja: '3' },
      expect.objectContaining({ login: 'adam' }),
    );
    expect((await get(app, r.headers.location, admin)).body).toContain('Pobrano cenniki konta ERLI · lampy.erli');
  });

  it('odmowa ERLI (zły klucz) wraca na ekran z komunikatem i statusem', async () => {
    sklepyErli.operacja.mockResolvedValueOnce({
      ok: false,
      status: 400,
      komunikat: 'Nieprawidłowy klucz API. Sprawdź klucz w panelu ERLI.',
    });
    const r = await post(app, `/magazyn/cenniki/kanal/${ERLI}/pobierz`, admin, { wersja: '3' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Nieprawidłowy klucz API. Sprawdź klucz w panelu ERLI.');
  });

  it('konto ERLI z pliku konfiguracji albo niesprawdzone: przycisk wyłączony, odnośnik do konfiguratora', async () => {
    sklepyErli.stan.ustawienia = { sprawdzono: false };
    const html = (await get(app, '/magazyn/cenniki', admin)).body;
    expect(html).toContain(`/ustawienia/integracje/erli/${ERLI}#erli-krok-dane`);
  });

  it('„Pobierz cenniki z Allegro” zapisuje listę konta', async () => {
    const r = await post(app, `/magazyn/cenniki/kanal/${ALLEGRO}/pobierz`, admin);
    expect(r.statusCode).toBe(303);
    expect(klientAllegro.pobierzCenniki).toHaveBeenCalledTimes(1);
    expect(ustawieniaOfertKonta(db, ALLEGRO).slowniki.cenniki).toEqual([
      { id: 'cen-a', nazwa: 'Lampy — paczkomat A' },
      { id: 'cen-nowy', nazwa: 'Lampy — nowy paczkomat' },
    ]);
    expect((await get(app, '/magazyn/cenniki', admin)).body).toContain('Lampy — nowy paczkomat');
  });

  it('odmowa Allegro (401): komunikat, lista bez zmian', async () => {
    klientAllegro.pobierzCenniki.mockRejectedValueOnce(Object.assign(new Error('401'), { status: 401 }));
    const r = await post(app, `/magazyn/cenniki/kanal/${ALLEGRO}/pobierz`, admin);
    expect(r.statusCode).toBe(502);
    expect(r.body).toContain('Allegro odmówiło pobrania list konta.');
    expect(ustawieniaOfertKonta(db, ALLEGRO).slowniki.cenniki).toEqual(CENNIKI_ALLEGRO);
  });

  it('nieznane konto → 404', async () => {
    expect((await post(app, '/magazyn/cenniki/kanal/obce/pobierz', admin)).statusCode).toBe(404);
  });
});

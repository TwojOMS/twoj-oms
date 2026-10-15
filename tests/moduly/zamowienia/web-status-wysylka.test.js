import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajZwrot } from '../../../src/oms/db/zwroty.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { createWooAdapter } from '../../../src/oms/woo/adapter.js';
import { createPoller } from '../../../src/moduly/kanaly/services/poller.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { wyliczStatus } from '../../../src/domena/status.js';

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

const zmapowane = (id, nad = {}) => ({
  zrodlo_id: id, numer: String(id), klient: { first_name: 'Jan', last_name: 'Kowalski', email: 'j@k.pl' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '212.90',
  koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-07-29T13:19:52',
  pozycje: [{ nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '61.50', brutto_linii: '123.00', vat: null }],
  ...nad,
});

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
  await app.ready();
});

// Przebudowa karty 2026-07-31: formularze statusu i metody wysylki siedza za „Edytuj"
// w panelu „Szczegoly zamowienia" (?edytuj=szczegoly) — karta jest domyslnie TYLKO DO
// ODCZYTU. Same reguly i trasy sa nietkniete, zmienilo sie wylacznie to, gdzie formularz
// widac, wiec helper otwiera od razu tryb edycji.
const karta = (id, query = '?edytuj=szczegoly') => app.inject({ method: 'GET', url: `/zamowienia/${id}${query}`, headers: naglowek });
const wyslij = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });
const status = (id) => wyliczStatus(pobierzZamowienie(db, id));
const wpisyLogu = (id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ?').all(id);

const nadanaPaczka = (id, kolejnosc = 1, numerListu = '0000123456789A') => db.prepare(
  'INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at)'
  + " VALUES (?, 'dpd', 'nadana', ?, ?, '2026-07-30T10:00:00')",
).run(id, numerListu, kolejnosc);

// ---------------------------------------------------------------------------------
// A. ZMIANA STATUSU
// ---------------------------------------------------------------------------------
describe('POST /zamowienia/:id/status — status zapisuje FAKTY', () => {
  it('„w realizacji" ustawia znacznik i status karty', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1601), {});
    const r = await wyslij(`/zamowienia/${id}/status`, { status: 'w_realizacji' });
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).w_realizacji_at).toBeTruthy();
    expect(status(id)).toBe('w_realizacji');
  });

  // ⚠️ 08.2026 (Zadanie 3): „zwrot" ZNIKLO z STATUSY_RECZNE — rejestracja idzie teraz
  // przez tabele `zwroty` (db/zwroty.js), nie przez ten formularz. Test byl „«zwrot»
  // zapisuje date I powod jednym zapisem" — dzis dokumentuje, ze ta droga jest ZAMKNIETA,
  // niezaleznie od tego, czy pole „powod" przyszlo w zadaniu.
  it('„zwrot" jest odrzucany — rejestracja idzie teraz przez tabelę zwroty, nie przez ten formularz', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1602), {});
    const r = await wyslij(`/zamowienia/${id}/status`, { status: 'zwrot', powod: 'uszkodzony w transporcie' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/Nieznany status/i);
    const z = pobierzZamowienie(db, id);
    expect(z.zwrot_at).toBeNull();
    expect(status(id)).toBe('nowe');

    // Bez pola „powod" odrzucane jest dokladnie tak samo — nie jest to brakujace pole,
    // ktore blokuje, tylko caly status.
    const bezPowodu = await wyslij(`/zamowienia/${id}/status`, { status: 'zwrot' });
    expect(bezPowodu.statusCode).toBe(400);
    expect(pobierzZamowienie(db, id).zwrot_powod).toBeNull();
  });

  it('„nowe" cofa wszystkie reczne fakty (w tym stary `zwrot_at`)', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1603), {});
    await wyslij(`/zamowienia/${id}/status`, { status: 'w_realizacji' });
    // Symulacja starego znacznika `zwrot_at`/`zwrot_powod` (droga sprzed Zadania 3, ktora
    // POST /status juz nie zapisuje) — „nowe" ma go skasowac dokladnie tak samo, jak
    // kazdy inny reczny fakt.
    db.prepare('UPDATE zamowienia SET zwrot_at = ?, zwrot_powod = ? WHERE id = ?')
      .run('2026-07-01T10:00:00Z', 'pomyłka', id);
    await wyslij(`/zamowienia/${id}/status`, { status: 'nowe' });
    const z = pobierzZamowienie(db, id);
    expect(z.zwrot_at).toBeNull();
    expect(z.zwrot_powod).toBeNull();
    expect(z.w_realizacji_at).toBeNull();
    expect(status(id)).toBe('nowe');
  });

  it('„anulowane" ustawia znacznik reczny, a NIE kolumne ze sklepu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1604), {});
    await wyslij(`/zamowienia/${id}/status`, { status: 'anulowane' });
    // Kolumna `anulowane` nalezy do sklepu — poller ja przepisuje. Reczne anulowanie
    // MUSI mieszkac obok, inaczej zniknie przy najblizszej synchronizacji.
    expect(db.prepare('SELECT anulowane, anulowane_recznie FROM zamowienia WHERE id = ?').get(id))
      .toEqual({ anulowane: 0, anulowane_recznie: 1 });
    expect(status(id)).toBe('anulowane');
  });

  // Reczne anulowanie blokuje nadanie i fakture dokladnie tak samo, jak anulowanie ze sklepu —
  // inaczej „anulowane" na karcie byloby wylacznie napisem.
  it('reczne anulowanie blokuje nadanie tak samo jak anulowanie ze sklepu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1605), {});
    await wyslij(`/zamowienia/${id}/status`, { status: 'anulowane' });
    const z = pobierzZamowienie(db, id);
    expect(z.anulowane).toBe(1);
    expect((await karta(id)).body).toContain('ANULOWANE');
  });

  it('reczne anulowanie da sie cofnac (panel nie wchodzi w stan bez wyjscia)', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1606), {});
    await wyslij(`/zamowienia/${id}/status`, { status: 'anulowane' });
    const r = await wyslij(`/zamowienia/${id}/status`, { status: 'nowe' });
    expect(r.statusCode).toBe(302);
    expect(status(id)).toBe('nowe');
  });

  // ⚠️ 08.2026: cel „zwrot" zastapiony „wyslane" — status 'zwrot' jest juz odrzucany
  // (patrz test wyzej), wiec nie powstaje z niego zaden wpis logu do sprawdzenia.
  it('kazda zmiana idzie do logu jako DECYZJA CZLOWIEKA, z nazwa uzytkownika', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1607), {});
    await wyslij(`/zamowienia/${id}/status`, { status: 'wyslane' });
    const wpis = wpisyLogu(id).find((w) => w.akcja === 'status.reczny');
    expect(wpis).toBeTruthy();
    expect(wpis.wynik).toContain('DECYZJA CZŁOWIEKA (adam)');
    expect(wpis.wynik).toContain('Wysłane');
  });

  it('nieistniejace zamowienie → 404, bez nagłówka Origin → 403', async () => {
    expect((await wyslij('/zamowienia/999/status', { status: 'nowe' })).statusCode).toBe(404);
    const id = zapiszZamowienie(db, 'pro', zmapowane(1608), {});
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/status`, payload: { status: 'nowe' },
      headers: { authorization: naglowek.authorization },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('granice recznej zmiany statusu', () => {
  // ⚠️ ZMIANA 2026-07-31: „wyslane" JEST juz do ustawienia recznie i zapisuje wlasny fakt
  // (`wyslane_at`). Wczesniej wynikalo z istnienia nadanej paczki i bylo odmawiane, ale
  // etykieta powstaje przy PAKOWANIU, a paczka wyjezdza dopiero z kurierem — momentu
  // wyjazdu panel nie zna, zna go czlowiek.
  it('„wyslane" zapisuje date wysylki i podnosi status', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1611), {});
    const r = await wyslij(`/zamowienia/${id}/status`, { status: 'wyslane' });
    expect(r.statusCode).toBe(302);
    expect(status(id)).toBe('wyslane');
    expect(pobierzZamowienie(db, id).wyslane_at).toBeTruthy();
  });

  it('karta PROPONUJE „Wysłane" w liscie wyboru', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1612), {});
    const body = (await karta(id)).body;
    expect(body).toContain('Zmień');
    expect(body).toContain('value="wyslane"');
  });

  // Cofniecie pomylki: „W realizacji" MUSI skasowac date wysylki, inaczej status
  // wrocilby na „Wyslane" przy pierwszym odswiezeniu karty.
  it('cofniecie z „wyslane" na „w_realizacji" kasuje date wysylki', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1627), {});
    await wyslij(`/zamowienia/${id}/status`, { status: 'wyslane' });
    await wyslij(`/zamowienia/${id}/status`, { status: 'w_realizacji' });
    expect(status(id)).toBe('w_realizacji');
    expect(pobierzZamowienie(db, id).wyslane_at).toBeNull();
  });

  // ⚠️ Anulowanie dziala TYLKO w jedna strone. Odanulowanie zamowienia anulowanego przez
  // klienta w sklepie otworzyloby droge do nadania mu paczki.
  // ⚠️ 08.2026: 'zwrot' zastapione 'wyslane' — 'zwrot' zniknelo z STATUSY_RECZNE (Zadanie 3),
  // wiec proba ustawienia go dostaje dzis „Nieznany status" NIEZALEZNIE od anulowania
  // (patrz test „nieznany status → 400" nizej) i nie sprawdzalaby juz galezi, ktora ten
  // test ma chronic.
  it.each(['nowe', 'w_realizacji', 'wyslane'])('zamowienia anulowanego W SKLEPIE nie da sie przestawic na „%s"', async (docelowy) => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1613, { anulowane: 1 }), {});
    const r = await wyslij(`/zamowienia/${id}/status`, { status: docelowy, powod: 'x' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/wycofaj anulowanie w sklepie/i);
    expect(status(id)).toBe('anulowane');
    expect(pobierzZamowienie(db, id).w_realizacji_at).toBeNull();
  });

  it('zdanie na karcie o wycofaniu anulowania W SKLEPIE zostaje prawdziwe', async () => {
    const zeSklepu = zapiszZamowienie(db, 'pro', zmapowane(1614, { anulowane: 1 }), {});
    expect((await karta(zeSklepu)).body).toContain('najpierw wycofaj anulowanie w sklepie');

    // ...ale przy anulowaniu RECZNYM to zdanie byloby klamstwem — tam wyjscie jest w panelu.
    const recznie = zapiszZamowienie(db, 'pro', zmapowane(1615), {});
    await wyslij(`/zamowienia/${recznie}/status`, { status: 'anulowane' });
    const body = (await karta(recznie)).body;
    expect(body).not.toContain('najpierw wycofaj anulowanie w sklepie');
    expect(body).toContain('ANULOWANE ręcznie w panelu');
  });

  // Zaslepka „nie do ustawienia recznie" zniknela razem z odmowa: kazdy status z listy
  // odpowiada teraz stanowi, ktory da sie ustawic. Lista ma pokazywac status BIEZACY.
  it('lista wyboru startuje na statusie biezacym', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1620), {});
    await wyslij(`/zamowienia/${id}/status`, { status: 'wyslane' });
    const body = (await karta(id)).body;
    expect(body).toContain('<option value="wyslane" selected>');
    expect(body).not.toContain('<option value="nowe" selected>');
  });

  it('zatwierdzenie bez wybrania statusu ma wlasny komunikat, nie „Nieznany status"', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1626), {});
    const r = await wyslij(`/zamowienia/${id}/status`, { status: '' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/Nie wybrano statusu/i);
    expect(status(id)).toBe('nowe');
  });

  it('nieznany status → 400, bez zmian w bazie', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1616), {});
    const r = await wyslij(`/zamowienia/${id}/status`, { status: 'wymyslony' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/Nieznany status/i);
    expect(status(id)).toBe('nowe');
  });

  // ⚠️ ZMIANA 2026-07-31: nadanie paczki NIE PODNOSI juz statusu. Etykieta powstaje przy
  // pakowaniu, wiec zamowienie zostaje „w realizacji" i NIE SCHODZI z listy roboczej,
  // dopoki czlowiek nie powie, ze paczka pojechala. O to prosil wlasciciel wprost.
  it('nadanie paczki NIE zmienia statusu na „wyslane"', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1617), {});
    await wyslij(`/zamowienia/${id}/status`, { status: 'w_realizacji' });
    nadanaPaczka(id);
    expect(status(id)).toBe('w_realizacji');
  });

  // ...a log ma pokazywac status FAKTYCZNIE osiagniety. Rozjazd wyboru z faktami jest dzis
  // rzadszy (paczka nie podnosi juz statusu), ale anulowanie ze sklepu nadal potrafi wygrac.
  it('log zapisuje status FAKTYCZNIE osiagniety, nie sam wybor', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1618, { anulowane: 1 }), {});
    await wyslij(`/zamowienia/${id}/status`, { status: 'anulowane' });
    const wpis = wpisyLogu(id).find((w) => w.akcja === 'status.reczny');
    expect(wpis.wynik).toContain('Anulowane');
  });

  // ⚠️ ZMIANA 2026-08-14 (Zadanie 4, ekran zwrotu): `POST /zamowienia/:id/zwrot` PRZESTAJE
  // byc 404 — sciezka zostala CELOWO PONOWNIE UZYTA dla nowego ekranu rejestracji zwrotu
  // (routes/zwroty.js), zupelnie innej funkcji niz dawny (dalej nieistniejacy) reczny
  // przelacznik statusu. Test pilnuje teraz drugiej polowy tego samego niezmiennika:
  // /realizacja dalej nie istnieje, a /zwrot NIE dziala jak dawny przelacznik statusu —
  // formularz bez daty i pozycji odbija sie o regule domeny (400 z domain/zwrot.js),
  // a status zamowienia zostaje nietkniety.
  it('stara trasa /realizacja juz nie istnieje; /zwrot to teraz NOWY ekran (Zadanie 4), nie dawny przelacznik statusu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1619), {});
    expect((await wyslij(`/zamowienia/${id}/realizacja`, {})).statusCode).toBe(404);
    const r = await wyslij(`/zamowienia/${id}/zwrot`, { powod: 'x' });
    expect(r.statusCode).toBe(400);
    expect(status(id)).toBe('nowe');
  });

  // Zadanie Z3a (plan „ekran nadania", 04.08): pole „powód (przy zwrocie)" znika z belki
  // statusu na karcie — zwroty wracają jako osobny etap i tego pola wtedy w tym miejscu
  // nie będzie. Kolumna `zwrot_powod` i faktyDlaStatusu() zostają nietknięte (patrz testy
  // wyżej), zmienia się WYŁĄCZNIE to, co widać w formularzu.
  it('formularz zmiany statusu w belce NIE ma już pola „powód"', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1628), {});
    const body = (await karta(id, '')).body;
    expect(body).not.toContain('name="powod"');
    expect(body).not.toContain('pole-powod');
  });

  // ⚠️ 08.2026 (Zadanie 3): oryginalny test „zmiana statusu BEZ pola «powód» w żądaniu
  // zachowuje powód już zapisany" sprawdzal galaz 'zwrot' w `faktyDlaStatusu`, ktora jest
  // dzis nieosiagalna przez ten formularz (patrz test wyzej). Przepisany na to, co NADAL
  // jest prawda i wciaz warte ochrony: ODMOWA to CALKOWITY no-op — nie ma prawa ruszyc
  // zadnego faktu lezacego juz w bazie (np. stary `zwrot_powod` sprzed tej zmiany),
  // niezaleznie od tego, czy proba przyszla z polem „powod", czy bez niego.
  it('odrzucona proba „zwrot" nie rusza istniejacego (starego) `zwrot_powod`', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1629), {});
    db.prepare('UPDATE zamowienia SET zwrot_at = ?, zwrot_powod = ? WHERE id = ?')
      .run('2026-07-01T10:00:00Z', 'stary powod', id);

    await wyslij(`/zamowienia/${id}/status`, { status: 'zwrot', powod: 'nowy powod' });
    expect(pobierzZamowienie(db, id).zwrot_powod).toBe('stary powod');

    // Kolejna proba, TAK jak wysyla ja formularz bez pola „powod".
    await wyslij(`/zamowienia/${id}/status`, { status: 'zwrot' });
    expect(pobierzZamowienie(db, id).zwrot_powod).toBe('stary powod');
  });
});

// ---------------------------------------------------------------------------------
// B. METODA WYSYLKI
// ---------------------------------------------------------------------------------
describe('POST /zamowienia/:id/wysylka/metoda', () => {
  // ⚠️ DWA POLA, NIE JEDNO (2026-08-01): formularz oddaje dostawe i pobranie osobno.
  it('przelacza na pobranie z kwota i oznacza zmiane na karcie', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1621), {});
    const r = await wyslij(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd', pobranie: '1', kwota_pobrania: '246.00' });
    expect(r.statusCode).toBe(302);
    const z = pobierzZamowienie(db, id);
    expect(z.metoda_wysylki).toBe('dpd');
    expect(z.pobranie).toBe(1);
    expect(z.kwota_pobrania).toBe('246.00');
    const body = (await karta(id)).body;
    expect(body).toContain('DPD (pobranie)');
    expect(body).toContain('zmienione ręcznie');
  });

  // Brak pola wyboru w formularzu znaczy „bez pobrania" — przegladarka nie przysyla
  // odznaczonego pola w ogole, wiec to jest jedyna droga do wylaczenia inkasa.
  it('brak pola „pobranie" w formularzu WYLACZA pobranie ze sklepu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1620, { pobranie: 1, kwota_pobrania: '246.00' }), {});
    expect(pobierzZamowienie(db, id).pobranie).toBe(1);
    await wyslij(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd' });
    const z = pobierzZamowienie(db, id);
    expect(z.pobranie).toBe(0);
    expect(z.kwota_pobrania).toBeNull();
  });

  // ⚠️ TO SA PIENIADZE — paczka za pobraniem bez kwoty to paczka, za ktora kurier nic
  // nie zainkasuje, a klient uzna, ze zaplacil przy odbiorze.
  it('pobranie BEZ kwoty → 400 i ZERO zmian w bazie', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1622), {});
    const r = await wyslij(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd', pobranie: '1' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/kwot[ęy] pobrania/i);
    expect(db.prepare('SELECT wysylka_reczna_json FROM zamowienia WHERE id = ?').get(id).wysylka_reczna_json).toBeNull();
    expect(pobierzZamowienie(db, id).metoda_wysylki).toBe('dpd');
  });

  it('pobranie z kwota zero i z przecinkiem dziesietnym → 400', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1623), {});
    expect((await wyslij(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd', pobranie: '1', kwota_pobrania: '0.00' })).statusCode).toBe(400);
    expect((await wyslij(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd', pobranie: '1', kwota_pobrania: '12,50' })).statusCode).toBe(400);
    expect(pobierzZamowienie(db, id).metoda_wysylki).toBe('dpd');
  });

  it('przelaczenie z pobrania na zwykla wysylke przestaje uwzgledniac kwote', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1624, { pobranie: 1, kwota_pobrania: '246.00' }), {});
    await wyslij(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd' });
    const z = pobierzZamowienie(db, id);
    expect(z.metoda_wysylki).toBe('dpd');
    expect(z.pobranie).toBe(0);
    expect(z.kwota_pobrania).toBeNull();
    // ...a kwota ze sklepu dalej lezy w swojej kolumnie, nietknieta.
    expect(db.prepare('SELECT kwota_pobrania FROM zamowienia WHERE id = ?').get(id).kwota_pobrania).toBe('246.00');
  });

  it('metoda spoza listy panelu → 400', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1625), {});
    expect((await wyslij(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'inpost' })).statusCode).toBe(400);
  });

  // ⚠️⚠️ TA TRASA MUSI PODAWAC BRAMCE CALE ZAMOWIENIE, a nie same pola formularza. Odmowa
  // dla kanalu Allegro jest kluczowana KANALEM (`zamowienia.sklep`), bo metoda jest dokladnie
  // ta wartoscia, ktora ten formularz zmienia. Wywolanie bramki bez zamowienia (tak bylo do
  // 04.08.2026) znaczy, ze odmowy NIE MA: operator przestawia zamowienie z Allegro na „dpd",
  // a nadanie hurtem — czytajace wartosc EFEKTYWNA — wysyla DRUGA, platna paczke do klienta,
  // ktory dostal juz swoja z Allegro.
  it('zamówienia z kanału Allegro NIE DA SIĘ przestawić na DPD → 400 i zero zmian w bazie', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(1698, { metoda_wysylki: 'allegro_dpd' }), {});
    const r = await wyslij(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/nadajesz w Allegro/);
    expect(db.prepare('SELECT wysylka_reczna_json FROM zamowienia WHERE id = ?').get(id).wysylka_reczna_json).toBeNull();
    expect(pobierzZamowienie(db, id).metoda_wysylki).toBe('allegro_dpd');
  });

  // ...a poprawka W OBREBIE kanalu ma dzialac: `allegro_inne` z nowej uslugi Allegro
  // poprawione na wlasciwa nazwe to jedyna reczna zmiana metody, ktora tu ma sens.
  it('poprawka metody w obrębie kanału Allegro dalej działa', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(1699, { metoda_wysylki: 'allegro_inne' }), {});
    const r = await wyslij(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'allegro_paczkomat' });
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).metoda_wysylki).toBe('allegro_paczkomat');
  });

  it('zmiana idzie do logu jako decyzja czlowieka, z kwota pobrania', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1626), {});
    await wyslij(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd', pobranie: '1', kwota_pobrania: '246.00' });
    const wpis = wpisyLogu(id).find((w) => w.akcja === 'wysylka.metoda');
    expect(wpis.wynik).toContain('DECYZJA CZŁOWIEKA (adam)');
    expect(wpis.wynik).toContain('dpd');
    // Log MUSI nazywac pobranie osobno — sama nazwa dostawy nie mowi juz o inkasie nic.
    expect(wpis.wynik).toContain('za pobraniem');
    expect(wpis.wynik).toContain('246.00');
  });

  it('przywrocenie oddaje metode sklepowi i zdejmuje oznaczenie', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1627), {});
    await wyslij(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd', pobranie: '1', kwota_pobrania: '246.00' });
    const r = await wyslij(`/zamowienia/${id}/wysylka/przywroc`, {});
    expect(r.statusCode).toBe(302);
    const z = pobierzZamowienie(db, id);
    expect(z.metoda_wysylki).toBe('dpd');
    expect(z.kwota_pobrania).toBeNull();
    expect((await karta(id)).body).not.toContain('zmienione ręcznie');
  });

  it('przycisk przywracania pokazuje sie TYLKO gdy jest co przywracac', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1628), {});
    expect((await karta(id)).body).not.toContain('Przywróć metodę ze sklepu');
    await wyslij(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd', pobranie: '1', kwota_pobrania: '1.00' });
    expect((await karta(id)).body).toContain('Przywróć metodę ze sklepu');
  });

  // Zmiana metody nie zawraca paczki, ktora juz jedzie — karta ma to powiedziec wprost.
  it('przy nadanej paczce karta ostrzega, ze zmiana jej nie dotyczy', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1629), {});
    expect((await karta(id)).body).not.toContain('nie zmienia paczki JUŻ NADANEJ');
    nadanaPaczka(id);
    expect((await karta(id)).body).toContain('nie zmienia paczki JUŻ NADANEJ');
  });
});

// ⚠️ Najgrozniejsza sciezka calego zadania: wartosc efektywna MUSI dojsc do kuriera.
// Nadpisanie widoczne wylacznie na karcie znaczyloby, ze panel pokazuje jedno, a do DPD
// wysyla drugie — i to akurat w polu, ktore kurier inkasuje od klienta.
describe('metoda i kwota EFEKTYWNA docieraja do kuriera', () => {
  const zNadaniem = (kurier) => {
    const nadanie = createNadanie({
      db, kurierzy: { dpd: kurier }, woo: { dodajNotatke: vi.fn().mockResolvedValue(undefined) },
      katalogEtykiet: mkdtempSync(join(tmpdir(), 'oms-etykiety-')),
    });
    return nadanie;
  };
  const kurierAtrapa = () => ({
    nadaj: vi.fn().mockResolvedValue({ numerListu: '0000123456789A', etykietaPdf: Buffer.from('pdf'), etykietaZpl: null, surowa: '<x/>' }),
  });

  it('przelaczenie na pobranie przekazuje kwote kurierowi', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1631), {});
    await wyslij(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd', pobranie: '1', kwota_pobrania: '246.00' });
    const kurier = kurierAtrapa();
    await zNadaniem(kurier).nadaj(id, { waga: 1, dlugosc: 10, szerokosc: 10, wysokosc: 1 }, { kolejnosc: 1 });
    const { zamowienie } = kurier.nadaj.mock.calls[0][0];
    expect(zamowienie.metoda_wysylki).toBe('dpd');
    // ⚠️ TO SA PIENIADZE: kurier ma dostac OBIE wartosci — samo „dpd" nie mowi o inkasie nic.
    expect(zamowienie.pobranie).toBe(1);
    expect(zamowienie.kwota_pobrania).toBe('246.00');
  });

  it('przelaczenie z pobrania na zwykla wysylke NIE przekazuje kwoty kurierowi', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1632, { pobranie: 1, kwota_pobrania: '246.00' }), {});
    await wyslij(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd' });
    const kurier = kurierAtrapa();
    await zNadaniem(kurier).nadaj(id, { waga: 1, dlugosc: 10, szerokosc: 10, wysokosc: 1 }, { kolejnosc: 1 });
    const { zamowienie } = kurier.nadaj.mock.calls[0][0];
    expect(zamowienie.metoda_wysylki).toBe('dpd');
    expect(zamowienie.pobranie).toBe(0);
    expect(zamowienie.kwota_pobrania).toBeNull();
  });
});

// ---------------------------------------------------------------------------------
// OCHRONA PRZED POLLEREM — pelny przebieg synchronizacji ze sklepem
// ---------------------------------------------------------------------------------
describe('reczne fakty przezywaja PELNY przebieg pollera', () => {
  // Od Etapu 2 to CALA tablica dostaw sklepu (domain/mapowanie-wysylki.js), nie sama
  // mapa instancji.
  const mapa = { instancje: { 1: { metoda: 'dpd' }, 2: { metoda: 'dpd', pobranie: true } }, poPozycji: [] };
  const surowe = (id, modified) => ({
    id, number: String(id), status: 'processing', total: '212.90',
    date_created: '2026-07-29T10:00:00', date_modified: modified, date_modified_gmt: modified,
    billing: {}, shipping: {}, shipping_lines: [{ method_id: 'flat_rate', instance_id: '1' }],
    line_items: [], meta_data: [],
  });

  it('anulowanie reczne, metoda wysylki, realizacja i zwrot zostaja po synchronizacji', async () => {
    const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [surowe(1641, '2026-07-30T10:00:00')], stron: 1 }) };
    const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'pro' });
    await p.przebieg();
    const id = pobierzZamowienie(db, db.prepare('SELECT id FROM zamowienia').get().id).id;

    await wyslij(`/zamowienia/${id}/status`, { status: 'anulowane' });
    await wyslij(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd', pobranie: '1', kwota_pobrania: '246.00' });

    // Sklep oddaje TO SAMO zamowienie zmienione pozniej — dokladnie to, co poller robi
    // co dwie minuty na produkcji.
    woo.pobierzZamowienia.mockResolvedValue({ zamowienia: [surowe(1641, '2026-07-30T11:00:00')], stron: 1 });
    await p.przebieg();

    const z = pobierzZamowienie(db, id);
    expect(z.anulowane_recznie).toBe(1);
    expect(z.anulowane).toBe(1);
    expect(z.metoda_wysylki).toBe('dpd');
    // ⚠️ Reczne POBRANIE tez ma przezyc przebieg pollera — inaczej synchronizacja co dwie
    // minuty cicho kasowalaby inkaso, a paczka pojechalaby za darmo.
    expect(z.pobranie).toBe(1);
    expect(z.kwota_pobrania).toBe('246.00');
    // ...a to, co nalezy do sklepu, dalej sie odswieza.
    expect(z.metoda_wysylki_sklep).toBe('dpd');
    expect(z.pobranie_sklep).toBe(0);
  });

  // ⚠️ 08.2026 (Zadanie 3): rejestracja zwrotu idzie dzis przez tabele `zwroty`
  // (db/zwroty.js), nie przez POST /status (patrz testy wyzej — droga jest zamknieta).
  // `dodajZwrot` pisze do WLASNEJ tabeli, ktorej `zapiszZamowienie` (uzywane przez poller
  // do kazdego zapisu synchronizacji) w ogole nie dotyka — wiec to jest test na to samo,
  // co oryginal chronil: fakt zwrotu ma przezyc pelny przebieg pollera.
  it('znaczniki realizacji i zwrot (przez tabele zwroty) tez przezywaja przebieg', async () => {
    const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [surowe(1642, '2026-07-30T10:00:00')], stron: 1 }) };
    const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'pro' });
    await p.przebieg();
    const id = db.prepare('SELECT id FROM zamowienia').get().id;
    await wyslij(`/zamowienia/${id}/status`, { status: 'w_realizacji' });
    dodajZwrot(db, id, { data: '2026-07-30', kwota: '50.00', powod: 'uszkodzony', pozycje: [] });

    woo.pobierzZamowienia.mockResolvedValue({ zamowienia: [surowe(1642, '2026-07-30T11:00:00')], stron: 1 });
    await p.przebieg();

    const z = pobierzZamowienie(db, id);
    expect(z.w_realizacji_at).toBeTruthy();
    expect(z.ma_zwrot).toBe(true);
    expect(z.zwroty[0].powod).toBe('uszkodzony');
    expect(wyliczStatus(z)).toBe('zwrot');
  });
});

// ---------------------------------------------------------------------------------
// C. PRZESYLKA NADANA POZA PANELEM
// ---------------------------------------------------------------------------------
describe('POST /zamowienia/:id/przesylki/reczna', () => {
  // Panel jest tu podniesiony Z nadaniem i Z DPD — zeby dalo sie udowodnic, ze mimo to
  // NIC do nich nie leci. Atrapa nadania ma ksztalt uslugi z services/nadanie.js.
  const zAtrapami = async () => {
    const nadanie = { nadaj: vi.fn(), paczkaDomyslna: { waga: 1, dlugosc: 110, szerokosc: 75, wysokosc: 1 } };
    const dpd = { statusPrzesylki: vi.fn().mockResolvedValue({ opis: 'Doręczona', at: '2026-07-30T12:00:00' }) };
    const serwer = buildOmsServer({ db, config, poller, nadanie, kurierzy: { dpd } });
    await serwer.ready();
    return { serwer, nadanie, dpd };
  };

  it('rejestruje przesylke, zamowienie staje sie WYSLANE', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1651), {});
    const r = await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '0000999888777A' });
    expect(r.statusCode).toBe(302);
    const z = pobierzZamowienie(db, id);
    expect(z.przesylki).toHaveLength(1);
    expect(z.przesylki[0]).toMatchObject({ status: 'nadana', numer_listu: '0000999888777A', kolejnosc: 1, nadana_recznie: 1 });
    expect(wyliczStatus(z)).toBe('wyslane');
  });

  // ⚠️ ZERO rozmowy z kurierem: paczka JUZ ZOSTALA nadana poza panelem, wiec wywolanie
  // DPD zalozyloby DRUGA, prawdziwa paczke.
  it('NIE wola DPD ani uslugi nadania', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1652), {});
    const { serwer, nadanie, dpd } = await zAtrapami();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/przesylki/reczna`, headers: naglowek,
      payload: { numer_listu: '0000999888777A' },
    });
    expect(r.statusCode).toBe(302);
    expect(nadanie.nadaj).not.toHaveBeenCalled();
    expect(dpd.statusPrzesylki).not.toHaveBeenCalled();
    // ...a przesylka mimo to istnieje i ma numer listu — czyli fakt zostal zapisany
    // bez ani jednego zadania na zewnatrz.
    expect(pobierzZamowienie(db, id).przesylki[0].numer_listu).toBe('0000999888777A');
    // Zaden plik etykiety nie zostal obiecany: panel go nigdy nie dostal.
    expect(pobierzZamowienie(db, id).przesylki[0].etykieta_sciezka).toBeNull();
    expect(pobierzZamowienie(db, id).przesylki[0].etykieta_zpl_sciezka).toBeNull();
  });

  it('numer listu jest WYMAGANY — bez niego 400 i zero przesylek', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1653), {});
    const r = await wyslij(`/zamowienia/${id}/przesylki/reczna`, { komentarz: 'bez numeru' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/numer listu/i);
    expect(pobierzZamowienie(db, id).przesylki).toHaveLength(0);
    expect((await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '   ' })).statusCode).toBe(400);
  });

  // Karta nie ma prawa obiecywac pliku, ktorego panel nigdy nie dostal.
  it('karta NIE obiecuje „Pobierz" ani „Drukuj" dla przesylki spoza panelu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1654), {});
    await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '0000999888777A' });
    const body = (await karta(id)).body;
    expect(body).toContain('nadana poza panelem');
    expect(body).not.toContain('>Pobierz<');
    expect(body).not.toContain('>Drukuj<');
    expect(body).not.toContain('etykieta niezapisana');
  });

  // Brak etykiety przy takiej przesylce nie jest sprawa do zalatwienia — jest z definicji.
  it('przesylka spoza panelu NIE trzyma zamowienia na liscie roboczej', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1655), {});
    await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '0000999888777A' });
    const lista = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    expect(lista.body).not.toContain('1655');
    expect((await karta(id)).body).not.toContain('Załatwione ręcznie poza panelem');
  });

  // Numer listu jest prawdziwy, wiec sledzenie ma dzialac jak przy kazdej innej paczce.
  it('sledzenie u kuriera dziala normalnie — link i odpytanie DPD', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1656), {});
    await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '0000999888777A' });
    const { serwer, dpd } = await zAtrapami();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(dpd.statusPrzesylki).toHaveBeenCalledWith('0000999888777A', expect.any(Object));
    expect(r.body).toContain('tracktrace.dpd.com.pl');
    expect(r.body).toContain('Doręczona');
  });

  // ⚠️ LANDMINA DRUGIMI DRZWIAMI (recenzja 2026-08-04). Galaz „paczkomaty" naprawila petle
  // odswiezania tak, ze usluge wybiera `p.kurier` — ale ta trasa wpisywala `kurier: 'dpd'`
  // NA SZTYWNO, wiec wiersz byl blednie oznaczony U ZRODLA i poprawny wybor po `p.kurier`
  // niczego nie ratowal. Wlasciciel nadaje paczkomat w Managerze Paczek InPostu i wpisuje
  // numer tutaj — a panel linkowal go na tracktrace.dpd.com.pl (strona nic nie znajduje)
  // i pytal DPD o numer InPostu. Gorzej: gdyby usluga zdarzen DPD oddala dla obcego numeru
  // pusta liste, karta napisalaby „brak zdarzen" BEZ ZADNEGO ZNAKU AWARII.
  describe('kurier wiersza pochodzi z METODY WYSYLKI, a nie z „na sztywno dpd"', () => {
    const zDwomaKurierami = async () => {
      const dpd = { statusPrzesylki: vi.fn().mockResolvedValue({ opis: 'Doręczona', at: '2026-07-30T12:00:00' }) };
      const inpost = { statusPrzesylki: vi.fn().mockResolvedValue({ opis: 'Gotowa do odbioru w paczkomacie', at: '2026-07-30T12:00:00' }) };
      const serwer = buildOmsServer({ db, config, poller, kurierzy: { dpd, inpost } });
      await serwer.ready();
      return { serwer, dpd, inpost };
    };
    const NUMER_INPOST = '520000123456789012345678';

    it('zamówienie paczkomatowe zapisuje kuriera „inpost"', async () => {
      const id = zapiszZamowienie(db, 'pro', zmapowane(1671, { metoda_wysylki: 'inpost_paczkomat' }), {});
      const r = await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: NUMER_INPOST });
      expect(r.statusCode).toBe(302);
      expect(pobierzZamowienie(db, id).przesylki[0].kurier).toBe('inpost');
    });

    // Skutek widoczny dla czlowieka: link musi prowadzic do InPostu, a o status ma byc
    // zapytany InPost — nie DPD numerem, ktorego DPD nigdy nie widzialo.
    it('karta linkuje do InPostu i pyta o status InPost, nie DPD', async () => {
      const id = zapiszZamowienie(db, 'pro', zmapowane(1672, { metoda_wysylki: 'inpost_paczkomat' }), {});
      await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: NUMER_INPOST });
      const { serwer, dpd, inpost } = await zDwomaKurierami();
      const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
      expect(inpost.statusPrzesylki).toHaveBeenCalledWith(NUMER_INPOST, expect.any(Object));
      expect(dpd.statusPrzesylki).not.toHaveBeenCalled();
      expect(r.body).toContain('inpost.pl/sledzenie-przesylek');
      expect(r.body).not.toContain('tracktrace.dpd.com.pl');
    });

    it('zamówienie DPD dalej dostaje „dpd" — dzisiejsze zachowanie nie drgnęło', async () => {
      const id = zapiszZamowienie(db, 'pro', zmapowane(1673, { metoda_wysylki: 'dpd' }), {});
      await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '0000999888777A' });
      expect(pobierzZamowienie(db, id).przesylki[0].kurier).toBe('dpd');
    });

    // Metoda „nieznana" jest tu przypadkiem NAJCZESTSZYM (wlasnie takie zamowienia nadaje
    // sie poza panelem), wiec zapasowe 'dpd' musi zostac — inaczej poprawka zabralaby
    // dzialajacy dzis link do sledzenia.
    it('metoda nieznana dalej dostaje „dpd" jako zachowanie zapasowe', async () => {
      const id = zapiszZamowienie(db, 'pro', zmapowane(1674, { metoda_wysylki: 'nieznana' }), {});
      await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '0000999888777A' });
      expect(pobierzZamowienie(db, id).przesylki[0].kurier).toBe('dpd');
    });
  });

  it('komentarz i sam fakt ida do logu jako decyzja czlowieka', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1657), {});
    await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '0000999888777A', komentarz: 'nadane w panelu DPD' });
    const wpis = wpisyLogu(id).find((w) => w.akcja === 'przesylka.reczna');
    expect(wpis.wynik).toContain('DECYZJA CZŁOWIEKA (adam)');
    expect(wpis.wynik).toContain('0000999888777A');
    expect(wpis.wynik).toContain('nadane w panelu DPD');
  });

  // Ten sam indeks unikalny, co przy nadaniu z panelu — rejestracja reczna nie ma prawa
  // byc obejsciem siatki chroniacej przed druga paczka pod tym samym numerem.
  it('kolejna rejestracja dostaje NASTEPNY numer kolejny', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1658), {});
    await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '0000111111111A' });
    await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '0000222222222A' });
    const p = pobierzZamowienie(db, id).przesylki;
    expect(p.map((x) => x.kolejnosc)).toEqual([1, 2]);
  });

  it('nie rejestruje, gdy inna paczka wisi w toku', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1659), {});
    db.prepare(
      "INSERT INTO przesylki (zamowienie_id, kurier, status, kolejnosc, utworzona_at) VALUES (?, 'dpd', 'w_trakcie', 1, ?)",
    ).run(id, new Date().toISOString());
    const r = await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '0000999888777A' });
    expect(r.statusCode).toBe(400);
    expect(pobierzZamowienie(db, id).przesylki).toHaveLength(1);
  });

  it('formularz jest na karcie takze przy nieznanej metodzie wysylki', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1660, { metoda_wysylki: 'nieznana' }), {});
    const body = (await karta(id)).body;
    expect(body).toContain('Zarejestruj przesyłkę nadaną poza panelem');
    // ...a lista metod nie udaje przy tym, ze zamowienie ma metode panelu.
    expect(body).toContain('nieznana — wybierz metodę panelu');
    expect(body).not.toContain('<option value="dpd" selected>');
  });
});

// ---------------------------------------------------------------------------------
// D. WYJŚCIE Z PRZESYŁKI ZAREJESTROWANEJ RĘCZNIE — literówka w numerze listu jest inaczej
// TRWAŁA: unikalny indeks (zamowienie_id, kolejnosc) odbija każdą kolejną próbę rejestracji
// poprawnego numeru. Panel nie może wchodzić w stan, z którego nie umie wyjść (PRZEWODNIK.md
// 4.9) — to jest to wyjście.
// ---------------------------------------------------------------------------------
// Dwa „puste" zamówienia PRZED tym pod testem rozjeżdżają liczniki AUTOINCREMENT tabel
// `zamowienia` i `przesylki` — w świeżej bazie :memory: oba startują od 1 w tym samym
// rytmie, więc zamowienie_id i przesylka_id pierwszej pary byłyby przypadkiem RÓWNE.
// Bez tego rozjazdu pomyłka argumentów w trasie (przekazanie ID zamówienia zamiast ID
// przesyłki) przeszłaby przez test niezauważona.
const zLuznymiId = (db, numer) => {
  zapiszZamowienie(db, 'pro', zmapowane(numer - 2), {});
  zapiszZamowienie(db, 'pro', zmapowane(numer - 1), {});
  return zapiszZamowienie(db, 'pro', zmapowane(numer), {});
};

describe('POST /zamowienia/:id/przesylki/:przesylkaId/skasuj-reczna', () => {
  it('kasuje przesylke zarejestrowana recznie i zwalnia miejsce pod ponowna rejestracje', async () => {
    const id = zLuznymiId(db, 1670);
    await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '0000LITEROWKA' });
    const p = pobierzZamowienie(db, id).przesylki[0];
    const r = await wyslij(`/zamowienia/${id}/przesylki/${p.id}/skasuj-reczna`, {});
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).przesylki).toHaveLength(0);
    const r2 = await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '0000POPRAWNY' });
    expect(r2.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).przesylki).toHaveLength(1);
    expect(pobierzZamowienie(db, id).przesylki[0].numer_listu).toBe('0000POPRAWNY');
  });

  // ⚠️ GRANICA: paczka nadana Z PANELU ma prawdziwy numer listu przydzielony przez DPD —
  // skasowanie wiersza otworzyloby droge do drugiego nadania pod ta sama referencja.
  it('NIGDY nie kasuje przesylki nadanej z panelu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1671), {});
    nadanaPaczka(id);
    const p = pobierzZamowienie(db, id).przesylki[0];
    const r = await wyslij(`/zamowienia/${id}/przesylki/${p.id}/skasuj-reczna`, {});
    expect(r.statusCode).toBe(400);
    expect(pobierzZamowienie(db, id).przesylki).toHaveLength(1);
    const wpis = wpisyLogu(id).find((w) => w.akcja === 'przesylka.skasowanie-reczna');
    expect(wpis.wynik).toContain('BŁĄD');
  });

  it('log zapisuje decyzje czlowieka Z NUMEREM LISTU skasowanego wiersza', async () => {
    const id = zLuznymiId(db, 1672);
    await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '0000999888777A' });
    const p = pobierzZamowienie(db, id).przesylki[0];
    await wyslij(`/zamowienia/${id}/przesylki/${p.id}/skasuj-reczna`, {});
    const wpis = wpisyLogu(id).find((w) => w.akcja === 'przesylka.skasowanie-reczna');
    expect(wpis.wynik).toContain('DECYZJA CZŁOWIEKA (adam)');
    expect(wpis.wynik).toContain('0000999888777A');
  });

  it('przycisk widoczny WYLACZNIE przy przesylce zarejestrowanej recznie, nigdy przy nadanej z panelu', async () => {
    const idReczna = zapiszZamowienie(db, 'pro', zmapowane(1673), {});
    await wyslij(`/zamowienia/${idReczna}/przesylki/reczna`, { numer_listu: '0000999888777A' });
    const idPanel = zapiszZamowienie(db, 'pro', zmapowane(1674), {});
    nadanaPaczka(idPanel);
    const bodyReczna = (await karta(idReczna)).body;
    const bodyPanel = (await karta(idPanel)).body;
    expect(bodyReczna).toContain('skasuj-reczna');
    expect(bodyPanel).not.toContain('skasuj-reczna');
  });
});

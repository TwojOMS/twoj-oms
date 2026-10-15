import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zapiszZamowienie, pobierzZamowienie, dodajPozycjeReczna, zapiszNadpisaniaPozycji,
} from '../../../src/oms/db/zamowienia.js';
import { parsujNowaPozycje } from '../../../src/domena/pozycje-reczne.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// ⚠️ `sklepy` NIE JEST TU OZDOBA. Odnosnik do produktu powstaje wylacznie wtedy, gdy trasa
// zna `baseUrl` kanalu — bez tego KAZDY test „nie ma odnosnika" przechodzilby za darmo,
// takze na kodzie, ktory odnosniki rozdaje bledom. Zlapane 21.08.2026 przez test graniczny.
const config = {
  auth: { user: 'adam', pass: 'x' },
  sklepy: {
    pro: { baseUrl: 'https://pro.szkicownia.pl' },
    szkicownia: { baseUrl: 'https://szkicownia.pl' },
  },
};
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-07-29T12:00:00', ostatni_blad: null }) };

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1301, numer: '1301', klient: { first_name: 'Jan', email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '212.90',
  koszt_dostawy_brutto: '89.90', koszt_dostawy_netto: '73.09', status_woo: 'processing',
  oplacone_at: null, anulowane: 0, utworzone_at: '2026-07-29T13:19:52',
  pozycje: [{
    zrodlo_id: 4321, nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '61.50',
    cena_netto: '50.00', brutto_linii: '123.00', netto_linii: '100.00', vat: null,
  }],
  ...nad,
});

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
  await app.ready();
});

// Liczniki AUTOINCREMENT roznych tabel zbiegaja sie w swiezej bazie (przewodnik OMS, 6.3),
// wiec bez wypelniaczy `id` zamowienia rownaloby sie `id` pozycji i pomylka argumentu
// w trasie przeszlaby niezauwazona.
function zamowienieZRozjechanymiLicznikami(nad = {}) {
  for (let i = 0; i < 4; i += 1) zapiszZamowienie(db, 'pro', zmapowane({ zrodlo_id: 9000 + i, numer: `900${i}` }), {});
  return zapiszZamowienie(db, 'pro', zmapowane(nad), {});
}

const log = (id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);
const karta = (id, query = '') => app.inject({ method: 'GET', url: `/zamowienia/${id}${query}`, headers: naglowek });
const wyslij = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });

const kluczReczna = (id) => pobierzZamowienie(db, id).pozycje.find((p) => p.reczna).klucz;

describe('tabela pozycji na karcie', () => {
  it('wiersz „Razem" jest OSTATNIM wierszem tabeli, nie akapitem pod nią', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await karta(id);
    const tabela = r.body.slice(r.body.indexOf('id="pozycje"'));
    const koniecTabeli = tabela.indexOf('</table>');
    // ⚠️ Szukamy CAŁEGO atrybutu, nie samego słowa: EJS escapuje cudzysłowy w `<%= %>`,
    // więc `class=&#34;wiersz-razem&#34;` przeszłoby przez test na samą nazwę klasy,
    // a wyróżnienie wiersza w przeglądarce po prostu by nie zadziałało. Tak się już stało.
    const znacznik = '<tr class="wiersz-razem">';
    const wiersz = tabela.indexOf(znacznik);
    expect(wiersz).toBeGreaterThan(-1);
    // Wiersz sumy jest WEWNĄTRZ tabeli...
    expect(wiersz).toBeLessThan(koniecTabeli);
    // ...i po nim nie ma już ANI JEDNEGO kolejnego <tr> aż do zamknięcia tabeli.
    const zaWierszem = tabela.slice(wiersz + znacznik.length, koniecTabeli);
    expect(zaWierszem).not.toContain('<tr');
    expect(zaWierszem).toContain('212.90');
  });

  // Przebudowa 2026-07-31: kolumna „Lp." znikla z tabeli (numer porzadkowy nie niesie przy
  // pakowaniu nic, czego nie widac z kolejnosci wierszy), wiec zostaje sedno testu: wysylka
  // jest PELNOPRAWNYM wierszem z wlasna iloscia 1, a nie wierszem myslnikow.
  it('wiersz wysyłki ma ilość 1, a nie myślniki', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await karta(id);
    // Szukamy w TABELI POZYCJI, nie w calej stronie: belka faktow na gorze karty tez ma
    // slowo „Wysyłka" jako etykiete pola, wiec indexOf po calym HTML-u trafialby w nia.
    const tabela = r.body.slice(r.body.indexOf('id="pozycje"'));
    const wysylka = tabela.slice(tabela.lastIndexOf('<tr', tabela.indexOf('Wysyłka')));
    const wiersz = wysylka.slice(0, wysylka.indexOf('</tr>'));
    expect(wiersz).toMatch(/1×/);
    expect(wiersz).not.toContain('—');
  });

  it('ostrzeżenie o rozjeździe zostaje i jest czytelne pod tabelą', async () => {
    const id = zamowienieZRozjechanymiLicznikami({ kwota_brutto: '999.99' });
    const r = await karta(id);
    expect(r.body).toContain('NIE ZGADZA SIĘ');
    expect(r.body).toContain('999.99');
  });

  it('bez rozjazdu nie ma ostrzeżenia', async () => {
    const r = await karta(zamowienieZRozjechanymiLicznikami());
    expect(r.body).not.toContain('NIE ZGADZA SIĘ');
  });
});

describe('dopisywanie pozycji', () => {
  it('formularz „Dodaj pozycję" jest w trybie edycji pozycji, z wymaganą nazwą, ilością i ceną', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await karta(id, '?edytuj=pozycje');
    expect(r.body).toContain(`action="/zamowienia/${id}/pozycje"`);
    expect(r.body).toContain('Dodaj pozycję');
    expect(r.body).toContain('name="nazwa" required');
    expect(r.body).toContain('name="ilosc" value="1" required');
    expect(r.body).toContain('name="cena_brutto" required');
  });

  it('dopisana pozycja pojawia się w tabeli, oznaczona jako ręczna, i wchodzi do sumy', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'Dodatkowy szablon', ilosc: '1', cena_brutto: '80,00' });
    expect(r.statusCode).toBe(302);

    const karta1 = await karta(id);
    expect(karta1.body).toContain('Dodatkowy szablon');
    expect(karta1.body).toContain('dopisana ręcznie');
    // Suma: 123,00 + 80,00 + 89,90 = 292,90 — i tyle samo wynosi kwota oczekiwana,
    // więc ostrzeżenia o rozjeździe NIE MA.
    expect(karta1.body).toContain('292.90');
    expect(karta1.body).not.toContain('NIE ZGADZA SIĘ');
  });

  it('dopisanie pozycji trafia do logu jako decyzja człowieka, z kwotą', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'Dodatkowy szablon', ilosc: '2', cena_brutto: '40.00' });
    const wpis = log(id).at(-1);
    expect(wpis.akcja).toBe('pozycja.dodana');
    expect(wpis.wynik).toMatch(/DECYZJA CZŁOWIEKA \(adam\)/);
    expect(wpis.wynik).toContain('Dodatkowy szablon');
    expect(wpis.wynik).toContain('80.00');
  });

  it('przecinek dziesiętny w cenie jest przyjmowany', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'X', ilosc: '1', cena_brutto: '80,50' });
    expect(pobierzZamowienie(db, id).pozycje.at(-1).cena_brutto).toBe('80.50');
  });

  it('pusta nazwa → 400 z wyjaśnieniem, nic nie zapisane', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: '', ilosc: '1', cena_brutto: '80.00' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/nazwę/i);
    expect(pobierzZamowienie(db, id).pozycje).toHaveLength(1);
  });

  it('ilość zero → 400, nic nie zapisane', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'X', ilosc: '0', cena_brutto: '80.00' });
    expect(r.statusCode).toBe(400);
    expect(pobierzZamowienie(db, id).pozycje).toHaveLength(1);
  });

  it('cena zero → 400, nic nie zapisane', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'X', ilosc: '1', cena_brutto: '0' });
    expect(r.statusCode).toBe(400);
    expect(pobierzZamowienie(db, id).pozycje).toHaveLength(1);
  });

  it('nieistniejące zamówienie → 404', async () => {
    const r = await wyslij('/zamowienia/99999/pozycje', { nazwa: 'X', ilosc: '1', cena_brutto: '1.00' });
    expect(r.statusCode).toBe(404);
  });
});

// ⚠️ SEDNO ZADANIA W WARSTWIE HTTP: kwota ze sklepu nie rosnie, wiec doplata JEST WIDOCZNA
// jako niedoplata — panel nie przestaje pokazywac, ze klient jest nam winien pieniadze.
describe('dopisana pozycja a saldo wpłat', () => {
  it('zamówienie opłacone w sklepie + dopisana pozycja = widoczna NIEDOPŁATA', async () => {
    const id = zamowienieZRozjechanymiLicznikami({ oplacone_at: '2026-07-29T14:00:00' });
    expect((await karta(id)).body).not.toContain('NIEDOPŁATA');

    await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' });

    const r = await karta(id);
    expect(r.body).toContain('NIEDOPŁATA');
    expect(r.body).toContain('brakuje 80.00 zł');
  });

  it('kwota zamówienia w sklepie zostaje nietknięta w bazie', async () => {
    const id = zamowienieZRozjechanymiLicznikami({ oplacone_at: '2026-07-29T14:00:00' });
    await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' });
    expect(db.prepare('SELECT kwota_brutto FROM zamowienia WHERE id = ?').get(id).kwota_brutto).toBe('212.90');
    expect(db.prepare("SELECT kwota FROM platnosci WHERE zamowienie_id = ? AND zrodlo = 'sklep'").get(id).kwota)
      .toBe('212.90');
  });
});

// Lista jest ekranem, na ktory operator patrzy pierwszy — kwota sklepowa przy zamowieniu
// z doplata znaczylaby, ze panel zanizza tu dlug klienta w miejscu najlatwiejszym do przeoczenia.
describe('kwota na liście zamówień', () => {
  const lista = () => app.inject({ method: 'GET', url: '/?wszystkie=1', headers: naglowek });

  it('bez dopisków pokazuje kwotę ze sklepu, bez dopowiedzeń', async () => {
    zamowienieZRozjechanymiLicznikami();
    const r = await lista();
    expect(r.body).toContain('212.90 zł');
    expect(r.body).not.toContain('w sklepie:');
  });

  it('z dopisaną pozycją pokazuje kwotę OCZEKIWANĄ i mówi wprost, ile jest w sklepie', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' });
    const r = await lista();
    expect(r.body).toContain('292.90 zł');
    expect(r.body).toContain('w sklepie: 212.90 zł');
  });

  it('uszkodzona kwota nie wywala listy — spada do wartości ze sklepu', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    db.prepare('UPDATE zamowienia SET kwota_brutto = ? WHERE id = ?').run('', id);
    const r = await lista();
    expect(r.statusCode).toBe(200);
  });
});

describe('edycja pozycji', () => {
  // Przebudowa 2026-07-31: JEDEN odnośnik „Edytuj" otwiera CAŁY panel, a nie osobny
  // formularz przy każdym wierszu. W trybie edycji każda pozycja — sklepowa i ręczna —
  // ma własne pola, i to jest tu sedno.
  it('jedno „Edytuj" otwiera pola przy KAŻDEJ pozycji — sklepowej i ręcznej', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));
    expect((await karta(id)).body).toContain('?edytuj=pozycje');
    const r = await karta(id, '?edytuj=pozycje');
    expect(r.body).toContain('value="s4321"');
    expect(r.body).toContain(`value="${kluczReczna(id)}"`);
  });

  // ⚠️ ZAPIS HURTEM NIE MA PRAWA SKASOWAC NADPISANIA POZYCJI, KTOREJ NIE BYLO W FORMULARZU.
  // Realny przypadek: sklep usunal pozycje z zamowienia, a jej poprawka dalej lezy w bazie
  // (ustawNadpisaniePozycji CELOWO nie kasuje kluczy osieroconych — nadpisanie samo niczego
  // nie robi, dopoki nie ma do czego przylgnac, a pozycja moze wrocic przy nastepnej
  // synchronizacji). Gdyby zapis budowal mape OD ZERA, jedno klikniecie „Zapisz pozycje"
  // kasowaloby po cichu uzgodnione z klientem ceny innych wierszy.
  it('zapis hurtem zachowuje nadpisanie pozycji spoza formularza', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    // Poprawka pozycji, ktorej w zamowieniu (i w formularzu) juz nie ma.
    db.prepare('UPDATE zamowienia SET pozycje_reczne_json = ? WHERE id = ?')
      .run(JSON.stringify({ s9999: { ilosc: 7 } }), id);

    const r = await wyslij(`/zamowienia/${id}/pozycje/zapisz`, { klucz: 's4321', nazwa: 'STOP', ilosc: '3', cena_brutto: '61.50' });
    expect(r.statusCode).toBe(302);

    const mapa = JSON.parse(db.prepare('SELECT pozycje_reczne_json FROM zamowienia WHERE id = ?').get(id).pozycje_reczne_json);
    expect(mapa).toEqual({ s9999: { ilosc: 7 }, s4321: { ilosc: 3 } });
  });

  it('pola edycji pokazują się WYŁĄCZNIE po kliknięciu „Edytuj"', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    // Karta jest domyślnie TYLKO DO ODCZYTU — ani jednego pola formularza pozycji.
    expect((await karta(id)).body).not.toContain('Zapisz pozycje');
    const r = await karta(id, '?edytuj=pozycje');
    expect(r.body).toContain('Zapisz pozycje');
    expect(r.body).toContain(`action="/zamowienia/${id}/pozycje/zapisz"`);
  });

  it('edycja pozycji SKLEPOWEJ zapisuje nadpisanie, nie rusza wiersza ze sklepu', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await wyslij(`/zamowienia/${id}/pozycje/zapisz`, { klucz: 's4321', nazwa: 'STOP', ilosc: '3', cena_brutto: '61.50' });
    expect(r.statusCode).toBe(302);

    // Wiersz w bazie DALEJ ma wartości ze sklepu...
    expect(db.prepare("SELECT ilosc FROM pozycje WHERE zamowienie_id = ? AND zrodlo = 'sklep'").get(id).ilosc).toBe(2);
    // ...a nadpisanie leży obok, POLOWO: wyłącznie ilość.
    expect(JSON.parse(db.prepare('SELECT pozycje_reczne_json FROM zamowienia WHERE id = ?').get(id).pozycje_reczne_json))
      .toEqual({ s4321: { ilosc: 3 } });
    // Karta pokazuje wartość efektywną i oznaczenie.
    expect((await karta(id)).body).toContain('zmienione ręcznie: ilosc');
  });

  // Wartość efektywna musi być tym, co widzi WSZYSTKO — także suma pod tabelą i ostrzeżenie
  // o rozjeździe. Suma licząca dalej wartości ze sklepu rozjechałaby się z kwotą oczekiwaną
  // i panel krzyczałby o rozjeździe przy każdej poprawionej pozycji.
  it('suma w tabeli idzie za wartością POPRAWIONĄ, bez fałszywego ostrzeżenia o rozjeździe', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    await wyslij(`/zamowienia/${id}/pozycje/zapisz`, { klucz: 's4321', nazwa: 'STOP', ilosc: '3', cena_brutto: '61.50' });

    const r = await karta(id);
    // 3 × 61,50 = 184,50 w linii; razem z wysyłką 89,90 → 274,40.
    expect(r.body).toContain('184.50');
    expect(r.body).toContain('274.40');
    expect(r.body).not.toContain('NIE ZGADZA SIĘ');
  });

  // ⚠️ NADPISANIE JEST POLOWE — i to jest jedyny powód, dla którego edycja pozycji sklepowej
  // w ogóle ma prawo istnieć. Gdyby zapisywała cały wiersz, poprawka ceny w sklepie nigdy
  // by już nie doszła, a panel pokazywałby dane tym starsze, im dawniej ktoś kliknął „zapisz".
  it('po zmianie SAMEJ ilości przez formularz zmiana ceny w sklepie DALEJ dochodzi', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    await wyslij(`/zamowienia/${id}/pozycje/zapisz`, { klucz: 's4321', nazwa: 'STOP', ilosc: '3', cena_brutto: '61.50' });

    // Sklep podnosi cenę: 2 szt. po 70,00 zł brutto. To robi zwykła synchronizacja.
    zapiszZamowienie(db, 'pro', zmapowane({
      kwota_brutto: '229.90',
      pozycje: [{
        zrodlo_id: 4321, nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '70.00',
        cena_netto: '56.91', brutto_linii: '140.00', netto_linii: '113.82', vat: null,
      }],
    }), {});

    const p = pobierzZamowienie(db, id).pozycje[0];
    expect(p.cena_brutto).toBe('70.00');
    expect(p.ilosc).toBe(3);
    expect(p.brutto_linii).toBe('210.00');
  });

  it('edycja pozycji RĘCZNEJ zmienia wiersz wprost', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));
    const klucz = kluczReczna(id);

    await wyslij(`/zamowienia/${id}/pozycje/zapisz`, { klucz: `${klucz}`, nazwa: 'Dopłata x2', ilosc: '2', cena_brutto: '80,00' });

    const p = pobierzZamowienie(db, id).pozycje.find((w) => w.reczna);
    expect(p).toMatchObject({ nazwa: 'Dopłata x2', ilosc: 2, brutto_linii: '160.00' });
    expect(db.prepare('SELECT pozycje_reczne_json FROM zamowienia WHERE id = ?').get(id).pozycje_reczne_json).toBeNull();
  });

  it('edycja pozycji ręcznej NIE gubi SKU', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', sku: 'X-1', ilosc: '1', cena_brutto: '80.00' }));
    const klucz = kluczReczna(id);
    await wyslij(`/zamowienia/${id}/pozycje/zapisz`, { klucz: `${klucz}`, nazwa: 'Dopłata', ilosc: '2', cena_brutto: '80.00' });
    expect(pobierzZamowienie(db, id).pozycje.find((w) => w.reczna).sku).toBe('X-1');
  });

  it('edycja idzie do logu jako decyzja człowieka', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    await wyslij(`/zamowienia/${id}/pozycje/zapisz`, { klucz: 's4321', nazwa: 'STOP', ilosc: '3', cena_brutto: '61.50' });
    const wpis = log(id).at(-1);
    expect(wpis.akcja).toBe('pozycje.zapisz');
    expect(wpis.wynik).toMatch(/DECYZJA CZŁOWIEKA \(adam\)/);
    expect(wpis.wynik).toContain('STOP'); // log hurtu wymienia POZYCJE, nie nazwy pol
  });

  it('błędna wartość → 400 z wyjaśnieniem, nadpisanie nie powstaje', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await wyslij(`/zamowienia/${id}/pozycje/zapisz`, { klucz: 's4321', nazwa: 'STOP', ilosc: '1,5', cena_brutto: '61.50' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/całkowit/i);
    expect(db.prepare('SELECT pozycje_reczne_json FROM zamowienia WHERE id = ?').get(id).pozycje_reczne_json).toBeNull();
  });

  // ZMIANA ŚWIADOMA: przy zapisie hurtem obcy klucz jest POMIJANY, a nie odrzucany całym
  // żądaniem — poller przenumerowuje pozycje co dwie minuty, więc formularz otwarty przed
  // synchronizacją potrafi celować w wiersz, którego już nie ma. Reszta wierszy ma się
  // zapisać; odmowa całości kasowałaby pracę operatora z powodu, na który nie ma wpływu.
  it('nieznany klucz pozycji jest POMIJANY, nic nie zapisane', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await wyslij(`/zamowienia/${id}/pozycje/zapisz`, { klucz: 's9999', nazwa: 'X', ilosc: '1', cena_brutto: '1.00' });
    expect(r.statusCode).toBe(302);
    expect(db.prepare('SELECT pozycje_reczne_json FROM zamowienia WHERE id = ?').get(id).pozycje_reczne_json).toBeNull();
  });
});

describe('„Przywróć ze sklepu" przy pozycji', () => {
  it('przycisk pokazuje się WYŁĄCZNIE przy pozycji z nadpisaniem', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    expect((await karta(id, '?edytuj=pozycje')).body).not.toContain('Przywróć ze sklepu');
    zapiszNadpisaniaPozycji(db, id, { s4321: { ilosc: 3 } });
    expect((await karta(id, '?edytuj=pozycje')).body).toContain('Przywróć ze sklepu');
  });

  it('kasuje nadpisanie tej pozycji i wraca do wartości ze sklepu', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    zapiszNadpisaniaPozycji(db, id, { s4321: { ilosc: 3, cena_brutto: '70.00' } });

    const r = await wyslij(`/zamowienia/${id}/pozycje/s4321/przywroc`, {});
    expect(r.statusCode).toBe(302);

    const p = pobierzZamowienie(db, id).pozycje[0];
    expect(p).toMatchObject({ ilosc: 2, cena_brutto: '61.50', brutto_linii: '123.00' });
    expect(p.polaZmienione).toEqual([]);
    expect(db.prepare('SELECT pozycje_reczne_json FROM zamowienia WHERE id = ?').get(id).pozycje_reczne_json).toBeNull();
  });

  it('przywrócenie idzie do logu jako decyzja człowieka', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    zapiszNadpisaniaPozycji(db, id, { s4321: { ilosc: 3 } });
    await wyslij(`/zamowienia/${id}/pozycje/s4321/przywroc`, {});
    const wpis = log(id).at(-1);
    expect(wpis.akcja).toBe('pozycja.przywroc');
    expect(wpis.wynik).toMatch(/DECYZJA CZŁOWIEKA \(adam\)/);
  });

  it('przy pozycji ręcznej nie ma czego przywracać → 400 z wyjaśnieniem', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));
    const r = await wyslij(`/zamowienia/${id}/pozycje/${kluczReczna(id)}/przywroc`, {});
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/sklep o niej nie wie/i);
  });
});

describe('usunięcie pozycji ręcznej', () => {
  it('przycisk „Usuń" jest WYŁĄCZNIE przy pozycji dopisanej ręcznie', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    expect((await karta(id, '?edytuj=pozycje')).body).not.toContain('/usun');
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));
    expect((await karta(id, '?edytuj=pozycje')).body).toContain(`/pozycje/${kluczReczna(id)}/usun`);
  });

  it('usuwa pozycję i cofa niedopłatę, którą wprowadziła', async () => {
    const id = zamowienieZRozjechanymiLicznikami({ oplacone_at: '2026-07-29T14:00:00' });
    await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'Pomyłka', ilosc: '1', cena_brutto: '80.00' });
    const klucz = kluczReczna(id);
    expect((await karta(id)).body).toContain('NIEDOPŁATA');

    const r = await wyslij(`/zamowienia/${id}/pozycje/${klucz}/usun`, {});
    expect(r.statusCode).toBe(302);

    expect(pobierzZamowienie(db, id).pozycje).toHaveLength(1);
    expect((await karta(id)).body).not.toContain('NIEDOPŁATA');
  });

  it('usunięcie trafia do logu jako decyzja człowieka, z nazwą i kwotą', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'Pomyłka', ilosc: '1', cena_brutto: '80.00' });
    const klucz = kluczReczna(id);
    await wyslij(`/zamowienia/${id}/pozycje/${klucz}/usun`, {});
    const wpis = log(id).at(-1);
    expect(wpis.akcja).toBe('pozycja.usunieta');
    expect(wpis.wynik).toMatch(/DECYZJA CZŁOWIEKA \(adam\)/);
    expect(wpis.wynik).toContain('Pomyłka');
    expect(wpis.wynik).toContain('80.00');
  });

  it('pozycji ze sklepu usunąć się nie da — 400 z wyjaśnieniem', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await wyslij(`/zamowienia/${id}/pozycje/s4321/usun`, {});
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/nie da się usunąć/i);
    expect(pobierzZamowienie(db, id).pozycje).toHaveLength(1);
  });
});

// Ochrona przed CSRF obowiazuje tak samo, jak wszedzie indziej w panelu (przewodnik 4.11).
describe('ochrona przed CSRF', () => {
  it('POST bez nagłówka Origin jest odrzucany', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/pozycje`,
      headers: { authorization: naglowek.authorization },
      payload: { nazwa: 'X', ilosc: '1', cena_brutto: '1.00' },
    });
    expect(r.statusCode).toBe(403);
    expect(pobierzZamowienie(db, id).pozycje).toHaveLength(1);
  });
});

// ⚠️ TA SAMA USTERKA, CO PRZY DARMOWEJ DOSTAWIE (20.08.2026) — druga jej twarz. Formularz
// „Zapisz pozycje" odsyla WSZYSTKIE wiersze, wiec pozycja wyceniona przez sklep na 0 zl
// (probka, gratis z promocji) niosla `0.00` i bezwarunkowa odmowa parsera wywracala zapis
// CALEGO zamowienia — razem z pozycjami, ktore operator faktycznie poprawil.
describe('pozycja ze sklepu za 0 zł nie blokuje zapisu', () => {
  const zGratisem = () => zamowienieZRozjechanymiLicznikami({
    pozycje: [
      {
        zrodlo_id: 4321, nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '61.50',
        cena_netto: '50.00', brutto_linii: '123.00', netto_linii: '100.00', vat: null,
      },
      {
        zrodlo_id: 4322, nazwa: 'Próbka gratis', sku: 'PRO-GRATIS', ilosc: 1, cena_brutto: '0.00',
        cena_netto: '0.00', brutto_linii: '0.00', netto_linii: '0.00', vat: null,
      },
    ],
  });

  it('poprawka płatnej pozycji przechodzi, choć obok jedzie wiersz za 0 zł', async () => {
    const id = zGratisem();
    const r = await wyslij(`/zamowienia/${id}/pozycje/zapisz`, {
      klucz: ['s4321', 's4322'],
      nazwa: ['STOP', 'Próbka gratis'],
      ilosc: ['3', '1'],
      cena_brutto: ['61.50', '0.00'],
    });
    expect(r.statusCode).toBe(302);

    // Gratis zostaje bez nadpisania — zero rowne sklepowi to brak zmiany, nie decyzja.
    const mapa = JSON.parse(db.prepare('SELECT pozycje_reczne_json FROM zamowienia WHERE id = ?')
      .get(id).pozycje_reczne_json);
    expect(mapa).toEqual({ s4321: { ilosc: 3 } });
  });

  it('wyzerowanie pozycji PLATNEJ dalej jest odmową', async () => {
    const id = zGratisem();
    const r = await wyslij(`/zamowienia/${id}/pozycje/zapisz`, {
      klucz: ['s4321', 's4322'],
      nazwa: ['STOP', 'Próbka gratis'],
      ilosc: ['2', '1'],
      cena_brutto: ['0.00', '0.00'],
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/większa od zera/);
    expect(db.prepare('SELECT pozycje_reczne_json FROM zamowienia WHERE id = ?').get(id).pozycje_reczne_json)
      .toBe(null);
  });
});

// =====================================================================================
// ODNOSNIK DO PRODUKTU — TEST NA STYKU, bo dokladnie tam peklo (21.08.2026).
//
// Regula „pozycja z oferty nie dostaje odnosnika" mieszkala w domenie i miala tam swoje
// testy — a mimo to na produkcji kazda pozycja zamowienia z oferty prowadzila do ukrytego
// produktu-zaslepki. Powod: zmiana w SASIEDNIM module (domain/tabela-pozycji.js) zabrala
// regule jej jedyna przeslanke, wiec obie strony byly zielone, a styk miedzy nimi nie.
// Ten test patrzy na GOTOWA STRONE i dlatego lapie to, czego zaden test jednostkowy nie mial
// jak zobaczyc.
// =====================================================================================
describe('odnośnik do produktu na karcie', () => {
  const zOferty = (nad = {}) => zmapowane({
    zrodlo_id: 28216,
    numer: '28216',
    kwota_brutto: '115.00',
    koszt_dostawy_brutto: '0.00',
    koszt_dostawy_netto: '0.00',
    pozycje: [
      {
        zrodlo_id: 9001, nazwa: 'szablon malarski jednorazowy - samoprzylepny RUM and towel',
        sku: 'psm-zam-placeholder', ilosc: 2, cena_brutto: '48.00', cena_netto: '48.00',
        brutto_linii: '96.00', netto_linii: '96.00', vat: null, produkt_id: 28040,
      },
      {
        zrodlo_id: 9002, nazwa: 'wysyłka kurierem DPD', sku: 'psm-zam-placeholder', ilosc: 1,
        cena_brutto: '19.00', cena_netto: '19.00', brutto_linii: '19.00', netto_linii: '19.00',
        vat: null, produkt_id: 28040,
      },
    ],
    ...nad,
  });

  it('pozycja z oferty NIE prowadzi do ukrytego produktu-zaślepki', async () => {
    const id = zapiszZamowienie(db, 'szkicownia', zOferty(), {});
    const body = (await karta(id)).body;
    expect(body).not.toContain('post_type=product&amp;p=28040');
    expect(body).not.toContain('post_type=product&p=28040');
  });

  it('SKU zaślepki nie pokazuje się, ani w odczycie, ani w edycji', async () => {
    const id = zapiszZamowienie(db, 'szkicownia', zOferty(), {});
    expect((await karta(id)).body).not.toContain('psm-zam-placeholder');
    expect((await karta(id, '?edytuj=pozycje')).body).not.toContain('psm-zam-placeholder');
  });

  // GRANICA: zwykla pozycja sklepowa odnosnik dalej MA — bez tego test wyzej przechodzilby
  // takze wtedy, gdyby ktos skasowal odnosniki w ogole.
  it('zwykła pozycja sklepowa dalej ma odnośnik do produktu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane({
      zrodlo_id: 7777,
      pozycje: [{
        zrodlo_id: 9003, nazwa: 'STOP 70x100', sku: 'PRO-STOP-001', ilosc: 1, cena_brutto: '123.00',
        cena_netto: '100.00', brutto_linii: '123.00', netto_linii: '100.00', vat: null, produkt_id: 5150,
      }],
    }), {});
    expect((await karta(id)).body).toContain('p=5150');
  });
});

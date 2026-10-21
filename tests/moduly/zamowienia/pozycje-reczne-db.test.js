import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createWooAdapter } from '../../../src/oms/woo/adapter.js';
import { createPoller } from '../../../src/moduly/kanaly/services/poller.js';
import {
  zapiszZamowienie, pobierzZamowienie, listaZamowien,
  dodajPozycjeReczna, zapiszPozycjeReczna, usunPozycjeReczna, zapiszNadpisaniaPozycji,
} from '../../../src/oms/db/zamowienia.js';
import { dodajWplateReczna } from '../../../src/oms/db/platnosci.js';
import { kwotaOczekiwanaGrosze, kwotaZamowieniaGrosze } from '../../../src/domena/suma-pozycji.js';
import { saldoWplat } from '../../../src/domena/platnosci.js';
import { parsujNowaPozycje } from '../../../src/domena/pozycje-reczne.js';

// Zamowienie DOKLADNIE w postaci, w jakiej oddaje je WooCommerce — tego samego uzywa poller.
const zeSklepu = (nad = {}) => ({
  id: 1301, number: '1301', status: 'processing', total: '212.90',
  date_created: '2026-07-29T10:00:00', date_modified: '2026-07-29T10:00:00',
  date_modified_gmt: '2026-07-29T10:00:00',
  billing: {}, shipping: {}, shipping_lines: [{ method_id: 'flat_rate', instance_id: '1' }],
  shipping_total: '73.09', shipping_tax: '16.81',
  line_items: [{ id: 4321, name: 'STOP', sku: 'PRO-STOP-001', quantity: 2, total: '100.00', total_tax: '23.00' }],
  meta_data: [],
  ...nad,
});

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

// PELNY przebieg pollera, nie samo zapiszZamowienie: to on jest tym, co realnie chodzi na
// produkcji co dwie minuty, i to jego trzeba przepuscic, zeby dowod cokolwiek znaczyl.
async function przebiegPollera(nad = {}) {
  const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [zeSklepu(nad)], stron: 1 }) };
  await createPoller({ db, kanal: createWooAdapter({ woo }), sklep: 'pro' }).przebieg();
}

// Po numerze, NIE „pierwsze z listy": część testów zakłada najpierw kilka pustych zamówień,
// żeby rozjechać liczniki AUTOINCREMENT (przewodnik OMS, 6.3), a lista jest posortowana
// po dacie utworzenia.
const idZamowienia = () => listaZamowien(db).find((z) => z.numer === '1301').id;

// PRZ-105: stawka pozycji ręcznej ląduje w `pozycje.vat` i zmienia się razem z edycją pozycji.
describe('stawka VAT pozycji ręcznej w bazie (PRZ-105)', () => {
  it('dodajPozycjeReczna zapisuje vat; zapiszPozycjeReczna go zmienia; bez vat zostawia stary', async () => {
    await przebiegPollera();
    const id = idZamowienia();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Album', ilosc: '1', cena_brutto: '10.80', vat: '8' }));
    const r = () => db.prepare("SELECT * FROM pozycje WHERE zamowienie_id = ? AND zrodlo = 'reczna'").get(id);
    expect(r().vat).toBe('8');
    zapiszPozycjeReczna(db, id, r().id, { nazwa: 'Album', ilosc: 1, cena_brutto: '10.50', brutto_linii: '10.50', vat: '5' });
    expect(r().vat).toBe('5');
    zapiszPozycjeReczna(db, id, r().id, { nazwa: 'Album', ilosc: 2, cena_brutto: '10.50', brutto_linii: '21.00' });
    expect(r().vat).toBe('5');
  });

  it('stawka spoza listy nie trafia do bazy — odmowa', async () => {
    await przebiegPollera();
    const id = idZamowienia();
    expect(() => dodajPozycjeReczna(db, id, { nazwa: 'X', ilosc: 1, cena_brutto: '1.00', brutto_linii: '1.00', vat: '22' })).toThrow(/stawk/i);
  });
});

describe('poller a pozycje dopisane ręcznie', () => {
  // ⚠️ TO JEST TEST, DLA KTOREGO CALE ZADANIE ISTNIEJE. `zapiszPozycje` robi DELETE + INSERT,
  // wiec pozycja dopisana recznie znikalaby w ciagu dwoch minut — razem z pieniedzmi,
  // ktorych panel przestalby sie od klienta domagac.
  it('PEŁNY przebieg pollera NIE kasuje pozycji dopisanej ręcznie', async () => {
    await przebiegPollera();
    const id = idZamowienia();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dodatkowy szablon', ilosc: '1', cena_brutto: '80.00' }));

    await przebiegPollera({ date_modified_gmt: '2026-07-29T11:00:00' });

    const z = pobierzZamowienie(db, id);
    expect(z.pozycje.map((p) => p.nazwa)).toEqual(['STOP', 'Dodatkowy szablon']);
    expect(z.pozycje.find((p) => p.reczna).brutto_linii).toBe('80.00');
  });

  it('przebieg pollera NIE mnoży pozycji sklepowych (kasowanie dalej działa)', async () => {
    await przebiegPollera();
    await przebiegPollera({ date_modified_gmt: '2026-07-29T11:00:00' });
    expect(pobierzZamowienie(db, idZamowienia()).pozycje).toHaveLength(1);
  });

  // Pozycje sklepowe dostaja przy kazdej synchronizacji NOWE, wyzsze `id`, wiec porzadek po
  // samym `id` wypychalby dopisek na poczatek tabeli co dwie minuty — numeracja na karcie
  // tanczylaby operatorowi przed oczami, a numer porzadkowy bywa kluczem nadpisania.
  it('pozycja ręczna zostaje na KOŃCU tabeli także po synchronizacji', async () => {
    await przebiegPollera();
    const id = idZamowienia();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));
    await przebiegPollera({ date_modified_gmt: '2026-07-29T11:00:00' });
    expect(pobierzZamowienie(db, id).pozycje.map((p) => p.reczna)).toEqual([false, true]);
  });

  it('pozycja ze sklepu usunięta w sklepie znika u nas, ręczna zostaje', async () => {
    await przebiegPollera();
    const id = idZamowienia();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '10.00' }));
    await przebiegPollera({ date_modified_gmt: '2026-07-29T11:00:00', line_items: [] });
    expect(pobierzZamowienie(db, id).pozycje.map((p) => p.nazwa)).toEqual(['Dopłata']);
  });
});

describe('poller a ręczne nadpisania pozycji sklepowych', () => {
  // ⚠️ Nadpisanie wpisane wprost w wiersz pozycji zniknelo by razem z nim. Ten test pilnuje,
  // ze mieszka OBOK — w kolumnie, ktorej synchronizacja nie dotyka.
  it('PEŁNY przebieg pollera NIE kasuje nadpisania pozycji sklepowej', async () => {
    await przebiegPollera();
    const id = idZamowienia();
    zapiszNadpisaniaPozycji(db, id, { s4321: { ilosc: 3 } });

    await przebiegPollera({ date_modified_gmt: '2026-07-29T11:00:00' });

    const [p] = pobierzZamowienie(db, id).pozycje;
    expect(p.ilosc).toBe(3);
    expect(p.polaZmienione).toEqual(['ilosc']);
  });

  // ⚠️ Nadpisanie jest POLOWE. Gdyby zapisywalo caly wiersz, poprawka ceny w sklepie nigdy by
  // juz nie doszla — a to wlasnie ten rodzaj cichej awarii, ktory panel ma wykluczac.
  it('po nadpisaniu SAMEJ ilości zmiana ceny w sklepie dalej dochodzi', async () => {
    await przebiegPollera();
    const id = idZamowienia();
    zapiszNadpisaniaPozycji(db, id, { s4321: { ilosc: 3 } });

    // Sklep podnosi cene: 2 szt. za 140,00 brutto (70,00 za sztuke).
    await przebiegPollera({
      date_modified_gmt: '2026-07-29T11:00:00',
      total: '229.90',
      line_items: [{ id: 4321, name: 'STOP', sku: 'PRO-STOP-001', quantity: 2, total: '113.82', total_tax: '26.18' }],
    });

    const [p] = pobierzZamowienie(db, id).pozycje;
    expect(p.cena_brutto).toBe('70.00');
    expect(p.ilosc).toBe(3);
    // ...i suma linii idzie za NOWA cena, a nie za ta, ktora byla w chwili nadpisania.
    expect(p.brutto_linii).toBe('210.00');
  });

  it('po nadpisaniu SAMEJ ilości zmiana nazwy w sklepie dalej dochodzi', async () => {
    await przebiegPollera();
    const id = idZamowienia();
    zapiszNadpisaniaPozycji(db, id, { s4321: { ilosc: 3 } });
    await przebiegPollera({
      date_modified_gmt: '2026-07-29T11:00:00',
      line_items: [{ id: 4321, name: 'STOP (nowa nazwa)', sku: 'PRO-STOP-001', quantity: 2, total: '100.00', total_tax: '23.00' }],
    });
    expect(pobierzZamowienie(db, idZamowienia()).pozycje[0].nazwa).toBe('STOP (nowa nazwa)');
  });

  // Klucz nadpisania jest identyfikatorem linii U ZRODLA wlasnie po to: `pozycje.id` zmienia
  // sie przy kazdej synchronizacji, wiec klucz z niego zbudowany osierocilby sie sam.
  it('identyfikator wiersza w bazie zmienia się przy synchronizacji — klucz nadpisania nie', async () => {
    await przebiegPollera();
    const id = idZamowienia();
    const przed = pobierzZamowienie(db, id).pozycje[0];
    await przebiegPollera({ date_modified_gmt: '2026-07-29T11:00:00' });
    const po = pobierzZamowienie(db, id).pozycje[0];
    expect(po.id).not.toBe(przed.id);
    expect(po.klucz).toBe(przed.klucz);
  });
});

// ⚠️ KWOTA ZE SKLEPU NIE ROSNIE. Wplata o zrodle 'sklep' podaza za `kwota_brutto` przy kazdej
// synchronizacji, wiec podniesienie tej kolumny podnioslo by RAZEM z nia wplate — i niedoplata
// zniknelaby z ekranu. To jest caly sens tej funkcji.
describe('kwota zamówienia a pozycja dopisana ręcznie', () => {
  it('dopisana pozycja NIE podnosi kwota_brutto', async () => {
    await przebiegPollera();
    const id = idZamowienia();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));
    expect(pobierzZamowienie(db, id).kwota_brutto).toBe('212.90');
    expect(db.prepare('SELECT kwota_brutto FROM zamowienia WHERE id = ?').get(id).kwota_brutto).toBe('212.90');
  });

  it('dopisana pozycja podnosi KWOTĘ OCZEKIWANĄ od klienta', async () => {
    await przebiegPollera();
    const id = idZamowienia();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));
    const z = pobierzZamowienie(db, id);
    expect(kwotaZamowieniaGrosze(z)).toBe(21290);
    expect(kwotaOczekiwanaGrosze(z)).toBe(29290);
  });

  // ⚠️ SEDNO: zamowienie oplacone w sklepie co do grosza PRZESTAJE byc oplacone, gdy dochodzi
  // doplata. Gdyby `kwota_brutto` urosla, wplata sklepowa urroslaby razem z nia i panel
  // pokazalby „oplacone" — czyli przestalby pokazywac, ze klient jest nam winien pieniadze.
  it('opłacone w sklepie + dopisana pozycja = NIEDOPŁATA, nie „opłacone"', async () => {
    await przebiegPollera({ date_paid: '2026-07-29T10:05:00' });
    const id = idZamowienia();
    expect(pobierzZamowienie(db, id).oplacone_at).toBe('2026-07-29T10:05:00');

    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));

    const z = pobierzZamowienie(db, id);
    expect(z.oplacone_at).toBeNull();
    expect(saldoWplat(z)).toMatchObject({ stan: 'niedoplata', roznicaZl: '80.00', kwotaZl: '292.90' });
  });

  it('niedopłata nie odżywa po synchronizacji — wpłata ze sklepu zostaje przy kwocie sklepowej', async () => {
    await przebiegPollera({ date_paid: '2026-07-29T10:05:00' });
    const id = idZamowienia();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));
    await przebiegPollera({ date_modified_gmt: '2026-07-29T11:00:00', date_paid: '2026-07-29T10:05:00' });

    const z = pobierzZamowienie(db, id);
    expect(z.platnosci.find((p) => p.zrodlo === 'sklep').kwota).toBe('212.90');
    expect(z.oplacone_at).toBeNull();
  });

  it('dopłata zaksięgowana ręcznie domyka kwotę oczekiwaną', async () => {
    await przebiegPollera({ date_paid: '2026-07-29T10:05:00' });
    const id = idZamowienia();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));
    dodajWplateReczna(db, id, { kwota: '80.00', data: '2026-08-02' });

    const z = pobierzZamowienie(db, id);
    expect(z.oplacone_at).toBe('2026-08-02');
    expect(saldoWplat(z).stan).toBe('pokryte');
  });

  it('nadpisanie ilości w GÓRĘ też robi niedopłatę', async () => {
    await przebiegPollera({ date_paid: '2026-07-29T10:05:00' });
    const id = idZamowienia();
    zapiszNadpisaniaPozycji(db, id, { s4321: { ilosc: 3 } });
    const z = pobierzZamowienie(db, id);
    expect(saldoWplat(z)).toMatchObject({ stan: 'niedoplata', kwotaZl: '274.40' });
  });
});

describe('edycja i usuwanie pozycji ręcznej', () => {
  // Liczniki AUTOINCREMENT roznych tabel zbiegaja sie w swiezej bazie (przewodnik OMS, 6.3),
  // wiec bez wypelniaczy `id` zamowienia rownaloby sie `id` pozycji i pomylka argumentu
  // przeszlaby niezauwazona.
  async function zamowienieZRozjechanymiLicznikami() {
    for (let i = 0; i < 4; i += 1) {
      zapiszZamowienie(db, 'pro', {
        zrodlo_id: 9000 + i, numer: `900${i}`, klient: {}, dostawa: {}, metoda_wysylki: 'dpd',
        kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '1.00',
        status_woo: 'processing', oplacone_at: null, anulowane: 0, pozycje: [],
      }, {});
    }
    await przebiegPollera();
    return idZamowienia();
  }

  it('pozycję ręczną da się usunąć', async () => {
    const id = await zamowienieZRozjechanymiLicznikami();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Pomyłka', ilosc: '1', cena_brutto: '80.00' }));
    const p = pobierzZamowienie(db, id).pozycje.find((w) => w.reczna);

    const usunieta = usunPozycjeReczna(db, id, p.id);

    expect(usunieta.nazwa).toBe('Pomyłka');
    expect(pobierzZamowienie(db, id).pozycje.map((w) => w.nazwa)).toEqual(['STOP']);
  });

  it('usunięcie pozycji cofa niedopłatę, którą wprowadziła', async () => {
    const id = await zamowienieZRozjechanymiLicznikami();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Pomyłka', ilosc: '1', cena_brutto: '80.00' }));
    const p = pobierzZamowienie(db, id).pozycje.find((w) => w.reczna);
    usunPozycjeReczna(db, id, p.id);
    expect(kwotaOczekiwanaGrosze(pobierzZamowienie(db, id))).toBe(21290);
  });

  // Pozycja ze sklepu nalezy do sklepu — poller wstawilby ja z powrotem, wiec panel
  // obiecywalby skasowanie, ktore samo sie cofa po dwoch minutach.
  it('pozycji ze sklepu usunąć się NIE da', async () => {
    const id = await zamowienieZRozjechanymiLicznikami();
    const p = db.prepare("SELECT id FROM pozycje WHERE zamowienie_id = ? AND zrodlo = 'sklep'").get(id);
    expect(() => usunPozycjeReczna(db, id, p.id)).toThrow(/nie da się usunąć/i);
    expect(pobierzZamowienie(db, id).pozycje).toHaveLength(1);
  });

  it('pozycji CUDZEGO zamówienia nie da się tknąć', async () => {
    const id = await zamowienieZRozjechanymiLicznikami();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Moja', ilosc: '1', cena_brutto: '5.00' }));
    const p = pobierzZamowienie(db, id).pozycje.find((w) => w.reczna);
    const obce = listaZamowien(db).find((z) => z.id !== id).id;
    expect(() => usunPozycjeReczna(db, obce, p.id)).toThrow(/nie ma takiej pozycji/i);
  });

  it('edycja pozycji ręcznej zmienia wiersz wprost i przelicza sumę linii', async () => {
    const id = await zamowienieZRozjechanymiLicznikami();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));
    const p = pobierzZamowienie(db, id).pozycje.find((w) => w.reczna);

    zapiszPozycjeReczna(db, id, p.id, parsujNowaPozycje({ nazwa: 'Dopłata x2', ilosc: '2', cena_brutto: '80.00' }));

    const po = pobierzZamowienie(db, id).pozycje.find((w) => w.reczna);
    expect(po).toMatchObject({ nazwa: 'Dopłata x2', ilosc: 2, brutto_linii: '160.00' });
    expect(kwotaOczekiwanaGrosze(pobierzZamowienie(db, id))).toBe(21290 + 16000);
  });

  it('edycja pozycji ręcznej przeżywa przebieg pollera', async () => {
    const id = await zamowienieZRozjechanymiLicznikami();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));
    const p = pobierzZamowienie(db, id).pozycje.find((w) => w.reczna);
    zapiszPozycjeReczna(db, id, p.id, parsujNowaPozycje({ nazwa: 'Dopłata x2', ilosc: '2', cena_brutto: '80.00' }));
    await przebiegPollera({ date_modified_gmt: '2026-07-29T11:00:00' });
    expect(pobierzZamowienie(db, id).pozycje.find((w) => w.reczna).ilosc).toBe(2);
  });
});

describe('lista zamówień widzi te same wartości co karta', () => {
  it('pozycje na liście też są po nałożeniu nadpisań', async () => {
    await przebiegPollera();
    const id = idZamowienia();
    zapiszNadpisaniaPozycji(db, id, { s4321: { ilosc: 3 } });
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));

    const z = listaZamowien(db).find((w) => w.id === id);
    expect(z.pozycje.map((p) => p.ilosc)).toEqual([3, 1]);
    expect(kwotaOczekiwanaGrosze(z)).toBe(21290 + 6150 + 8000);
  });

  it('opłacone na liście liczy się od kwoty oczekiwanej, tak samo jak na karcie', async () => {
    await przebiegPollera({ date_paid: '2026-07-29T10:05:00' });
    const id = idZamowienia();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));
    expect(listaZamowien(db).find((w) => w.id === id).oplacone_at).toBeNull();
  });
});

// Migracja idzie na PLIK, bo dwa razy ':memory:' to dwie osobne bazy i nie sprawdzałoby
// niczego — ta sama zasada, co w backfill-uwagi.test.js. Na produkcji leżą trzy prawdziwe
// zamówienia, przesyłka z prawdziwym numerem listu i wpłaty po wczorajszej migracji.
describe('migracja na bazie z danymi', () => {
  const plikBazy = () => join(mkdtempSync(join(tmpdir(), 'oms-poz-')), 'oms.sqlite');

  // Baza w stanie SPRZED tej zmiany: pozycje bez identyfikatora linii ze sklepu (kolumny
  // wtedy nie było). Oddaje połączenie po PONOWNYM otwarciu, czyli po przebiegu migracji.
  async function poPonownymOtwarciu({ zRecznaPozycja = false } = {}) {
    const plik = plikBazy();
    const pierwsza = openOmsDb(plik);
    const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [zeSklepu()], stron: 1 }) };
    await createPoller({ db: pierwsza, kanal: createWooAdapter({ woo }), sklep: 'pro' }).przebieg();
    const id = listaZamowien(pierwsza)[0].id;
    if (zRecznaPozycja) {
      dodajPozycjeReczna(pierwsza, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));
    }
    pierwsza.prepare("UPDATE pozycje SET zrodlo_id = NULL WHERE zrodlo = 'sklep'").run();
    pierwsza.close();
    return { db: openOmsDb(plik), id };
  }

  // Poller chodzi po kursorze `date_modified`, więc zamówienia niezmienionego w sklepie nie
  // odczyta już nigdy — bez przeliczenia pozycje na produkcji zostałyby bez identyfikatora
  // linii i spadały na zapasowy klucz z numeru porządkowego.
  it('dokłada identyfikator linii ze sklepu do pozycji zapisanych wcześniej', async () => {
    const { db: druga, id } = await poPonownymOtwarciu();
    expect(druga.prepare('SELECT zrodlo_id FROM pozycje WHERE zamowienie_id = ?').get(id).zrodlo_id).toBe(4321);
    druga.close();
  });

  it('każda pozycja już leżąca w bazie dostaje źródło „sklep"', async () => {
    const { db: druga } = await poPonownymOtwarciu();
    expect(druga.prepare('SELECT DISTINCT zrodlo FROM pozycje').all()).toEqual([{ zrodlo: 'sklep' }]);
    druga.close();
  });

  it('jest idempotentna — trzecie otwarcie tej samej bazy niczego nie zmienia', async () => {
    const { db: druga } = await poPonownymOtwarciu({ zRecznaPozycja: true });
    const przed = druga.prepare('SELECT id, zrodlo, zrodlo_id, brutto_linii, netto_linii FROM pozycje ORDER BY id').all();
    const sciezka = druga.prepare('PRAGMA database_list').all()[0].file;
    druga.close();

    const trzecia = openOmsDb(sciezka);
    expect(trzecia.prepare('SELECT id, zrodlo, zrodlo_id, brutto_linii, netto_linii FROM pozycje ORDER BY id').all())
      .toEqual(przed);
    trzecia.close();
  });

  // Bez zawężenia przeliczeń do wierszy sklepowych jedna dopisana pozycja rozjeżdżałaby
  // liczbę wierszy z liczbą `line_items` i BLOKOWAŁA przeliczenie reszty zamówienia.
  it('pozycja ręczna nie dostaje identyfikatora ze sklepu ani nie blokuje przeliczenia', async () => {
    const { db: druga } = await poPonownymOtwarciu({ zRecznaPozycja: true });
    expect(druga.prepare('SELECT zrodlo, zrodlo_id FROM pozycje ORDER BY id').all())
      .toEqual([{ zrodlo: 'sklep', zrodlo_id: 4321 }, { zrodlo: 'reczna', zrodlo_id: null }]);
    druga.close();
  });

  it('wpłaty i kwoty zamówienia przechodzą migrację bez zmiany', async () => {
    const { db: druga, id } = await poPonownymOtwarciu({ zRecznaPozycja: true });
    const z = pobierzZamowienie(druga, id);
    expect(z.kwota_brutto).toBe('212.90');
    expect(kwotaOczekiwanaGrosze(z)).toBe(29290);
    druga.close();
  });
});

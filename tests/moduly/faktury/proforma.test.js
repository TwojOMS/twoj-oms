import { describe, it, expect, vi } from 'vitest';
import {
  mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, zapiszNadpisaniaFaktury } from '../../../src/oms/db/zamowienia.js';
import { proformyZamowienia } from '../../../src/moduly/faktury/db/proformy.js';
import { aktualnaProforma } from '../../../src/domena/proforma-stan.js';
import { fmtDataCzasKrotko } from '../../../src/domena/format-daty.js';
import { createProforma } from '../../../src/moduly/faktury/services/proforma.js';
import { loadOmsConfig } from '../../pomoc/konfiguracja-parytetu.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapiszStawkeDomyslna } from '../../../src/moduly/faktury/db/stawka-vat.js';

// Zamowienie ze sklepu: 2 x 61,50 = 123,00 zl, bez dostawy. Te same liczby, co w
// tests/oms/faktura.test.js — proforma i faktura licza pozycje TA SAMA funkcja
// (domain/pozycje-faktury.js), wiec dane wejsciowe tez maja byc te same.
const zmapowane = (nad = {}) => ({
  zrodlo_id: 1301,
  numer: '1301',
  klient: {
    first_name: 'Jan', last_name: 'Kowalski', company: 'ACME', email: 'j@k.pl', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki',
  },
  dostawa: {},
  metoda_wysylki: 'dpd',
  kwota_pobrania: null,
  chce_fakture: 0,
  nip: '1000001201',
  kwota_brutto: '123.00',
  koszt_dostawy_brutto: '0.00',
  status_woo: 'processing',
  oplacone_at: null,
  anulowane: 0,
  utworzone_at: '2026-08-04T10:00:00',
  pozycje: [{
    nazwa: 'STOP 70x100', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '61.50', vat: null,
  }],
  ...nad,
});

const NADAWCA = {
  nazwa: 'Lumina Marek Zywiecki',
  ulica: 'ul. 1 Maja 5',
  kod: '00-650',
  miasto: 'Pęki',
  kraj: 'PL',
  phone: '',
};

// ⚠️ ZEGAR WSTRZYKNIETY, bo numer proformy zawiera MIESIAC I ROK. Test czytajacy prawdziwy
// zegar bylby zielony w sierpniu 2026 i czerwony we wrzesniu — a numer dokumentu jest tym,
// co klient wpisuje w tytul przelewu, wiec ma byc sprawdzony co do znaku.
const ZEGAR = () => new Date('2026-08-04T10:00:00.000Z');

function zestaw(nad = {}, opcje = {}) {
  const db = openOmsDb(':memory:');
  const katalog = join(mkdtempSync(join(tmpdir(), 'oms-proformy-')), 'proformy');
  const config = {
    nadawca: NADAWCA,
    proforma: {
      nip: '1234563218', rachunek: '34109010140000000000000000', bank: 'Millennium', katalog,
    },
  };
  const id = zapiszZamowienie(db, 'pro', zmapowane(nad), {});
  const proforma = createProforma({
    db, config, teraz: ZEGAR, ...opcje,
  });
  return {
    db, id, katalog, config, proforma,
  };
}

const logi = (db, id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id)
  .filter((w) => w.akcja === 'proforma');

// PRZ-105: proforma bierze stawkę domyślną z Ustawień — tę samą, którą dostaje faktura VAT.
describe('proforma — stawka domyślna z Ustawień (PRZ-105)', () => {
  it('wpis 8 → podsumowanie VAT proformy ma jeden wiersz 8%', () => {
    const budujPdf = vi.fn(() => Buffer.from('%PDF-1.3 atrapa'));
    const { db, id, proforma } = zestaw({}, { budujPdf });
    zapiszStawkeDomyslna(db, '8');
    proforma.wystaw(id);
    const wiersze = budujPdf.mock.calls[0][0].podsumowanieVat;
    expect(wiersze.filter((w) => !w.suma).map((w) => w.stawka)).toEqual([8]);
  });
});

describe('proforma — udana ścieżka', () => {
  it('nadaje numer PF/1/08/2026, zapisuje plik i podpina jego ścieżkę', () => {
    const { db, id, proforma, katalog } = zestaw();

    const p = proforma.wystaw(id);

    expect(p.numer).toBe('PF/1/08/2026');
    const [wiersz] = proformyZamowienia(db, id);
    expect(wiersz.numer).toBe('PF/1/08/2026');
    // Kwota to MIGAWKA z chwili wystawienia — 2 x 61,50 zl.
    expect(wiersz.kwota_brutto).toBe('123.00');
    expect(wiersz.uniewazniona_at).toBeNull();
    // Nazwa pliku niesie numer ZAMOWIENIA i numer DOKUMENTU, oba oczyszczone
    // (`PF/1/08/2026` ma ukosniki, ktore wyprowadzilyby zapis poza katalog).
    expect(wiersz.plik_sciezka).toBe(join(katalog, '1301-PF_1_08_2026.pdf'));
    expect(existsSync(wiersz.plik_sciezka)).toBe(true);
    expect(readFileSync(wiersz.plik_sciezka).subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('zapisuje numer dokumentu w logu zamówienia', () => {
    const { db, id, proforma } = zestaw();
    proforma.wystaw(id);
    expect(logi(db, id).map((w) => w.wynik)).toEqual(['PF/1/08/2026']);
  });

  it('oddaje bajty zapisanego PDF-a przez pdf(id)', () => {
    const { id, proforma } = zestaw();
    const p = proforma.wystaw(id);
    const { bajty, numer } = proforma.pdf(p.id);
    expect(numer).toBe('PF/1/08/2026');
    expect(bajty.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });
});

// ⚠️ PRZELOM MIESIACA. Kontener chodzi z TZ=UTC, wiec goly `getFullYear()`/`getMonth()`/
// `getDate()` na znaczniku „1 wrzesnia 01:30 w Warszawie" oddaje 31 SIERPNIA — dokument
// z wczorajsza data i numerem z sierpniowej serii, podczas gdy karta (fmtDataCzasKrotko,
// domain/format-daty.js) pokazuje przy nim wrzesien. Rozjazd widoczny golym okiem.
//
// Repo ma na to jawna regule: `dzienWarszawa` (domain/format-daty.js), ta sama, ktora liczy
// „dzisiaj" dla faktury VAT (domain/termin-platnosci.js).
//
// ⚠️ TEST MUSI DAWAC TEN SAM WYNIK NA KAZDEJ MASZYNIE — i to jest tu polowa roboty.
// Test czytajacy strefe laptopa (Europe/Warsaw) swiecilby na zielono NAWET NA ZEPSUTYM
// KODZIE, bo `getMonth()` oddaje wtedy wrzesien sam z siebie; awaria jest widoczna dopiero
// przy TZ=UTC, czyli dokladnie tam, gdzie chodzi kontener. Dlatego kazdy przypadek leci
// przez KILKA stref (Node >= 16 czyta `process.env.TZ` na biezaco) — wynik ma byc ten sam.
describe('proforma — przełom miesiąca liczony w czasie warszawskim', () => {
  // 31.08.2026 23:30 UTC = 01:30 dnia 1.09.2026 w Warszawie (CEST, +02:00).
  const ZEGAR_NOCNY = () => new Date('2026-08-31T23:30:00.000Z');
  // UTC = produkcja; Europe/Warsaw = laptop; Pacific/Kiritimati (+14) = strefa, ktora
  // wyprzedza Warszawe o kolejny dzien, wiec zlapie i odwrotna pomylke.
  const STREFY = ['UTC', 'Europe/Warsaw', 'Pacific/Kiritimati'];

  const wStrefie = (strefa, co) => {
    const poprzednia = process.env.TZ;
    process.env.TZ = strefa;
    try { return co(); } finally { process.env.TZ = poprzednia; }
  };

  it.each(STREFY)('przy TZ=%s numer bierze WRZEŚNIOWĄ serię, a nie sierpniową', (strefa) => {
    const p = wStrefie(strefa, () => {
      const { id, proforma } = zestaw({}, { teraz: ZEGAR_NOCNY });
      return proforma.wystaw(id);
    });
    expect(p.numer).toBe('PF/1/09/2026');
    expect(p).toMatchObject({ rok: 2026, miesiac: 9 });
  });

  it.each(STREFY)('przy TZ=%s data wystawienia to 2026-09-01, a nie 2026-08-31', (strefa) => {
    const budujPdf = vi.fn(() => Buffer.from('%PDF-1.3 atrapa'));
    wStrefie(strefa, () => {
      const { id, proforma } = zestaw({}, { teraz: ZEGAR_NOCNY, budujPdf });
      proforma.wystaw(id);
    });
    expect(budujPdf.mock.calls[0][0].dataWystawienia).toBe('2026-09-01');
  });

  // Data z dokumentu i data przy nim NA KARCIE musza pokazywac ten sam dzien — karta liczy
  // ja `fmtDataCzasKrotko`, czyli tez w Warszawie. To ten rozjazd byl widoczny na ekranie.
  it.each(STREFY)('przy TZ=%s dzień z dokumentu zgadza się z dniem na karcie', (strefa) => {
    const budujPdf = vi.fn(() => Buffer.from('%PDF-1.3 atrapa'));
    const p = wStrefie(strefa, () => {
      const { id, proforma } = zestaw({}, { teraz: ZEGAR_NOCNY, budujPdf });
      return proforma.wystaw(id);
    });
    expect(fmtDataCzasKrotko(p.utworzona_at).slice(0, 10))
      .toBe(budujPdf.mock.calls[0][0].dataWystawienia);
  });
});

describe('proforma — historia i unieważnianie', () => {
  // Dwie wazne proformy naraz to klient placacy wedlug starej kwoty. Poprzednia znika
  // z obiegu, ale NIE z historii: klient dostal ja mailem i moze miec przed soba, wiec
  // panel musi umiec powiedziec „ta juz nie obowiazuje", a nie udawac, ze nie istniala.
  it('druga proforma unieważnia pierwszą, a pierwsza zostaje w historii', () => {
    const { db, id, proforma } = zestaw();

    const p1 = proforma.wystaw(id);
    const p2 = proforma.wystaw(id);

    expect(p2.numer).toBe('PF/2/08/2026');
    const lista = proformyZamowienia(db, id);
    expect(lista.map((w) => w.numer)).toEqual(['PF/1/08/2026', 'PF/2/08/2026']);
    expect(lista[0].uniewazniona_at).not.toBeNull();
    expect(lista[1].uniewazniona_at).toBeNull();
    expect(aktualnaProforma(lista).id).toBe(p2.id);
    expect(p1.id).not.toBe(p2.id);
  });
});

describe('proforma — odmowy przed nadaniem numeru', () => {
  // ⚠️ NIEUDANA PROFORMA NIE MA PRAWA ZUZYC NUMERU Z SERII. Bariera arytmetyczna stoi
  // PRZED `zapiszProforme`, wiec po odmowie licznik miesiaca stoi dalej na zerze —
  // inaczej w numeracji zostawalaby dziura, ktorej nikt pozniej nie wyjasni.
  it('rozjazd sumy odmawia, a następna proforma dostaje numer 1', () => {
    const { db, id, proforma } = zestaw({ kwota_brutto: '999.00' });

    expect(() => proforma.wystaw(id)).toThrow(/nie zgadza się z kwotą zamówienia/);
    expect(proformyZamowienia(db, id)).toHaveLength(0);

    db.prepare("UPDATE zamowienia SET kwota_brutto = '123.00' WHERE id = ?").run(id);
    expect(proforma.wystaw(id).numer).toBe('PF/1/08/2026');
  });

  it('zamówienie anulowane → odmowa i ani jednego wiersza', () => {
    const { db, id, proforma } = zestaw({ anulowane: 1 });
    expect(() => proforma.wystaw(id)).toThrow(/anulowane/);
    expect(proformyZamowienia(db, id)).toHaveLength(0);
  });

  // Proforma bez nazwy i adresu sprzedawcy to dokument, ktorego nie da sie wyslac —
  // a puste pola adresu firmy to dokladnie ta cicha awaria z lipca 2026 (patrz config.js).
  it('bez adresu nadawcy odmawia, zamiast wystawić dokument z pustym sprzedawcą', () => {
    const { db, id, config } = zestaw();
    const bezNadawcy = createProforma({
      db, config: { ...config, nadawca: null }, teraz: ZEGAR,
    });
    expect(() => bezNadawcy.wystaw(id)).toThrow(/sprzedawc/i);
    expect(proformyZamowienia(db, id)).toHaveLength(0);
  });
});

describe('proforma — awaria zapisu pliku', () => {
  // ⚠️ DWIE RZECZY NARAZ, i obie sa o pieniadzach:
  //  1. wiersz z numerem, ale bez dokumentu, pokazywalby operatorowi proforme, ktorej
  //     klient nigdy nie dostal (i ktorej „Pobierz PDF" nie ma czego pobrac);
  //  2. poprzednia, WAZNA proforma musi przezyc te awarie — inaczej klient zostaje bez
  //     ani jednego obowiazujacego dokumentu, mimo ze nic nowego mu nie wyslano.
  // Punkt 2 jest tym, co lapie przeniesienie `uniewaznijPoprzednie` przed generacje PDF-a.
  it('nie zostawia wiersza z numerem bez dokumentu, a poprzednia proforma zostaje ważna', () => {
    const { db, id, proforma, katalog } = zestaw();
    const p1 = proforma.wystaw(id);

    // Nazwa, ktorej system plikow nie przyjmie: katalog o nazwie przyszlego pliku.
    mkdirSync(join(katalog, '1301-PF_2_08_2026.pdf'), { recursive: true });
    expect(() => proforma.wystaw(id)).toThrow(/plik/i);

    const lista = proformyZamowienia(db, id);
    expect(lista.map((w) => w.numer)).toEqual(['PF/1/08/2026']);
    expect(aktualnaProforma(lista)?.id).toBe(p1.id);
    expect(lista[0].uniewazniona_at).toBeNull();
  });

  // ⚠️ Numer NIEUDANEJ proby wraca do puli — i to jest poprawne DOKLADNIE dlatego, ze
  // wiersz znika: `nastepnyNumer` liczy MAX z ISTNIEJACYCH wierszy, wiec po skasowaniu
  // licznik cofa sie o jeden. Zaden dokument o tym numerze nie opuscil panelu (PDF nie
  // powstal, nikt go nie dostal), wiec ponowne uzycie numeru nie moze nikogo wprowadzic
  // w blad — a seria nie dostaje dziury, ktorej trzeba by pol roku pozniej tlumaczyc.
  //
  // ⚠️ To NIE dotyczy proformy UNIEWAZNIONEJ: tamten wiersz zostaje w tabeli, wiec MAX go
  // widzi i jej numer jest spalony na zawsze. Klient ma ten PDF przed soba.
  it('numer nieudanej próby wraca do puli, bo żaden dokument z nim nie wyszedł', () => {
    const { id, proforma, katalog } = zestaw();
    proforma.wystaw(id);
    const blokada = join(katalog, '1301-PF_2_08_2026.pdf');
    mkdirSync(blokada, { recursive: true });
    expect(() => proforma.wystaw(id)).toThrow(/plik/i);

    rmSync(blokada, { recursive: true, force: true });
    expect(proforma.wystaw(id).numer).toBe('PF/2/08/2026');
  });
});

describe('proforma — dane na dokumencie', () => {
  const zPodgladem = (nad = {}) => {
    const budujPdf = vi.fn(() => Buffer.from('%PDF-1.3 atrapa'));
    return { budujPdf, ...zestaw(nad, { budujPdf }) };
  };

  // ⚠️ NABYWCA WYLACZNIE PRZEZ `daneFaktury(z)`, NIGDY wprost z `z.klient`/`z.nip`.
  // Operator poprawia dane na karcie, bo klient podal zle albo napisal, ze chce zmienic —
  // czytanie prosto ze sklepu robiloby z tej edycji edycje POZORNA: panel pokazywalby
  // poprawione dane, a do klienta jechalby dokument ze starymi.
  it('bierze nabywcę z poprawek operatora, a nie ze sklepu', () => {
    const { db, id, proforma, budujPdf } = zPodgladem();
    zapiszNadpisaniaFaktury(db, id, {
      firma: 'ACME Sp. z o.o.', nip: '1111111111', ulica: 'Nowa 5', kod: '31-000', miasto: 'Kraków',
    }, null);

    proforma.wystaw(id);

    expect(budujPdf.mock.calls[0][0].nabywca).toMatchObject({
      nazwa: 'ACME Sp. z o.o.', nip: '1111111111', ulica: 'Nowa 5', kod: '31-000', miasto: 'Kraków',
    });
  });

  it('bez poprawek bierze nabywcę ze sklepu', () => {
    const { id, proforma, budujPdf } = zPodgladem();
    proforma.wystaw(id);
    expect(budujPdf.mock.calls[0][0].nabywca).toMatchObject({
      nazwa: 'ACME', nip: '1000001201', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki',
    });
  });

  // Adres sprzedawcy to TEN SAM obiekt, ktorym jada paczki (config.nadawca) — drugi zestaw
  // zmiennych na adres firmy juz raz przeslonil zwalidowany adres pustymi wartosciami.
  it('sprzedawca to config.nadawca plus NIP z konfiguracji', () => {
    const { id, proforma, budujPdf } = zPodgladem();
    proforma.wystaw(id);
    expect(budujPdf.mock.calls[0][0].sprzedawca).toMatchObject({
      nazwa: 'Lumina Marek Zywiecki', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL', nip: '1234563218',
    });
  });

  it('rachunek i bank z konfiguracji, numer i data z chwili wystawienia', () => {
    const { id, proforma, budujPdf } = zPodgladem();
    proforma.wystaw(id);
    expect(budujPdf.mock.calls[0][0]).toMatchObject({
      numer: 'PF/1/08/2026',
      dataWystawienia: '2026-08-04',
      rachunek: '34109010140000000000000000',
      bank: 'Millennium',
    });
  });

  // Pozycje, podsumowanie VAT i „Do zaplaty" licza sie z TYCH SAMYCH wartosci linii, wiec
  // dokument zgadza sie sam ze soba: 123,00 zl brutto przy 23% to 100,00 netto i 23,00 VAT.
  it('pozycje, podsumowanie VAT i kwota słownie zgadzają się ze sobą', () => {
    const { id, proforma, budujPdf } = zPodgladem();
    proforma.wystaw(id);
    const dane = budujPdf.mock.calls[0][0];
    expect(dane.pozycje).toEqual([{
      name: 'STOP 70x100', quantity: 2, gross_price: 12300, tax_symbol: '23',
    }]);
    expect(dane.podsumowanieVat.at(-1)).toMatchObject({
      suma: true, nettoGr: 10000, vatGr: 2300, bruttoGr: 12300,
    });
    expect(dane.doZaplatyGr).toBe(12300);
    expect(dane.slownie).toBe('sto dwadzieścia trzy złote');
  });

  // Koszt dostawy jest ZWYKLA POZYCJA dokumentu — dokladnie tak, jak na fakturze VAT.
  // Bez niej proforma prosilaby o przelew nizszy niz kwota zamowienia.
  it('koszt dostawy wchodzi na dokument jako osobna pozycja', () => {
    const { id, proforma, budujPdf } = zPodgladem({ kwota_brutto: '143.00', koszt_dostawy_brutto: '20.00' });
    proforma.wystaw(id);
    const dane = budujPdf.mock.calls[0][0];
    expect(dane.pozycje.map((p) => p.gross_price)).toEqual([12300, 2000]);
    expect(dane.doZaplatyGr).toBe(14300);
  });
});

// ⚠️ Konfiguracja dokumentu. Testy sa TUTAJ, a nie w config.test.js, bo opisuja proforme —
// razem z jedyna rzecza, ktorej w tym bloku byc NIE MOZE (adresem sprzedawcy).
describe('konfiguracja proformy', () => {
  const bazowe = { OMS_AUTH_USER: 'adam', OMS_AUTH_PASS: 'x' };

  it('NIP, rachunek i bank mają wartości produkcyjne, gdy nikt ich nie podał', () => {
    expect(loadOmsConfig({ ...bazowe }).proforma).toMatchObject({
      nip: '1234563218', rachunek: '34109010140000000000000000', bank: 'Millennium',
    });
  });

  it('zmienne środowiskowe podmieniają NIP, rachunek i bank', () => {
    // Wyjątek zatwierdzony przez właściciela 2026-09-30: poprawny jawny fixture przy rzeczywistej walidacji NIP/NRB.
    const c = loadOmsConfig({
      ...bazowe, OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_BANK: 'Inny',
    });
    expect(c.proforma).toMatchObject({ nip: '1234563218', rachunek: '34109010140000000000000000', bank: 'Inny' });
  });

  // ⚠️ BDO dolozony 12.08.2026 (Zadanie 6, specyfikacja zamowienia): art. 63 ustawy o odpadach
  // wymaga numeru rejestrowego na dokumentach, a do tego dnia panel go nigdzie nie trzymal.
  // Ta sama zasada, co przy NIP-ie: wartosc jawna (stoi na kazdej fakturze), wiec domyslna
  // produkcyjna, a zmienna sluzy do PODMIANY, nie do wlaczania sekcji.
  it('BDO ma wartość produkcyjną, gdy nikt jej nie podał', () => {
    expect(loadOmsConfig({ ...bazowe }).proforma).toMatchObject({ bdo: '000123456' });
  });

  it('zmienna środowiskowa podmienia BDO', () => {
    const c = loadOmsConfig({ ...bazowe, OMS_SPRZEDAWCA_BDO: '000999999' });
    expect(c.proforma).toMatchObject({ bdo: '000999999' });
  });

  // ⚠️ Katalog MUSI dac sie wskazac na WOLUMEN (`/data-oms/proformy`), tak jak katalog
  // etykiet i plik bazy. Pomylka tej klasy (`DB_PATH` zamiast `OMS_DB_PATH`) skasowalaby
  // przy Etapie 1 numery listow przy pierwszym odtworzeniu kontenera.
  it('katalog na pliki bierze się z OMS_PROFORMY_KATALOG', () => {
    expect(loadOmsConfig({ ...bazowe, OMS_PROFORMY_KATALOG: '/data-oms/proformy' }).proforma.katalog)
      .toBe('/data-oms/proformy');
  });

  // ⚠️ WARTOSC DOMYSLNA MUSI LEZEC NA WOLUMENIE. Kontener chodzi z `read_only: true`
  // (deploy/nas/compose.yaml), wiec `/var/lib/panel/...` to rootfs — katalogu nie da sie
  // tam zalozyc ANI RAZU. Domyslna wartosc, ktora w produkcji nie moze zadzialac, jest
  // gorsza od braku domyslnej: udaje, ze konfiguracja jest kompletna. Wolumen jest ten sam,
  // na ktorym siedza baza (`OMS_DB_PATH`) i etykiety (`OMS_ETYKIETY_DIR`).
  it('domyślny katalog leży na wolumenie, a nie na rootfs kontenera', () => {
    expect(loadOmsConfig({ ...bazowe }).proforma.katalog).toBe('/data-oms/proformy');
  });

  // ⚠️ ADRES SPRZEDAWCY MA JEDNO ZRODLO — `config.nadawca`. Drugi zestaw zmiennych na ten sam
  // adres to dokladnie awaria z lipca 2026: nieprefiksowane `NADAWCA_*` z pustymi domyslnymi
  // przeslonily zwalidowany adres i kazda paczka jechala z pusta ulica.
  it('blok proformy NIE niesie adresu sprzedawcy — ten ma jedno źródło', () => {
    const c = loadOmsConfig({ ...bazowe, OMS_SPRZEDAWCA_ULICA: 'Podstawiona 1', OMS_SPRZEDAWCA_NAZWA: 'Ktoś inny' });
    expect(Object.keys(c.proforma).sort()).toEqual(['bank', 'bdo', 'katalog', 'nip', 'rachunek']);
  });
});

// ⚠️ Zadanie 7 — DWIE TRASY, ktore spinaja usluge z karta zamowienia:
// POST /zamowienia/:id/proforma (wystawienie) i GET /proformy/:id/pdf (pobranie).
// Testy tutaj, a nie w karta-wyglad.test.js, bo dotycza SERWERA HTTP (kody statusu,
// naglowki, ochrona CSRF), nie samego wygladu HTML-a karty.
describe('proforma — trasy HTTP', () => {
  const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };

  // `zestaw` (wyzej) buduje usluge, ale bez `config.auth` — dokladamy je tu, bo
  // buildOmsServer wymaga go do Basic Auth, a services/proforma.js go nie potrzebuje.
  async function zestawHttp(nad = {}) {
    const { db, id, config, proforma } = zestaw(nad);
    const app = buildOmsServer({ db, config: { ...config, auth: { user: 'adam', pass: 'x' } }, proforma });
    await app.ready();
    return {
      db, id, app, proforma,
    };
  }

  it('POST /zamowienia/:id/proforma wystawia proformę i przekierowuje na kartę', async () => {
    const { app, id, db } = await zestawHttp();
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/proforma`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/zamowienia/${id}`);
    expect(proformyZamowienia(db, id)).toHaveLength(1);
    expect(proformyZamowienia(db, id)[0].numer).toBe('PF/1/08/2026');
  });

  it('GET /proformy/:id/pdf oddaje bajty zaczynające się od %PDF, z Content-Type application/pdf', async () => {
    const { app, id, proforma } = await zestawHttp();
    const p = proforma.wystaw(id);
    const r = await app.inject({ method: 'GET', url: `/proformy/${p.id}/pdf`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  // Odmowa operatorska (zamowienie anulowane, tu przez `czyWolnoWystawic`) ma wracac jako
  // KOMUNIKAT DO CZYTANIA — ta sama zasada, co przy trasie faktury (komunikatDlaOperatora).
  it('odmowa operatorska wraca jako czytelny komunikat, nie jako 500', async () => {
    const { app, id } = await zestawHttp({ anulowane: 1 });
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/proforma`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/anulowane/i);
  });

  it('POST do nieistniejącego zamówienia → 404', async () => {
    const { app } = await zestawHttp();
    const r = await app.inject({ method: 'POST', url: '/zamowienia/999999/proforma', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });

  // ⚠️ OCHRONA CSRF JEST GLOBALNA (security/csrf.js), ale plan wymaga TESTU, nie zalozenia
  // — dokladnie ta sama zasada co w tests/security/csrf-integracja.test.js.
  describe('ochrona CSRF na obu nowych trasach', () => {
    it('POST /zamowienia/:id/proforma z obcej strony kończy się 403', async () => {
      const { app, id } = await zestawHttp();
      const r = await app.inject({
        method: 'POST',
        url: `/zamowienia/${id}/proforma`,
        headers: { authorization: naglowek.authorization, origin: 'https://obcy.example' },
      });
      expect(r.statusCode).toBe(403);
    });

    it('POST /zamowienia/:id/proforma z własnej strony przechodzi przez ochronę', async () => {
      const { app, id } = await zestawHttp();
      const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/proforma`, headers: naglowek });
      expect(r.statusCode).not.toBe(403);
    });

    // GET jest metoda BEZPIECZNA (security/csrf.js: METODY_BEZPIECZNE) — pobranie PDF-a
    // ma dzialac takze z linku otwartego skads indziej (np. z historii przegladarki).
    it('GET /proformy/:id/pdf z obcej strony NIE jest blokowany (metoda bezpieczna)', async () => {
      const { app, id, proforma } = await zestawHttp();
      const p = proforma.wystaw(id);
      const r = await app.inject({
        method: 'GET',
        url: `/proformy/${p.id}/pdf`,
        headers: { authorization: naglowek.authorization, origin: 'https://obcy.example' },
      });
      expect(r.statusCode).not.toBe(403);
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createNadanie, PACZKA_DOMYSLNA } from '../../../src/moduly/wysylka/services/nadanie.js';
import { wyliczStatus, doZrobienia } from '../../../src/domena/status.js';

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1301, numer: '1301', klient: { email: 'j@k.pl', phone: '+48500600700' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '212.90',
  status_woo: 'processing', oplacone_at: '2026-07-29T13:00:00', anulowane: 0,
  utworzone_at: '2026-07-29T13:19:52', pozycje: [], ...nad,
});

// Prawdziwy numer listu DPD to np. '1000000000001U' — 14 znaków ZAKOŃCZONYCH LITERĄ,
// nie czysta liczba. Atrapy w tym pliku celowo używają takiego formatu, żeby żaden
// test nie utrwalił błędnego założenia "numer listu = cyfry".
const NUMER_LISTU = '1000000000001U';
const NUMER_LISTU_2 = '1048069488099X';

const logi = (db, akcja) => db.prepare('SELECT * FROM log WHERE akcja = ?').all(akcja);

function zestaw({ dpdNadaj, wooOk = true, wooNotatka, katalogEtykiet } = {}) {
  const db = openOmsDb(':memory:');
  const dpd = { nadaj: dpdNadaj ?? vi.fn().mockResolvedValue({ numerListu: NUMER_LISTU, etykietaPdf: Buffer.from('%PDF-x'), surowa: '<xml/>' }) };
  const padl = () => vi.fn().mockRejectedValue(new Error('sklep padł'));
  const woo = {
    dodajNotatke: wooNotatka ?? (wooOk ? vi.fn().mockResolvedValue({}) : padl()),
    // `ustawStatus` MUSI zostac w atrapie, mimo ze nadanie go juz nie wywoluje: chcemy
    // sprawdzac BRAK wywolania asercja (`not.toHaveBeenCalled`), a nie brakiem metody —
    // ktora ukrylaby ewentualny powrot tego kodu za TypeError zlapany gdzies indziej.
    ustawStatus: vi.fn().mockResolvedValue({}),
  };
  const katalog = katalogEtykiet ?? mkdtempSync(join(tmpdir(), 'oms-'));
  return { db, dpd, woo, katalogEtykiet: katalog, nadanie: createNadanie({ db, kurierzy: { dpd }, klienci: { pro: woo }, katalogEtykiet: katalog }) };
}

describe('nadanie', () => {
  // Ustalenie z recenzji: test sprawdzal tylko, ze `etykieta_sciezka` jest NIEPUSTYM
  // STRINGIEM — usuniecie writeFileSync przechodzilo na zielono, bo pliku nikt nie czytal.
  // Teraz plik musi istniec i naprawde byc PDF-em.
  it('zapisuje numer listu i etykietę, status przesyłki = nadana', async () => {
    const { db, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    expect(await nadanie.nadaj(id)).toEqual({ numerListu: NUMER_LISTU });
    const z = pobierzZamowienie(db, id);
    expect(z.przesylki[0].status).toBe('nadana');
    expect(z.przesylki[0].numer_listu).toBe(NUMER_LISTU);
    expect(z.przesylki[0].etykieta_sciezka).toBeTruthy();
    expect(existsSync(z.przesylki[0].etykieta_sciezka)).toBe(true);
    expect(readFileSync(z.przesylki[0].etykieta_sciezka).subarray(0, 4).toString()).toBe('%PDF');
  });

  // ZAMIENNIK WYRZUCONEJ ETYKIETY (04.09.2026, decyzja właściciela po zamówieniu 1385).
  // Decyzja operatora MUSI dojechać do kuriera — bez niej koperta wyjedzie bez <cod>
  // i kurier nie zainkasuje ani złotówki.
  it('przekazuje kurierowi decyzję o pobraniu na paczce nr 2', async () => {
    const { db, dpd, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane({ kwota_pobrania: '212.90' }), {});
    await nadanie.nadaj(id);
    dpd.nadaj.mockResolvedValue({ numerListu: NUMER_LISTU_2, etykietaPdf: Buffer.from('%PDF-x'), surowa: '<xml/>' });
    await nadanie.nadaj(id, PACZKA_DOMYSLNA, { kolejnosc: 2, pobranieNaTejPaczce: true, kwotaPobrania: '123.00' });
    expect(dpd.nadaj.mock.calls[1][0]).toMatchObject({ kolejnosc: 2, pobranieNaTejPaczce: true });
  });

  // ⚠️ PIENIĄDZE W LOGU. Kolumna `kwota_pobrania` odpowiedzi nie da (poller nadpisuje ją
  // ze sklepu co dwie minuty, a nadpisanie z ekranu i tak się do niej nie zapisuje), więc
  // log jest JEDYNYM miejscem, w którym po miesiącu widać, że pobranie pojechało na paczce
  // nr 2 i że stała za tym decyzja człowieka, a nie pomyłka.
  it('zapisuje w logu, że pobranie pojechało na paczce nr 2 z decyzji człowieka', async () => {
    const { db, dpd, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane({ kwota_pobrania: '212.90' }), {});
    await nadanie.nadaj(id);
    dpd.nadaj.mockResolvedValue({ numerListu: NUMER_LISTU_2, etykietaPdf: Buffer.from('%PDF-x'), surowa: '<xml/>' });
    await nadanie.nadaj(id, PACZKA_DOMYSLNA, { kolejnosc: 2, pobranieNaTejPaczce: true, kwotaPobrania: '123.00' });
    const wpisy = logi(db, 'nadanie.pobranie').map((l) => l.wynik).join(' | ');
    expect(wpisy).toMatch(/Ręcznie( \(|:)/);
    expect(wpisy).toMatch(/paczce nr 2/);
    expect(wpisy).toMatch(/123\.00/);
  });

  // Zwykła dosyłka niczego takiego nie zapisuje — inaczej wpis „decyzja człowieka" pojawiałby
  // się przy każdej drugiej paczce i przestałby cokolwiek znaczyć.
  it('zwykła dosyłka bez pobrania nie zostawia wpisu o decyzji', async () => {
    const { db, dpd, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane({ kwota_pobrania: '212.90' }), {});
    await nadanie.nadaj(id);
    dpd.nadaj.mockResolvedValue({ numerListu: NUMER_LISTU_2, etykietaPdf: Buffer.from('%PDF-x'), surowa: '<xml/>' });
    await nadanie.nadaj(id, PACZKA_DOMYSLNA, { kolejnosc: 2 });
    expect(logi(db, 'nadanie.pobranie').map((l) => l.wynik).join(' | ')).not.toMatch(/Ręcznie( \(|:)/);
  });

  // Ustalenie z recenzji: usuniecie WSZYSTKICH wywolan dopiszLog zostawialo suite zielona.
  it('zapisuje numer listu w logu zamówienia', async () => {
    const { db, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id);
    expect(logi(db, 'nadanie').map((w) => w.wynik)).toEqual([NUMER_LISTU]);
    expect(logi(db, 'sync-woo').map((w) => w.wynik)).toEqual(['OK']);
  });

  // Najdrozszy blad w calym module: drugi list przewozowy to realny koszt.
  it('drugie nadanie NIE tworzy drugiej przesyłki', async () => {
    const { db, dpd, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id);
    await expect(nadanie.nadaj(id)).rejects.toThrow(/już nadan/i);
    expect(dpd.nadaj).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) c FROM przesylki').get().c).toBe(1);
  });

  it('dwa równoległe nadania → jeden list przewozowy', async () => {
    const { db, dpd, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const wyniki = await Promise.allSettled([nadanie.nadaj(id), nadanie.nadaj(id)]);
    expect(wyniki.filter((w) => w.status === 'fulfilled')).toHaveLength(1);
    expect(dpd.nadaj).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) c FROM przesylki').get().c).toBe(1);
  });

  // Decyzja wlasciciela (patrz opis w nadanie.js): nadanie odsyla notatke z numerem listu,
  // ale NIE zmienia statusu zamowienia w sklepie — to ma robic sam sklep.
  it('odsyła numer listu do sklepu notatką, ale NIE zmienia statusu zamówienia', async () => {
    const { db, woo, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id);
    expect(woo.dodajNotatke).toHaveBeenCalledWith(1301, expect.stringContaining(NUMER_LISTU));
    expect(woo.ustawStatus).not.toHaveBeenCalled();
  });

  // Paczka fizycznie istnieje — cofniecie nadania byloby klamstwem.
  it('awaria sklepu NIE wycofuje nadania', async () => {
    const { db, nadanie } = zestaw({ wooOk: false });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id);
    const z = pobierzZamowienie(db, id);
    expect(z.przesylki[0].status).toBe('nadana');
    expect(z.przesylki[0].numer_listu).toBe(NUMER_LISTU);
  });

  // Ustalenie z recenzji: test wyzej przechodzil takze wtedy, gdy o awarii sklepu nie
  // zostawal ZADEN slad. Fakt nieudanej synchronizacji musi byc zapisany i widoczny.
  it('awaria sklepu zostawia ślad w logu i widoczny przy przesyłce', async () => {
    const { db, nadanie } = zestaw({ wooOk: false });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id);
    expect(logi(db, 'sync-woo').map((w) => w.wynik)).toEqual([expect.stringContaining('sklep padł')]);
    expect(pobierzZamowienie(db, id).przesylki[0].sync_woo_blad).toContain('sklep padł');
  });

  it('awaria DPD zostawia przesyłkę w stanie błędu i pozwala ponowić', async () => {
    const dpdNadaj = vi.fn()
      .mockRejectedValueOnce(new Error('DPD odrzuciło żądanie: Zly FID'))
      .mockResolvedValueOnce({ numerListu: NUMER_LISTU_2, etykietaPdf: Buffer.from('%PDF-x'), surowa: '<xml/>' });
    const { db, nadanie } = zestaw({ dpdNadaj });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await expect(nadanie.nadaj(id)).rejects.toThrow(/Zly FID/);
    expect(pobierzZamowienie(db, id).przesylki).toEqual([]);
    // Ustalenie z recenzji: bez tej asercji `oznaczBlad(..., '')` przechodzilo na zielono,
    // a powod awarii ginal — wiersz 'blad' bez opisu nie mowi operatorowi nic.
    const wiersz = db.prepare("SELECT * FROM przesylki WHERE status = 'blad'").get();
    expect(wiersz.blad_opis).toContain('Zly FID');
    expect(logi(db, 'nadanie').map((w) => w.wynik)).toContainEqual(expect.stringContaining('Zly FID'));
    await nadanie.nadaj(id);
    expect(pobierzZamowienie(db, id).przesylki[0].numer_listu).toBe(NUMER_LISTU_2);
  });

  it('nieznana metoda wysyłki → odmowa przed dotknięciem DPD', async () => {
    const { db, dpd, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane({ metoda_wysylki: 'nieznana' }), {});
    await expect(nadanie.nadaj(id)).rejects.toThrow(/nie jest obsługiwana/);
    expect(dpd.nadaj).not.toHaveBeenCalled();
  });

  it('zapisuje surową odpowiedź DPD', async () => {
    const { db, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id);
    expect(pobierzZamowienie(db, id).przesylki[0].odpowiedz_surowa).toBe('<xml/>');
  });

  // Wymiary domyslne wygladaja nietypowo (110x75x1 cm), ale sa poprawne: firma wysyla
  // PLASKIE paczki wielkoformatowe, nie kartony. Ta stala jest jedynym zrodlem
  // prawdy — ekran nadania (GET /zamowienia/:id/nadaj) ma nia wypelniac formularz.
  it('PACZKA_DOMYSLNA ma wartości podane przez właściciela: 1 kg / 110×75×1 cm', () => {
    expect(PACZKA_DOMYSLNA).toEqual({ waga: 1, dlugosc: 110, szerokosc: 75, wysokosc: 1 });
  });

  it('nadaj() bez jawnie podanej paczki przekazuje kurierowi PACZKA_DOMYSLNA', async () => {
    const { db, dpd, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id);
    expect(dpd.nadaj).toHaveBeenCalledWith(expect.objectContaining({ paczka: PACZKA_DOMYSLNA }));
  });

  // Ekran nadania czyta domyslne wagi/wymiary STAD, nie z drugiej, zdublowanej stalej.
  it('createNadanie() wystawia paczkaDomyslna na zewnątrz — ta sama stała co PACZKA_DOMYSLNA', () => {
    const { nadanie } = zestaw();
    expect(nadanie.paczkaDomyslna).toBe(PACZKA_DOMYSLNA);
  });

  it('jawnie podana paczka NIE jest podmieniana na domyślną', async () => {
    const { db, dpd, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const inna = { waga: 3.5, dlugosc: 20, szerokosc: 15, wysokosc: 10 };
    await nadanie.nadaj(id, inna);
    expect(dpd.nadaj).toHaveBeenCalledWith(expect.objectContaining({ paczka: inna }));
  });
});

// Zadanie „adres edytowalny": operator może poprawić adres odbiorcy na ekranie nadania
// PRZED zatwierdzeniem — nadanie.nadaj() musi ten adres (1) przekazać klientowi kuriera
// WPROST (patrz dpd.test.js — dpd.js nie ma prawa przeliczać go ponownie z zamówienia)
// i (2) zapisać przy przesyłce, żeby panel wiedział, dokąd paczka NAPRAWDĘ pojechała,
// nawet gdy różni się od adresu w zamówieniu ze sklepu (Woo).
describe('nadanie — adres odbiorcy przekazany z formularza', () => {
  const ADRES = {
    nazwa: 'Jan Kowalski-Po-Poprawce', company: 'Jan Kowalski-Po-Poprawce',
    ulica: 'Polna 1/5', kod: '00-650', miasto: 'Pęki', kraj: 'PL',
    phone: '+48500600700', email: 'j@k.pl',
  };

  it('adres podany w opcjach trafia do klienta kuriera WPROST, nie przeliczony na nowo', async () => {
    const { db, dpd, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id, undefined, { adres: ADRES });
    expect(dpd.nadaj).toHaveBeenCalledWith(expect.objectContaining({ adres: ADRES }));
  });

  // ⚠️ MUTACJA OBOWIĄZKOWA z briefu: „adres użyty przy nadaniu nie zapisuje się przy
  // przesyłce" musi zaczerwienić ten test.
  it('adres użyty PRZY UDANYM nadaniu zapisuje się przy przesyłce (JSON)', async () => {
    const { db, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id, undefined, { adres: ADRES });
    const p = pobierzZamowienie(db, id).przesylki[0];
    expect(p.adres_uzyty).toBeTruthy();
    expect(JSON.parse(p.adres_uzyty)).toEqual(ADRES);
  });

  // Wywołanie bez jawnego adresu (spoza ekranu nadania) NIE MA prawa zostawić kolumny
  // pustą — bez tego panel nie wiedziałby, co poszło do DPD, dokładnie tak samo jak przy
  // adresie z formularza. Fallback jest ten sam, co w dpd.js: adresOdbiorcy(zamówienie).
  it('brak jawnego adresu → zapisuje się fallback (adresOdbiorcy zamówienia), nie NULL', async () => {
    const { db, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id);
    const p = pobierzZamowienie(db, id).przesylki[0];
    expect(p.adres_uzyty).toBeTruthy();
    expect(JSON.parse(p.adres_uzyty).ulica).toBe('Polna 1');
  });
});

// Zadanie „adres edytowalny", punkt C: `powod` zmienia nazwę na `komentarz` i jest dostępny
// przy KAŻDYM nadaniu (dawniej wyłącznie przy paczce nr > 1) — dalej nieobowiązkowy, dalej
// trafia do logu zamówienia, NIGDY do DPD (to notatka dla ludzi w panelu, nie dana kuriera).
describe('nadanie — komentarz (dawny „powód")', () => {
  // ⚠️ MUTACJA OBOWIĄZKOWA z briefu: „komentarz nie trafia do logu" musi zaczerwienić ten test.
  it('komentarz przy PIERWSZEJ paczce trafia do logu zamówienia', async () => {
    const { db, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id, undefined, { komentarz: 'klient prosił o kartonik z watą' });
    const wpisy = db.prepare('SELECT * FROM log WHERE zamowienie_id = ?').all(id);
    expect(wpisy.some((w) => w.wynik.includes('klient prosił o kartonik z watą'))).toBe(true);
  });

  it('komentarz NIGDY nie trafia do DPD — to notatka dla ludzi w panelu, nie dana kuriera', async () => {
    const { db, dpd, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id, undefined, { komentarz: 'TAJNY-KOMENTARZ-OPERATORA' });
    const wywolanie = dpd.nadaj.mock.calls[0][0];
    expect(JSON.stringify(wywolanie)).not.toContain('TAJNY-KOMENTARZ-OPERATORA');
  });

  it('brak komentarza przy pierwszej paczce → BRAK dodatkowego wpisu w logu (bez szumu)', async () => {
    const { db, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id);
    const wpisy = db.prepare('SELECT * FROM log WHERE zamowienie_id = ?').all(id);
    expect(wpisy.some((w) => w.akcja.startsWith('nadanie.komentarz'))).toBe(false);
  });
});

// C1 (recenzja calej galezi). Zamowienie RECZNE nie istnieje w sklepie — jego `zrodlo_id`
// to tylko pozycja we WLASNEJ serii numeracji (patrz zamowienia-reczne.js), nie identyfikator
// zadnego zamowienia Woo. Notatka wyslana pod ten numer trafialaby w zamowienie sklepowe
// o przypadkowo tym samym `zrodlo_id` (albo w nic) — obcy sklep dostawalby CUDZA notatke,
// a przesylka w panelu wisiala z bledem synchronizacji, ktory nic prawdziwego nie opisuje.
describe('nadanie — zamówienie ręczne (sklep = "reczne")', () => {
  it('NIE woła sklepu — zrodlo_id ręcznego zamówienia nie jest niczyim zamówieniem w Woo', async () => {
    const { db, woo, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    await nadanie.nadaj(id);
    expect(woo.dodajNotatke).not.toHaveBeenCalled();
  });

  // Pominiecie ma zostac WIDOCZNYM faktem, nie cichym `if`em — inaczej operator patrzacy
  // na log zamowienia nie odrozni „pominieto swiadomie" od „nikt o tym nie pomyslal".
  it('zostawia w logu ślad, że notatka do sklepu została świadomie pominięta', async () => {
    const { db, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    await nadanie.nadaj(id);
    expect(logi(db, 'sync-woo').map((w) => w.wynik)).toEqual([expect.stringContaining('POMINIĘTO')]);
  });

  // Sedno findingu: przed poprawka nadanie i tak wolalo woo.dodajNotatke, ktore rzucalo
  // (zamowienie nie istnieje w Woo) i ladowalo jako blad synchronizacji na przesylce —
  // mimo ze samo nadanie sie udawalo. Po poprawce przesylka ma zostac CZYSTA.
  it('nadanie się udaje i przesyłka NIE dostaje błędu synchronizacji', async () => {
    const { db, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    await expect(nadanie.nadaj(id)).resolves.toEqual({ numerListu: NUMER_LISTU });
    const p = pobierzZamowienie(db, id).przesylki[0];
    expect(p.status).toBe('nadana');
    expect(p.sync_woo_blad).toBeNull();
  });
});

// C1. Klient moze anulowac dokladnie wtedy, gdy operator ma karte otwarta. Bez odmowy
// w nadaj() paczka fizycznie by wyjechala, a Woo nie dostaloby ZADNEGO sygnalu — nadanie
// nie zmienia statusu zamowienia w sklepie (decyzja wlasciciela). Ukrycie przycisku to
// za malo — przycisk pokazuje stan sprzed sekund.
describe('nadanie — zamówienie anulowane', () => {
  it('anulowane zamówienie → twarda odmowa PRZED dotknięciem DPD', async () => {
    const { db, dpd, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane({ anulowane: 1 }), {});
    await expect(nadanie.nadaj(id)).rejects.toThrow(/anulowane/i);
    expect(dpd.nadaj).not.toHaveBeenCalled();
  });

  it('anulowane zamówienie nie zostawia wiersza przesyłki ani nie rusza sklepu', async () => {
    const { db, woo, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane({ anulowane: 1 }), {});
    await nadanie.nadaj(id).catch(() => {});
    expect(db.prepare('SELECT COUNT(*) c FROM przesylki').get().c).toBe(0);
    expect(woo.ustawStatus).not.toHaveBeenCalled();
  });

  // Decyzja projektowa: braku oplaty NIE blokujemy (B2B, wysylka na fakture z terminem).
  it('nieopłacone zamówienie nadal wolno nadać — blokujemy WYŁĄCZNIE anulowanie', async () => {
    const { db, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane({ oplacone_at: null }), {});
    await expect(nadanie.nadaj(id)).resolves.toEqual({ numerListu: NUMER_LISTU });
  });
});

// I2. DPD odrzuca powtorzona referencje (DUPLICATED_PARCEL_SEARCH_KEY), wiec numer listu
// raz przydzielony MUSI trafic do bazy — drugiej szansy nie bedzie.
describe('nadanie — awaria PO przydzieleniu numeru listu', () => {
  const poNumerze = () => {
    const e = new Error('DPD nie wystawiło etykiety: NOT_FOUND');
    e.numerListu = NUMER_LISTU;
    e.surowa = '<Waybill>1000000000001U</Waybill>';
    return vi.fn().mockRejectedValue(e);
  };

  it('zapisuje numer listu i surową odpowiedź, status = do_wyjasnienia', async () => {
    const { db, nadanie } = zestaw({ dpdNadaj: poNumerze() });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await expect(nadanie.nadaj(id)).rejects.toThrow(/etykiet/i);
    const p = pobierzZamowienie(db, id).przesylki[0];
    expect(p.status).toBe('do_wyjasnienia');
    expect(p.numer_listu).toBe(NUMER_LISTU);
    expect(p.odpowiedz_surowa).toContain('1000000000001U');
    expect(p.blad_opis).toContain('NOT_FOUND');
  });

  it('NIE zwalnia indeksu — ponowienia być nie może, DPD i tak odrzuci tę referencję', async () => {
    const { db, dpd, nadanie } = zestaw({ dpdNadaj: poNumerze() });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id).catch(() => {});
    await expect(nadanie.nadaj(id)).rejects.toThrow(/do wyjaśnienia/i);
    expect(dpd.nadaj).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) c FROM przesylki').get().c).toBe(1);
  });

  // Rozroznienie obu klas awarii jest calym sensem poprawki: gdyby awaria po numerze
  // ladowala w statusie 'blad', numer bylby niewidoczny (indeks filtruje `<> 'blad'`)
  // i zwolnilby miejsce na ponowienie, ktore DPD i tak odrzuci.
  it('awaria PRZED numerem daje „blad”, awaria PO numerze daje „do_wyjasnienia”', async () => {
    const { db: db1, nadanie: n1 } = zestaw({ dpdNadaj: vi.fn().mockRejectedValue(new Error('Zly FID')) });
    const id1 = zapiszZamowienie(db1, 'pro', zmapowane(), {});
    await n1.nadaj(id1).catch(() => {});
    expect(db1.prepare('SELECT status FROM przesylki').get().status).toBe('blad');

    const { db: db2, nadanie: n2 } = zestaw({ dpdNadaj: poNumerze() });
    const id2 = zapiszZamowienie(db2, 'pro', zmapowane(), {});
    await n2.nadaj(id2).catch(() => {});
    expect(db2.prepare('SELECT status FROM przesylki').get().status).toBe('do_wyjasnienia');
  });

  it('zamówienie „do wyjaśnienia” NIE liczy się jako wysłane i zostaje na liście roboczej', async () => {
    const { db, nadanie } = zestaw({ dpdNadaj: poNumerze() });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id).catch(() => {});
    const z = pobierzZamowienie(db, id);
    expect(wyliczStatus(z)).not.toBe('wyslane');
    expect(doZrobienia(z)).toBe(true);
  });

  // ⚠️ MUTACJA OBOWIĄZKOWA z briefu (zgłoszenie poprzedniego wykonawcy): DPD przydzieliło
  // numer, więc paczka u kuriera FIZYCZNIE ISTNIEJE i pojechała pod adres użyty w TYM
  // wywołaniu — operator mógł go poprawić na ekranie nadania tuż przed kliknięciem, a adres
  // w zamówieniu ze sklepu od tej chwili może być już inny. Bez zapisu tutaj panel nigdy
  // już by się nie dowiedział, dokąd ta konkretna paczka pojechała.
  it('adres użyty PRZY NADANIU DO WYJAŚNIENIA też się zapisuje przy przesyłce (JSON)', async () => {
    const ADRES = {
      nazwa: 'Jan Kowalski-Po-Poprawce', company: 'Jan Kowalski-Po-Poprawce',
      ulica: 'Polna 1/5', kod: '00-650', miasto: 'Pęki', kraj: 'PL',
      phone: '+48500600700', email: 'j@k.pl',
    };
    const { db, nadanie } = zestaw({ dpdNadaj: poNumerze() });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id, undefined, { adres: ADRES }).catch(() => {});
    const p = pobierzZamowienie(db, id).przesylki[0];
    expect(p.status).toBe('do_wyjasnienia');
    expect(p.adres_uzyty).toBeTruthy();
    expect(JSON.parse(p.adres_uzyty)).toEqual(ADRES);
  });
});

// I3 i I4. Zapis etykiety nie moze ani zakleszczyc zamowienia, ani wyjsc poza katalog.
describe('nadanie — plik etykiety', () => {
  it('nieistniejący katalog etykiet jest zakładany przy budowie usługi', async () => {
    const katalogEtykiet = join(mkdtempSync(join(tmpdir(), 'oms-')), 'etykiety', 'głębiej');
    const { db, nadanie } = zestaw({ katalogEtykiet });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id);
    const p = pobierzZamowienie(db, id).przesylki[0];
    expect(p.status).toBe('nadana');
    expect(existsSync(p.etykieta_sciezka)).toBe(true);
  });

  // Nawet gdy zapis pliku padnie, przesylka MUSI zostac dokonczona: numer listu jest
  // cenniejszy niz PDF (PDF da sie pobrac z panelu DPD, numeru — nie). Wiersz 'w_trakcie'
  // bez numeru blokowalby indeks na zawsze; wyjsciem bylby reczny UPDATE w SQLite.
  it('awaria zapisu pliku NIE zakleszcza zamówienia — numer listu i tak trafia do bazy', async () => {
    const { db, nadanie, katalogEtykiet } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    // Nazwa pliku, ktorej system plikow nie przyjmie: katalog o tej samej nazwie.
    mkdirSync(join(katalogEtykiet, `1301-${NUMER_LISTU}.pdf`), { recursive: true });
    await expect(nadanie.nadaj(id)).resolves.toEqual({ numerListu: NUMER_LISTU });
    const p = pobierzZamowienie(db, id).przesylki[0];
    expect(p.status).toBe('nadana');
    expect(p.numer_listu).toBe(NUMER_LISTU);
    expect(p.etykieta_sciezka).toBeNull();
    expect(logi(db, 'etykieta').map((w) => w.wynik)).toEqual([expect.stringContaining('BŁĄD zapisu')]);
  });

  // I4: `numer` pochodzi WPROST z Woo, a polskie wtyczki numeracji wstawiaja ukosniki
  // („1301/07/2026"). Bez oczyszczenia plik ladowal poza katalogiem etykiet, a sciezka
  // trafiala do bazy i byla serwowana przez GET /etykieta.
  it.each([
    ['../ucieczka', 'wyjście katalog wyżej'],
    ['1301/07/2026', 'polski format numeracji z ukośnikami'],
    ['..\\..\\ucieczka', 'ukośniki wsteczne (Windows)'],
  ])('numer zamówienia %j (%s) nie wyprowadza pliku poza katalog etykiet', async (numer) => {
    const { db, nadanie, katalogEtykiet } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane({ numer }), {});
    await nadanie.nadaj(id);
    const sciezka = pobierzZamowienie(db, id).przesylki[0].etykieta_sciezka;
    expect(sciezka.startsWith(katalogEtykiet + sep)).toBe(true);
    expect(sciezka.slice(katalogEtykiet.length + 1)).not.toMatch(/[\\/]|\.\./);
    // Plik naprawde lezy w katalogu etykiet, a nie obok niego.
    expect(readdirSync(katalogEtykiet)).toHaveLength(1);
    expect(existsSync(sciezka)).toBe(true);
  });
});

// Zadanie „kolejka druku": etykieta ZPL obok PDF-a. Pobrana PRZY NADANIU (nie przy druku),
// żeby powtórny wydruk nie wymagał kolejnej rozmowy z DPD — zapisana na dysk TAK SAMO
// odpornie jak PDF (patrz opis wyżej), bo w tym momencie numer listu już istnieje.
describe('nadanie — etykieta ZPL (kolejka druku)', () => {
  const zNadajZpl = (etykietaZpl = Buffer.from('^XA^XZ'), zplBladOpis = null) => vi.fn().mockResolvedValue({
    numerListu: NUMER_LISTU, etykietaPdf: Buffer.from('%PDF-x'), etykietaZpl, zplBladOpis, surowa: '<xml/>',
  });

  it('zapisuje plik ZPL obok PDF-a i ścieżkę w etykieta_zpl_sciezka', async () => {
    const { db, nadanie } = zestaw({ dpdNadaj: zNadajZpl() });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id);
    const p = pobierzZamowienie(db, id).przesylki[0];
    expect(p.etykieta_zpl_sciezka).toBeTruthy();
    expect(existsSync(p.etykieta_zpl_sciezka)).toBe(true);
    expect(readFileSync(p.etykieta_zpl_sciezka).toString()).toBe('^XA^XZ');
    // Nie ta sama ścieżka co PDF — inne rozszerzenie, żeby dwa pliki nie nadpisały się nawzajem.
    expect(p.etykieta_zpl_sciezka).not.toBe(p.etykieta_sciezka);
  });

  // MUTACJA OBOWIĄZKOWA z briefu: „błąd pobrania ZPL wywala nadanie" — dpd.js już nie
  // rzuca (patrz dpd.test.js), ale ten test dowodzi tego na poziomie CAŁEGO nadania:
  // gdy DPD nie oddało ZPL-a (etykietaZpl: null), nadanie MA SIĘ UDAĆ.
  it('brak ZPL-a od DPD NIE wywala nadania — status „nadana", numer listu zapisany', async () => {
    const { db, nadanie } = zestaw({ dpdNadaj: zNadajZpl(null, 'DPD nie wystawiło etykiety ZPL: NOT_FOUND') });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await expect(nadanie.nadaj(id)).resolves.toEqual({ numerListu: NUMER_LISTU });
    const p = pobierzZamowienie(db, id).przesylki[0];
    expect(p.status).toBe('nadana');
    expect(p.numer_listu).toBe(NUMER_LISTU);
    expect(p.etykieta_zpl_sciezka).toBeNull();
    // PDF zostaje nietknięty — brak ZPL-a nie ma prawa zabrać PDF-a operatorowi.
    expect(existsSync(p.etykieta_sciezka)).toBe(true);
  });

  it('brak ZPL-a od DPD zostawia ślad w logu z powodem — operator ma wiedzieć DLACZEGO', async () => {
    const { db, nadanie } = zestaw({ dpdNadaj: zNadajZpl(null, 'DPD nie wystawiło etykiety ZPL: NOT_FOUND') });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id);
    expect(logi(db, 'etykieta-zpl').map((w) => w.wynik)).toEqual([expect.stringContaining('NOT_FOUND')]);
  });

  // Ten sam wzorzec jak przy PDF: awaria zapisu pliku (nie awaria DPD) NIE MOŻE zakleszczyć
  // zamówienia — numer listu jest cenniejszy niż plik.
  it('awaria zapisu pliku ZPL NIE zakleszcza zamówienia — reszta nadania kończy się normalnie', async () => {
    const { db, nadanie, katalogEtykiet } = zestaw({ dpdNadaj: zNadajZpl() });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    // Nazwa pliku, ktorej system plikow nie przyjmie: katalog o tej samej nazwie.
    mkdirSync(join(katalogEtykiet, `1301-${NUMER_LISTU}.zpl`), { recursive: true });
    await expect(nadanie.nadaj(id)).resolves.toEqual({ numerListu: NUMER_LISTU });
    const p = pobierzZamowienie(db, id).przesylki[0];
    expect(p.status).toBe('nadana');
    expect(p.etykieta_zpl_sciezka).toBeNull();
    // PDF zapisał się bez przeszkód.
    expect(existsSync(p.etykieta_sciezka)).toBe(true);
    expect(logi(db, 'etykieta-zpl').map((w) => w.wynik)).toEqual([expect.stringContaining('BŁĄD zapisu')]);
  });
});

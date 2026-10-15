import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { wolnoWyslacDoAllegro, nazwaPlikuFaktury, statusWeryfikacji } from '../../../src/domena/allegro-faktura.js';
import { createFakturaAllegro } from '../../../src/moduly/faktury/services/faktura-allegro.js';
import { MAKS_ROZMIAR_FAKTURY_B } from '../../../src/oms/allegro/client.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const PDF = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(64)]);

function baza({
  sklep = 'allegro_szkicownia', chce = 1, ksefNumer = 'KS-1', invoiceId = null, wyslanaAt = null,
  utworzonaAt = '2026-08-05T10:00:00Z', zgloszenieAt = null, weryfikacja = null,
} = {}) {
  const db = openOmsDb(':memory:');
  // ⚠️ FIKSTURA Z PLANU NIE DAWALA SIE WYKONAC ANI RAZU. `zapiszZamowienie` wklada do INSERT-a
  // caly komplet kolumn, a brakujace pola trafiaja tam jako `undefined` — node:sqlite odmawia
  // wtedy zwiazania parametru (kolejno: 4 `klient_json`, 6 `metoda_wysylki`, dalej `status_woo`,
  // `oplacone_at`, `anulowane`). Ksztalt nizej jest tym, ktorego uzywaja pozostale testy kanalu.
  const id = zapiszZamowienie(db, sklep, {
    zrodlo_id: 'CF-1', numer: 'CF-1', kwota_brutto: '100.00', chce_fakture: chce, pozycje: [],
    klient: { first_name: 'Jan', email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
    metoda_wysylki: 'allegro_dpd', kwota_pobrania: null, nip: null, status_woo: null,
    oplacone_at: '2026-08-05T09:00:00', anulowane: 0, utworzone_at: '2026-08-05T08:00:00',
  }, {});
  db.prepare(`INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_numer, allegro_invoice_id,
    allegro_wyslana_at, allegro_zgloszenie_at, allegro_weryfikacja, utworzona_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, 'u1', '12/08/2026', ksefNumer, invoiceId, wyslanaAt, zgloszenieAt, weryfikacja, utworzonaAt);
  return { db, id };
}

const klientOk = (log = []) => ({
  pobierzFakturyZamowienia: async () => { log.push('lista'); return []; },
  zglosFakture: async (cf, dane) => { log.push(['zglos', cf, dane]); return { id: 'INV-1' }; },
  wyslijPlikFaktury: async (cf, inv, b) => { log.push(['plik', cf, inv, b.length]); return { file: { securityVerification: { status: 'WAITING' } } }; },
});

describe('nazwa pliku', () => {
  it('nie niesie ukośników z numeru faktury', () => {
    expect(nazwaPlikuFaktury('12/08/2026')).toBe('FV-12-08-2026.pdf');
  });
  it('bez numeru daje nazwę zastępczą, a nie „undefined.pdf"', () => {
    expect(nazwaPlikuFaktury(null)).toBe('faktura.pdf');
  });
});

// ⚠️ DWA MIEJSCA, BO DOKUMENTACJA ALLEGRO PODAJE DWA SPRZECZNE KSZTALTY (tutorial kontra
// allegro-api#4130). Czytanie jednego znaczyloby 50% szans, ze panel NIGDY nie zobaczy
// odrzucenia pliku przez antywirusa — czyli twierdzilby, ze kupujacy ma fakture, ktorej nie ma.
describe('statusWeryfikacji', () => {
  it('czyta kształt z tutorialu (file.securityVerification)', () => {
    expect(statusWeryfikacji({ file: { securityVerification: { status: 'ACCEPTED' } } })).toBe('ACCEPTED');
  });
  it('czyta kształt z ogłoszenia funkcji (na najwyższym poziomie wpisu)', () => {
    expect(statusWeryfikacji({ securityVerification: { status: 'REJECTED' } })).toBe('REJECTED');
  });
  it('brak pola i pustka dają null, a nie wyjątek', () => {
    expect(statusWeryfikacji({})).toBeNull();
    expect(statusWeryfikacji(null)).toBeNull();
  });
});

describe('wolnoWyslacDoAllegro', () => {
  // ⚠️ `utworzona_at` W FIKSTURZE JEST OBOWIAZKOWE OD PARTII 3 (W1). Prog doby dla furtki
  // „bez numeru KSeF" przeniosl sie z szablonu do tej bariery, wiec faktura BEZ daty
  // wystawienia nie jest juz reprezentatywnym wierszem — jest wierszem, ktorego panel nie
  // umie datowac, i furtka slusznie sie przy nim nie otwiera. Data sprzed dwoch dob opisuje
  // dokladnie ten przypadek, o ktory pytaja asercje nizej: fakture, ktora NAPRAWDE stanela.
  const DWIE_DOBY_TEMU = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const z = (n) => ({
    sklep: 'allegro_szkicownia',
    chce_fakture: 1,
    faktura: {
      numer: '1/2026', infakt_uuid: 'u', ksef_numer: 'KS', utworzona_at: DWIE_DOBY_TEMU, ...n,
    },
  });
  it('przepuszcza fakturę w KSeF', () => expect(wolnoWyslacDoAllegro(z({})).wolno).toBe(true));
  it('odmawia bez numeru KSeF', () => expect(wolnoWyslacDoAllegro(z({ ksef_numer: null })).powod).toMatch(/KSeF/));
  it('odmawia, gdy dokument już u kupującego jest', () => expect(wolnoWyslacDoAllegro(z({ allegro_wyslana_at: '2026-08-05T11:00:00Z' })).powod).toMatch(/już/i));
  it('odmawia, gdy kupujący o fakturę nie prosił', () => {
    expect(wolnoWyslacDoAllegro({ ...z({}), chce_fakture: 0 }).powod).toMatch(/nie prosił/);
  });
  it('odmawia zamówieniu ze sklepu', () => {
    expect(wolnoWyslacDoAllegro({ ...z({}), sklep: 'szkicownia' }).powod).toMatch(/Allegro/);
  });
  it('odmawia bez faktury', () => expect(wolnoWyslacDoAllegro({ sklep: 'allegro_szkicownia', chce_fakture: 1 }).wolno).toBe(false));

  // ⚠️⚠️ FURTKA „BEZ NUMERU KSEF" ZNIKNELA 01.09.2026 (decyzja właściciela: „fv ida zawsze z ksef").
  // Do tego dnia stal tu komplet testow opcji `bezKsef` — zdejmowala DOKLADNIE JEDNA odmowe
  // i otwierala sie po dobie czekania. Zostaje po niej jedno: reguła ma NIE MIEC zadnego
  // wytrychu, i to jest teraz asercja, a nie brak testu.
  it('nie ma zadnej opcji, ktora zdejmowalaby odmowe o KSeF', () => {
    const bezNumeru = z({ ksef_numer: null });
    expect(wolnoWyslacDoAllegro(bezNumeru).wolno).toBe(false);
    // Druga argumentem funkcja juz nie przyjmuje — a gdyby ktos ja przywrocil, ma NIE dzialac
    // po cichu na starym kluczu.
    expect(wolnoWyslacDoAllegro(bezNumeru, { bezKsef: true }).wolno).toBe(false);
    expect(wolnoWyslacDoAllegro(bezNumeru, { bezKsef: true }).powod).toMatch(/KSeF/);
  });

  // ---------------------------------------------------------------------------------
  // ⚠️⚠️ K2 (recenzja Partii 3): `REJECTED` BYL STANEM BEZ WYJSCIA, a karta przeczyla sama
  // sobie NA JEDNYM EKRANIE — pasek mowil „Allegro ODRZUCILO plik, kupujacy jej NIE MA,
  // wyslij go jeszcze raz", sekcja faktury obok: „kupujacy ma ja na swoim koncie", a obie
  // trasy odmawialy (400). Niezmiennik 4.9.
  //
  // Sedno: `allegro_wyslana_at` NIE JEST dowodem „dokument u kupujacego" — przy `REJECTED`
  // to nieprawda. A `REJECTED` jest JEDYNYM stanem, w ktorym ponowienie jest bezpieczne
  // i darmowe: `invoiceId` juz mamy, wiec `PUT .../file` PODMIENIA plik, bez drugiego POST-u.
  // ---------------------------------------------------------------------------------
  it('przy REJECTED przepuszcza ponowienie — bo kupujący dokumentu NIE MA', () => {
    const odrzucona = z({ allegro_wyslana_at: '2026-08-05T11:00:00Z', allegro_weryfikacja: 'REJECTED' });
    expect(wolnoWyslacDoAllegro(odrzucona).wolno).toBe(true);
  });

  // Druga polowa tej samej reguly: KAZDY inny stan weryfikacji dalej odmawia. Bez tej
  // asercji „poprawka" polegajaca na skasowaniu calego warunku przechodzilaby na zielono —
  // a to znaczyloby drugi dokument u kupujacego przy WAITING i przy ACCEPTED.
  it('ACCEPTED, WAITING i brak statusu dalej ODMAWIAJĄ', () => {
    for (const w of ['ACCEPTED', 'WAITING', null, undefined, 'COS_NOWEGO']) {
      const f = z({ allegro_wyslana_at: '2026-08-05T11:00:00Z', allegro_weryfikacja: w });
      expect(`${w}: ${wolnoWyslacDoAllegro(f).wolno}`).toBe(`${w}: false`);
    }
  });

  // ⚠️⚠️ KOMUNIKAT SKROCONY 01.09.2026 (zgloszenie właściciela) DO JEDNEGO ZDANIA — i to nie byla
  // sama kosmetyka. Zdanie „Wyślij ją do KSeF w inFakcie (panel tego nie robi)" bylo
  // NIEPRAWDA od czasu zakladki FAKTURY (panel wysyla do KSeF sam: POST /faktury/ksef/wyslij),
  // a trzecie zdanie kierowalo do przycisku, ktorego dzis nie ma. Odmowa ma mowic FAKT, a nie
  // odsylac poza panel do czynnosci, ktora panel ma dwie zakladki dalej.
  it('odmowa o KSeF to jedno zdanie o fakcie, bez odsyłania do inFaktu i do furtki', () => {
    const p = wolnoWyslacDoAllegro(z({ ksef_numer: null, numer: '3/09/2026' })).powod;
    expect(p).toBe('Faktura 3/09/2026 nie jest jeszcze w KSeF — a do kupującego ma iść dokument z numerem KSeF.');
    expect(p).not.toMatch(/inFak/i);
    expect(p).not.toMatch(/przycisk/i);
  });

  it('nie rzuca na pustce', () => {
    expect(wolnoWyslacDoAllegro(null).wolno).toBe(false);
    expect(wolnoWyslacDoAllegro({}).wolno).toBe(false);
  });
});

describe('wysłanie faktury do Allegro', () => {
  it('idzie dwoma krokami i zapisuje ślad', async () => {
    const { db, id } = baza();
    const log = [];
    const usluga = createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF },
      klienciKanalow: { allegro_szkicownia: klientOk(log) },
    });

    await usluga.wyslij(id);

    expect(log[1][0]).toBe('zglos');
    expect(log[2][0]).toBe('plik');
    const f = pobierzZamowienie(db, id).faktura;
    expect(f.allegro_invoice_id).toBe('INV-1');
    expect(f.allegro_wyslana_at).not.toBeNull();
    expect(f.allegro_weryfikacja).toBe('WAITING');
  });

  // ⚠️ NAZWA PLIKU JEST WIDOCZNA DLA KUPUJACEGO, a ukosnik z numeru faktury znaczy w niej
  // katalog. Regula nazywajaca plik jest czysta i ma wlasny test wyzej — ten sprawdza, ze
  // usluga naprawde jej UZYWA, a nie sklada nazwy u siebie.
  it('zgłasza fakturę pod nazwą BEZ ukośników i z numerem dokumentu', async () => {
    const { db, id } = baza();
    const log = [];
    const usluga = createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF },
      klienciKanalow: { allegro_szkicownia: klientOk(log) },
    });

    await usluga.wyslij(id);

    expect(log[1][2]).toEqual({ nazwaPliku: 'FV-12-08-2026.pdf', numerFaktury: '12/08/2026' });
    // ⚠️ Do Allegro idzie IDENTYFIKATOR ZAMOWIENIA W ALLEGRO (`zrodlo_id`), a nie nasze `id`.
    expect(log[1][1]).toBe('CF-1');
    expect(log[2][1]).toBe('CF-1');
  });

  // ⚠️ SEDNO: Allegro przyjmuje do 10 faktur na zamówienie, więc ponowiony POST NIE ODBIJE SIĘ
  // od niczego — u kupującego narosłyby duplikaty tego samego dokumentu. Identyfikator z POST-u
  // zapisujemy PRZED wysłaniem pliku i to on jest rezerwacją.
  it('zapisuje identyfikator PRZED wysłaniem pliku', async () => {
    const { db, id } = baza();
    const usluga = createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF },
      klienciKanalow: {
        allegro_szkicownia: {
          pobierzFakturyZamowienia: async () => [],
          zglosFakture: async () => ({ id: 'INV-7' }),
          wyslijPlikFaktury: async () => { throw new Error('sieć padła'); },
        },
      },
    });

    await expect(usluga.wyslij(id)).rejects.toThrow(/sieć padła/);
    expect(pobierzZamowienie(db, id).faktura.allegro_invoice_id).toBe('INV-7');
    expect(pobierzZamowienie(db, id).faktura.allegro_wyslana_at).toBeNull();
  });

  it('ponowienie NIE zgłasza drugiej faktury — dosyła plik do istniejącej', async () => {
    const { db, id } = baza({ invoiceId: 'INV-7' });
    const log = [];
    const usluga = createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF },
      klienciKanalow: {
        allegro_szkicownia: {
          pobierzFakturyZamowienia: async () => [{ id: 'INV-7', invoiceNumber: '12/08/2026' }],
          zglosFakture: async () => { log.push('ZGLOSZONO DRUGI RAZ'); return { id: 'INV-8' }; },
          wyslijPlikFaktury: async (cf, inv) => { log.push(['plik', inv]); return {}; },
        },
      },
    });

    await usluga.wyslij(id);

    expect(log).toEqual([['plik', 'INV-7']]);
  });

  // ⚠️ TO JEST OCHRONA, NA KTOREJ STOIMY (rozpoznanie 05.08.2026). Zdalna lista oddaje dzis
  // `400`, wiec klient zwraca pusta liste i tamta galaz MILCZY. Jedynym bezpiecznikiem zostaje
  // LOKALNA kolumna `allegro_invoice_id` — dlatego ma wlasny test, w ktorym lista jest pusta.
  it('z PUSTĄ listą z Allegro (dzisiejsze 400) i tak nie zgłasza drugiej faktury', async () => {
    const { db, id } = baza({ invoiceId: 'INV-7' });
    const log = [];
    const usluga = createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF },
      klienciKanalow: {
        allegro_szkicownia: {
          pobierzFakturyZamowienia: async () => [],
          zglosFakture: async () => { log.push('ZGLOSZONO DRUGI RAZ'); return { id: 'INV-8' }; },
          wyslijPlikFaktury: async (cf, inv) => { log.push(['plik', inv]); return {}; },
        },
      },
    });

    await usluga.wyslij(id);

    expect(log).toEqual([['plik', 'INV-7']]);
  });

  // ⚠️ Drugi bezpiecznik, PO STRONIE ALLEGRO: gdyby zapis identyfikatora nie doszedł (restart
  // procesu między POST-em a UPDATE-em), lokalna kolumna byłaby pusta i panel zgłosiłby drugą
  // fakturę. Lista z Allegro rozstrzyga to, czego nasza baza nie wie.
  it('adoptuje fakturę zgłoszoną wcześniej, choć baza o niej nie wie', async () => {
    const { db, id } = baza({ invoiceId: null });
    const log = [];
    const usluga = createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF },
      klienciKanalow: {
        allegro_szkicownia: {
          pobierzFakturyZamowienia: async () => [{ id: 'INV-9', invoiceNumber: '12/08/2026' }],
          zglosFakture: async () => { log.push('ZGLOSZONO DRUGI RAZ'); return { id: 'INV-X' }; },
          wyslijPlikFaktury: async (cf, inv) => { log.push(['plik', inv]); return {}; },
        },
      },
    });

    await usluga.wyslij(id);

    expect(log).toEqual([['plik', 'INV-9']]);
    expect(pobierzZamowienie(db, id).faktura.allegro_invoice_id).toBe('INV-9');
  });

  // ⚠️⚠️ BEZ NUMERU KSEF NIE MA JUZ ZADNEJ DROGI NA SILE (01.09.2026, decyzja właściciela).
  // Do tego dnia stala tu furtka `bezKsef` z progiem doby; dzis odmowa jest bezwarunkowa,
  // a wyjsciem jest wyslanie faktury do KSeF z zakladki FAKTURY. Test pilnuje takze tego,
  // ze odmowa pada PRZED pobraniem PDF-u — czyli przed pierwszym bajtem do inFaktu.
  it('bez numeru KSeF odmawia i NIE DA SIE tego obejsc opcja', async () => {
    const { db, id } = baza({ ksefNumer: null });
    const log = [];
    const pobierzPdf = vi.fn(async () => PDF);
    const usluga = createFakturaAllegro({
      db, infakt: { pobierzPdf }, klienciKanalow: { allegro_szkicownia: klientOk(log) },
    });
    await expect(usluga.wyslij(id)).rejects.toThrow(/KSeF/);
    // Stary klucz podany mimo wszystko ma byc BEZ ZNACZENIA, a nie cichym wytrychem.
    await expect(usluga.wyslij(id, { bezKsef: true })).rejects.toThrow(/KSeF/);
    expect(pobierzPdf).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  // ⚠️ ODMOWA MA WYPASC PRZED PIERWSZYM BAJTEM DO ALLEGRO. Bariera, ktora odmawia PO wyslaniu
  // pliku, jest zadna — dokument juz lezy u kupujacego.
  it('odmowa nie dotyka ani inFaktu, ani Allegro', async () => {
    const { db, id } = baza({ wyslanaAt: '2026-08-05T11:00:00Z' });
    const log = [];
    const pobierzPdf = vi.fn(async () => PDF);
    const usluga = createFakturaAllegro({
      db, infakt: { pobierzPdf }, klienciKanalow: { allegro_szkicownia: klientOk(log) },
    });
    await expect(usluga.wyslij(id)).rejects.toThrow(/już/i);
    expect(pobierzPdf).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  // ---------------------------------------------------------------------------------
  // ⚠️⚠️ K1 (recenzja Partii 3): DWA RÓWNOLEGŁE ŻĄDANIA DAWAŁY KUPUJĄCEMU DWA DOKUMENTY.
  // Zmierzone recenzentem: 2 POST-y, 2 PUT-y z plikiem, oba 302, zero ostrzeżeń, a baza
  // pamiętała tylko DRUGI identyfikator — o pierwszym dokumencie panel nie dowiedziałby się
  // NIGDY, bo `GET .../invoices` oddaje 400.
  //
  // Testy niżej mierzyły klik SEKWENCYJNY („drugie kliknięcie NIE wysyła niczego drugi raz")
  // i współbieżności NIE WIDZIAŁY: między barierą a POST-em stoją DWA `await`-y
  // (`infakt.pobierzPdf`, `klient.pobierzFakturyZamowienia`), a rezerwacja `allegro_invoice_id`
  // powstaje dopiero PO POST-cie. Wyzwalacze: dwuklik (przycisk to zwykły `<form method="post">`
  // bez `disabled`), dwie karty, back+resubmit oraz OBIE TRASY NARAZ (`/faktura-allegro`
  // i `/faktura-allegro-bez-ksef` nie znają się nawzajem — ale wołają TĘ SAMĄ usługę).
  // ---------------------------------------------------------------------------------
  it('dwa RÓWNOLEGŁE żądania zgłaszają fakturę DOKŁADNIE RAZ', async () => {
    const { db, id } = baza();
    const zgloszenia = [];
    const pliki = [];
    const usluga = createFakturaAllegro({
      db,
      // ⚠️ Prawdziwe zwolnienie pętli zdarzeń, a nie sam mikrotask: tak wygląda pobranie
      // PDF-u z inFaktu i to jest DOKŁADNIE to okno, w którym drugie żądanie wchodziło.
      infakt: { pobierzPdf: async () => { await new Promise((r) => { setTimeout(r, 5); }); return PDF; } },
      klienciKanalow: {
        allegro_szkicownia: {
          pobierzFakturyZamowienia: async () => [],
          zglosFakture: async () => { zgloszenia.push('POST'); return { id: `INV-${zgloszenia.length}` }; },
          wyslijPlikFaktury: async (cf, inv) => { pliki.push(inv); return {}; },
        },
      },
    });

    const wyniki = await Promise.allSettled([usluga.wyslij(id), usluga.wyslij(id)]);

    // SEDNO: jeden POST i jeden plik. Allegro przyjmuje do 10 faktur na zamówienie, więc
    // drugi POST NIE ODBIŁBY SIĘ od niczego po ich stronie.
    expect(zgloszenia).toHaveLength(1);
    expect(pliki).toHaveLength(1);

    // Drugie żądanie ma ODMÓWIĆ GŁOŚNO, a nie po cichu nic nie zrobić — operator, który
    // kliknął dwa razy, musi wiedzieć, że drugie kliknięcie nic nie wysłało.
    const odmowy = wyniki.filter((w) => w.status === 'rejected');
    expect(odmowy).toHaveLength(1);
    expect(odmowy[0].reason.message).toMatch(/trwa/i);
    expect(wyniki.filter((w) => w.status === 'fulfilled')).toHaveLength(1);
  });

  // ⚠️ ZAJĘCIE JEST DZIERŻAWĄ, NIE WIECZNYM ZAMKIEM (niezmiennik 4.9). Ponowienie PO
  // NIEUDANEJ próbie MUSI przejść — inaczej zerwana sieć przy pliku zostawiałaby zamówienie
  // w stanie bez wyjścia, a to jest DOKŁADNIE ta usterka, którą naprawiamy w K2.
  it('po nieudanej próbie ponowienie przechodzi (zajęcie nie jest wiecznym zamkiem)', async () => {
    const { db, id } = baza();
    let pierwszy = true;
    const pliki = [];
    const usluga = createFakturaAllegro({
      db,
      infakt: { pobierzPdf: async () => PDF },
      klienciKanalow: {
        allegro_szkicownia: {
          pobierzFakturyZamowienia: async () => [],
          zglosFakture: async () => ({ id: 'INV-7' }),
          wyslijPlikFaktury: async (cf, inv) => {
            if (pierwszy) { pierwszy = false; throw new Error('sieć padła'); }
            pliki.push(inv);
            return {};
          },
        },
      },
    });

    await expect(usluga.wyslij(id)).rejects.toThrow(/sieć padła/);
    await usluga.wyslij(id);

    expect(pliki).toEqual(['INV-7']);
  });

  // ⚠️ SIEROTA PO RESTARCIE PROCESU SAMA SIĘ ZDEJMUJE. Bez tego panel odpowiadałby „właśnie
  // trwa" NA ZAWSZE — ta sama pułapka, którą db/faktury.js opisuje przy stanie 'zawieszona'
  // („Odpowiedz »wlasnie trwa« byla tu wieczna: nic jej nigdy nie zdejmowalo").
  it('zajęcie sprzed progu jest sierotą po restarcie i NIE blokuje wysyłki', async () => {
    const stare = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { db, id } = baza({ zgloszenieAt: stare });
    const log = [];
    const usluga = createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF },
      klienciKanalow: { allegro_szkicownia: klientOk(log) },
    });

    await expect(usluga.wyslij(id)).resolves.toBeTruthy();
  });

  // Świeże zajęcie (inne żądanie NAPRAWDĘ trwa) blokuje — i to jest druga połowa tej samej
  // reguły. Bez niej test wyżej przechodziłby także przy barierze zdjętej na amen.
  it('ŚWIEŻE zajęcie blokuje i nie dotyka ani inFaktu, ani Allegro', async () => {
    const { db, id } = baza({ zgloszenieAt: new Date().toISOString() });
    const log = [];
    const pobierzPdf = vi.fn(async () => PDF);
    const usluga = createFakturaAllegro({
      db, infakt: { pobierzPdf }, klienciKanalow: { allegro_szkicownia: klientOk(log) },
    });

    await expect(usluga.wyslij(id)).rejects.toThrow(/trwa/i);
    expect(pobierzPdf).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  // ---------------------------------------------------------------------------------
  // ⚠️⚠️ W2 (recenzja Partii 3): WALIDACJA PDF-U STALA ZA NIEODWRACALNYM `POST`-em.
  // Kontrola `Buffer.isBuffer` / `%PDF` / rozmiar siedziala WYLACZNIE w `wyslijPlikFaktury`,
  // czyli PO `zglosFakture`. Zmierzone: gdy inFakt odda JSON bledu zamiast PDF-u, do Allegro
  // I TAK leci `POST` — spalony jeden z DZIESIECIU slotow, przy zamowieniu kupujacego wisi
  // zgloszenie faktury BEZ PLIKU, a karta dalej pokazuje zielony przycisk oddajacy w kolko
  // ten sam blad. Kontrola musi stac ZARAZ PO `pobierzPdf`, zanim cokolwiek wyjdzie do sieci.
  // ---------------------------------------------------------------------------------
  it('JSON błędu zamiast PDF-u NIE wychodzi do Allegro ani jednym żądaniem', async () => {
    const { db, id } = baza();
    const log = [];
    const usluga = createFakturaAllegro({
      db,
      // Dokladnie to, co oddaje inFakt przy bledzie: cialo, ktore nie jest PDF-em.
      infakt: { pobierzPdf: async () => Buffer.from('{"errors":["Nie ma takiej faktury"]}') },
      klienciKanalow: { allegro_szkicownia: klientOk(log) },
    });

    await expect(usluga.wyslij(id)).rejects.toThrow(/PDF/i);
    // ⚠️ ANI JEDNEGO WYWOLANIA — takze `pobierzFakturyZamowienia`. Zaden slot nie plonie,
    // przy zamowieniu kupujacego nie wisi zgloszenie bez pliku.
    expect(log).toEqual([]);
    expect(pobierzZamowienie(db, id).faktura.allegro_invoice_id).toBeNull();
  });

  it('coś, co w ogóle nie jest bajtami, też nie wychodzi do Allegro', async () => {
    const { db, id } = baza();
    const log = [];
    const usluga = createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => ({ errors: ['404'] }) },
      klienciKanalow: { allegro_szkicownia: klientOk(log) },
    });

    await expect(usluga.wyslij(id)).rejects.toThrow(/PDF/i);
    expect(log).toEqual([]);
  });

  it('plik ponad limit Allegro odpada PRZED zgłoszeniem faktury', async () => {
    const { db, id } = baza();
    const log = [];
    const zaDuzy = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(MAKS_ROZMIAR_FAKTURY_B)]);
    const usluga = createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => zaDuzy },
      klienciKanalow: { allegro_szkicownia: klientOk(log) },
    });

    await expect(usluga.wyslij(id)).rejects.toThrow(/2 MB/);
    expect(log).toEqual([]);
  });

  // ⚠️ ODMOWA MA ZOSTAWIC ZAMOWIENIE ZDOLNE DO PONOWIENIA. Dzierzawa z K1 jest zwalniana
  // w `finally`, wiec poprawiony dokument da sie wyslac od razu, bez czekania na prog.
  it('po odmowie na PDF-ie kolejna próba z dobrym plikiem przechodzi', async () => {
    const { db, id } = baza();
    let zepsuty = true;
    const log = [];
    const usluga = createFakturaAllegro({
      db,
      infakt: { pobierzPdf: async () => (zepsuty ? Buffer.from('{"errors":[]}') : PDF) },
      klienciKanalow: { allegro_szkicownia: klientOk(log) },
    });

    await expect(usluga.wyslij(id)).rejects.toThrow(/PDF/i);
    zepsuty = false;
    await expect(usluga.wyslij(id)).resolves.toBeTruthy();
  });

  it('kanał bez podpiętego klienta odmawia czytelnie, zamiast wywalić się na undefined', async () => {
    const { db, id } = baza();
    const usluga = createFakturaAllegro({ db, infakt: { pobierzPdf: async () => PDF }, klienciKanalow: {} });
    await expect(usluga.wyslij(id)).rejects.toThrow(/allegro_szkicownia/);
  });
});

// ---------------------------------------------------------------------------------
// ⚠️ TESTY NA POZIOMIE TRASY (HTTP). W tym projekcie bramka w domenie TRZY RAZY okazala
// sie martwa, bo trasa gubila argument albo w ogole nie wolala uslugi — a testy uslugi
// swiecily na zielono. Dlatego pomiar idzie CALA droga: POST → trasa → usluga → atrapa
// klienta Allegro → baza → HTML karty.
// ---------------------------------------------------------------------------------
describe('trasa POST /zamowienia/:id/faktura-allegro', () => {
  const config = { auth: { user: 'adam', pass: 'x' } };
  const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
  const poller = { stan: () => ({ ostatni_przebieg_at: '2026-08-05T12:00:00', ostatni_blad: null }) };

  const serwer = async (db, fakturaAllegro) => {
    const app = buildOmsServer({ db, config, poller, fakturaAllegro });
    await app.ready();
    return app;
  };

  it('wysyła fakturę TEGO zamówienia i zapisuje ślad w bazie', async () => {
    const { db, id } = baza();
    const log = [];
    const app = await serwer(db, createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF }, klienciKanalow: { allegro_szkicownia: klientOk(log) },
    }));

    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura-allegro`, headers: naglowek });

    expect(r.statusCode).toBe(302);
    // ⚠️ Identyfikator Z ADRESU musi dojsc do uslugi. Trasa gubiaca argument wyslalaby
    // fakture INNEGO zamowienia — albo, przy `undefined`, zadnego, i po cichu.
    expect(log[1][1]).toBe('CF-1');
    expect(pobierzZamowienie(db, id).faktura.allegro_invoice_id).toBe('INV-1');
    expect(pobierzZamowienie(db, id).faktura.allegro_wyslana_at).not.toBeNull();
  });

  // ⚠️ BRAMKA MA GRYZC TAKZE PRZEZ HTTP. Trasa, ktora nie wola uslugi (albo lapie jej blad
  // i przekierowuje), zamienialaby odmowe w cisze — a operator zobaczylby przekierowanie
  // i uznal, ze kupujacy fakture dostal.
  it('odmowa domeny wraca 400 z POWODEM i nie dotyka Allegro', async () => {
    const { db, id } = baza({ ksefNumer: null });
    const log = [];
    const app = await serwer(db, createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF }, klienciKanalow: { allegro_szkicownia: klientOk(log) },
    }));

    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura-allegro`, headers: naglowek });

    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/KSeF/);
    expect(log).toEqual([]);
    expect(pobierzZamowienie(db, id).faktura.allegro_wyslana_at).toBeNull();
  });

  // ⚠️ DRUGIE KLIKNIECIE TO DRUGI DOKUMENT U KUPUJACEGO. Bariera „juz wyslana" musi zadzialac
  // na poziomie ZADANIA HTTP, bo tam wlasnie klika czlowiek.
  it('drugie kliknięcie NIE wysyła niczego drugi raz', async () => {
    const { db, id } = baza();
    const log = [];
    const app = await serwer(db, createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF }, klienciKanalow: { allegro_szkicownia: klientOk(log) },
    }));

    await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura-allegro`, headers: naglowek });
    const drugi = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura-allegro`, headers: naglowek });

    expect(drugi.statusCode).toBe(400);
    // Pierwsze wyslanie zostawilo TRZY wpisy w logu atrapy (lista, zglos, plik) i tyle ma zostac.
    expect(log).toHaveLength(3);
  });

  it('bez skonfigurowanego kanału trasa mówi to wprost (503), a nie 500', async () => {
    const { db, id } = baza();
    const app = await serwer(db, null);
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura-allegro`, headers: naglowek });
    expect(r.statusCode).toBe(503);
  });

  it('nieistniejące zamówienie dostaje 404', async () => {
    const { db } = baza();
    const app = await serwer(db, createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF }, klienciKanalow: { allegro_szkicownia: klientOk() },
    }));
    const r = await app.inject({ method: 'POST', url: '/zamowienia/9999/faktura-allegro', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });

  // ⚠️ PRZYCISK POKAZUJE SIE WYLACZNIE WTEDY, GDY BRAMKA PRZEPUSZCZA, a gdy nie — karta ma
  // podac POWOD. Sam brak przycisku jest stanem bez wyjscia: operator nie wie, czego brakuje.
  it('karta pokazuje przycisk, gdy wolno', async () => {
    const { db, id } = baza();
    const app = await serwer(db, createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF }, klienciKanalow: { allegro_szkicownia: klientOk() },
    }));
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`/zamowienia/${id}/faktura-allegro`);
    expect(r.body).toMatch(/Wyślij fakturę do Allegro/);
  });

  it('karta bez numeru KSeF pokazuje POWÓD zamiast przycisku', async () => {
    const { db, id } = baza({ ksefNumer: null });
    const app = await serwer(db, createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF }, klienciKanalow: { allegro_szkicownia: klientOk() },
    }));
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toMatch(/Wyślij fakturę do Allegro/);
    expect(r.body).toMatch(/nie jest jeszcze w KSeF/);
  });

  it('karta po wysłaniu mówi, że dokument jest u kupującego, i nie kusi przyciskiem', async () => {
    const { db, id } = baza({ wyslanaAt: '2026-08-05T11:00:00Z' });
    const app = await serwer(db, createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF }, klienciKanalow: { allegro_szkicownia: klientOk() },
    }));
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toMatch(/Wyślij fakturę do Allegro/);
    expect(r.body).toMatch(/wysłana do Allegro/i);
  });

  // ---------------------------------------------------------------------------------
  // ⚠️⚠️ FURTKA „BEZ NUMERU KSEF" ZNIKNELA 01.09.2026 (decyzja właściciela: „fv ida zawsze
  // z ksef", a dokument bez numeru wysyla sie recznie z panelu Allegro albo „Wiadomosciami").
  // Do tego dnia stal tu komplet testow trasy `/faktura-allegro-bez-ksef` z progiem doby.
  // Zostaje po nich JEDNA asercja, i jest wazniejsza od tamtych: adresu ma NIE BYC. Trasa
  // usunieta z widoku, ale zostawiona w routerze, dalej wysylalaby dokument kupujacemu
  // — ze starej karty albo z `curl` — i nikt by tego nie zobaczyl.
  // ---------------------------------------------------------------------------------
  it('trasy „bez numeru KSeF" NIE MA — ani na karcie, ani w routerze', async () => {
    const { db, id } = baza({ ksefNumer: null, utworzonaAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
    const log = [];
    const app = await serwer(db, createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF }, klienciKanalow: { allegro_szkicownia: klientOk(log) },
    }));

    // Karta: ani przycisku, ani adresu — takze po dobie, kiedy furtka dawniej sie otwierala.
    const karta = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(karta.body).not.toMatch(/BEZ numeru KSeF/);
    expect(karta.body).not.toContain('faktura-allegro-bez-ksef');
    // …i sam komunikat odmowy, ktory zostal: jedno zdanie o fakcie.
    expect(karta.body).toMatch(/nie jest jeszcze w KSeF/);

    // Router: adres ma oddac 404, a nie wyslac dokument.
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/faktura-allegro-bez-ksef`, headers: naglowek,
    });
    expect(r.statusCode).toBe(404);
    expect(log).toEqual([]);
    expect(pobierzZamowienie(db, id).faktura.allegro_wyslana_at).toBeNull();
  });

  // ---------------------------------------------------------------------------------
  // K2 na poziomie TRASY i KARTY. Trasa musi PRZEPUSCIC ponowienie po REJECTED, a karta
  // NIE MA PRAWA twierdzic obok paska, ze „kupujacy ma ją na swoim koncie".
  // ---------------------------------------------------------------------------------
  it('po REJECTED trasa PRZEPUSZCZA ponowienie i PODMIENIA plik, bez drugiego POST-u', async () => {
    const { db, id } = baza({
      wyslanaAt: '2026-08-05T11:00:00Z', weryfikacja: 'REJECTED', invoiceId: 'INV-7',
    });
    const log = [];
    const app = await serwer(db, createFakturaAllegro({
      db,
      infakt: { pobierzPdf: async () => PDF },
      klienciKanalow: {
        allegro_szkicownia: {
          pobierzFakturyZamowienia: async () => [],
          zglosFakture: async () => { log.push('ZGLOSZONO DRUGI RAZ'); return { id: 'INV-8' }; },
          wyslijPlikFaktury: async (cf, inv) => { log.push(['plik', inv]); return {}; },
        },
      },
    }));

    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura-allegro`, headers: naglowek });

    expect(r.statusCode).toBe(302);
    // ⚠️ SAM PUT, ANI JEDNEGO POST-u: ponowienie idzie sciezka ADOPCJI, wiec podmienia plik
    // przy TYM SAMYM zgloszeniu. Drugi POST bylby drugim dokumentem u kupujacego.
    expect(log).toEqual([['plik', 'INV-7']]);
  });

  it('karta przy REJECTED NIE twierdzi, że kupujący ma fakturę, i daje wyjście', async () => {
    const { db, id } = baza({
      wyslanaAt: '2026-08-05T11:00:00Z', weryfikacja: 'REJECTED', invoiceId: 'INV-7',
    });
    const app = await serwer(db, createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF }, klienciKanalow: { allegro_szkicownia: klientOk() },
    }));
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });

    expect(r.statusCode).toBe(200);
    // ⚠️ TO ZDANIE NIE MA PRAWA SIE POKAZAC przy REJECTED — pasek obok mowi coś dokładnie
    // odwrotnego, a operator czyta OBA na jednym ekranie.
    expect(r.body).not.toMatch(/kupujący ma ją na swoim koncie/);
    // Wyjscie ISTNIEJE: formularz ponowienia, ten sam, o ktory prosi pasek spraw.
    expect(r.body).toContain(`/zamowienia/${id}/faktura-allegro`);
    expect(r.body).toMatch(/ODRZUCIŁO/);
  });

  // ⚠️ ACCEPTED zostaje bez zmian — tam zdanie „kupujacy ma ja na swoim koncie" jest PRAWDA,
  // a przycisku byc NIE MOZE. Bez tej asercji poprawka K2 mogla by po cichu otworzyc
  // ponowienie przy KAZDEJ wyslanej fakturze.
  it('karta przy ACCEPTED dalej mówi, że dokument jest u kupującego, i NIE kusi przyciskiem', async () => {
    const { db, id } = baza({ wyslanaAt: '2026-08-05T11:00:00Z', weryfikacja: 'ACCEPTED' });
    const app = await serwer(db, createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF }, klienciKanalow: { allegro_szkicownia: klientOk() },
    }));
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });

    expect(r.body).toMatch(/kupujący ma ją na swoim koncie/);
    expect(r.body).not.toMatch(/Wyślij fakturę do Allegro/);
  });

  // Zamowienie ze SKLEPU nie ma dokad wyslac faktury — karta nie ma o tym mowic ani slowa,
  // bo „nie przyszlo z Allegro" przy kazdym zamowieniu sklepowym jest szumem, nie informacja.
  it('karta zamówienia ze sklepu w ogóle o Allegro nie wspomina', async () => {
    const { db, id } = baza({ sklep: 'szkicownia' });
    const app = await serwer(db, createFakturaAllegro({
      db, infakt: { pobierzPdf: async () => PDF }, klienciKanalow: { allegro_szkicownia: klientOk() },
    }));
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toMatch(/faktura-allegro/);
  });
});

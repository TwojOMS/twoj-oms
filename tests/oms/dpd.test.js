import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDpdClient, LIMIT_NADANIA_MS } from '../../src/oms/kurierzy/dpd.js';
import { PROG_ZAWIESZONEGO_NADANIA_MS } from '../../src/domena/przesylka-stan.js';
import { adresOdbiorcy } from '../../src/domena/adres-odbiorcy.js';

const __dir = dirname(fileURLToPath(import.meta.url));
// PRAWDZIWE odpowiedzi serwera DPD, zdobyte w Zadaniu 8 — nie wymyslone koperty.
const fixture = (n) => readFileSync(join(__dir, 'fixtures', 'dpd', n), 'utf8');

const odp = (status, tekst) => ({ status, ok: status >= 200 && status < 300, text: async () => tekst });

const zamowienie = {
  numer: '1301', kwota_brutto: '212.90', kwota_pobrania: null,
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  klient: { email: 'j@k.pl', phone: '+48500600700' },
};
const paczka = { waga: 1, dlugosc: 40, szerokosc: 30, wysokosc: 10 };
const nadawca = { nazwa: 'Lumina Marek Zywiecki', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL' };

// Fikstury (v4-ok.xml: <reference>99999999#TEST-OMS-...) pochodzą z Zadania 8, gdzie
// login w odpowiedzi serwera byl juz podmieniony na 99999999 — LOGIN tutaj MUSI sie z nim
// zgadzac, inaczej test "surowa bez poswiadczen" nie sprawdza niczego (login z configu
// nigdy nie wystapilby w fiksturze i "brak loginu w tekscie" bylby prawdziwy przez przypadek).
const LOGIN = '99999999';
const HASLO = 'SEKRETNE-HASLO';
const FID = '278216';

function klient(odpowiedzi, override = {}) {
  const fetchImpl = vi.fn();
  odpowiedzi.forEach((o) => fetchImpl.mockResolvedValueOnce(o));
  return {
    c: createDpdClient({ url: 'https://dpd/api', login: LOGIN, haslo: HASLO, fid: FID, nadawca, fetchImpl, ...override }),
    fetchImpl,
  };
}

// Trzy odpowiedzi: V10 (numer listu), V4 w PDF (etykieta „ludzka"), V4 w ZPL (etykieta dla
// Zebry — Zadanie „kolejka druku"). v4-ok-zpl.xml jest SKONSTRUOWANĄ fikstsurą (nie żywą
// odpowiedzią serwera jak pozostałe dwie): sesja ZPL nie była częścią przechwycenia z
// Zadania 8, ale kształt odpowiedzi (status/documentData) jest ten sam dla V4 niezależnie
// od formatu wyjściowego — potwierdzone w dpdservices.xsd.
const OK = () => [odp(200, fixture('v10-ok.xml')), odp(200, fixture('v4-ok.xml')), odp(200, fixture('v4-ok-zpl.xml'))];

describe('createDpdClient.nadaj', () => {
  it('oddaje numer listu i etykietę PDF', async () => {
    const { c } = klient(OK());
    const w = await c.nadaj({ zamowienie, paczka });
    // Numer listu KONCZY SIE LITERA — nie jest liczba, wiec /^\d+$/ by go odrzucilo.
    expect(w.numerListu).toBe('1000000000001U');
    expect(Buffer.isBuffer(w.etykietaPdf)).toBe(true);
    expect(w.etykietaPdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  // Zadanie „kolejka druku": obok PDF-a, drugie żądanie po tę samą etykietę w ZPL —
  // dla Zebry GK420t na komputerze produkcyjnym (patrz kurierzy/dpd.js i
  // deploy/drukarka/czuwacz-etykiet.ps1).
  // Druga polowa pary z dpd-status.test.js: tam status MUSI jechac na 5 s, tu nadanie MUSI
  // jechac na wlasnym, dluzszym limicie. Bez tego testu podmiana limitu w druga strone
  // przerywalaby zadanie etykiety po pieciu sekundach — przesylka u DPD juz by istniala.
  it('nadanie (V10 i obie etykiety V4) jedzie na LIMICIE NADANIA, nie na limicie statusu', async () => {
    const szpieg = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { c } = klient(OK());
      await c.nadaj({ zamowienie, paczka });
      expect(szpieg).toHaveBeenCalledTimes(3);
      expect(szpieg.mock.calls.map(([ms]) => ms)).toEqual([LIMIT_NADANIA_MS, LIMIT_NADANIA_MS, LIMIT_NADANIA_MS]);
    } finally {
      szpieg.mockRestore();
    }
  });

  it('oddaje TAKŻE etykietę w ZPL, obok PDF-a', async () => {
    const { c } = klient(OK());
    const w = await c.nadaj({ zamowienie, paczka });
    expect(Buffer.isBuffer(w.etykietaZpl)).toBe(true);
    expect(w.etykietaZpl.toString()).toContain('^XA');
  });

  // BEZWARTOSCIOWY PRZED POPRAWKA: '.toContain(\'<\')' przechodzi dla kazdego XML-a, wiec
  // usuniecie oczysc() przy budowaniu 'surowa' nie psulo tego testu — a to jest glowna
  // droga, ktora poswiadczenia moglyby trafic do bazy (fikstura V4 niesie referencje z
  // prefiksem loginu: '99999999#TEST-OMS-...').
  it('zwraca surową odpowiedź do zapisu w bazie, bez loginu w treści', async () => {
    const { c } = klient(OK());
    const { surowa } = await c.nadaj({ zamowienie, paczka });
    expect(surowa).toContain('<');
    expect(surowa).not.toContain(LOGIN);
    expect(surowa).toContain('***');
  });

  it('wysyła operacje V10 i V4, nie wersje bez numeru', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    expect(fetchImpl.mock.calls[0][1].body).toContain('generatePackagesNumbersV10');
    expect(fetchImpl.mock.calls[1][1].body).toContain('generateSpedLabelsV4');
  });

  // Recenzent zmutowal '<sessionId>${esc(sessionId)}</sessionId>' na stala 'MUTACJA-ZLY-ID'
  // i WSZYSTKIE 12 testow przeszlo — sessionId to jedyny lacznik miedzy V10 a V4. Bez niego
  // numer listu powstaje (i zostaje spalony po stronie DPD), a etykieta pada osobno.
  it('przekazuje SessionId z odpowiedzi V10 do żądania V4', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    expect(fetchImpl.mock.calls[1][1].body).toContain('<sessionId>1403466702</sessionId>');
  });

  // PULAPKA Z ZADANIA 8: '00-650' -> NONEXISTING_POSTAL_CODE, '00650' -> OK.
  // Woo oddaje kod Z MYSLNIKIEM, wiec bez tej normalizacji nadanie pada na kazdym zamowieniu.
  it('usuwa myślnik z kodu pocztowego odbiorcy i nadawcy', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    const body = fetchImpl.mock.calls[0][1].body;
    expect(body).toContain('<postalCode>00650</postalCode>');
    expect(body).not.toContain('00-650');
  });

  // Zamówienie 1275 z briefu: sklep na pro.szkicownia.pl rozbija adres na address_1 (ulica)
  // i address_2 (numer budynku) — patrz adres-odbiorcy.js. Koperta SOAP MUSI nieść oba
  // razem, bo to jest dokładnie to, co jedzie do kuriera: paczka na "Lipowa" bez numeru
  // 91 nie jest do doręczenia.
  it('adres odbiorcy z rozbitym address_1/address_2 (zamówienie 1275) niesie ulicę Z numerem', async () => {
    const { c, fetchImpl } = klient(OK());
    const zam = { ...zamowienie, dostawa: { ...zamowienie.dostawa, address_1: 'Lipowa', address_2: '91' } };
    await c.nadaj({ zamowienie: zam, paczka });
    const receiver = fetchImpl.mock.calls[0][1].body.match(/<receiver>[\s\S]*?<\/receiver>/)[0];
    expect(receiver).toContain('<address>Lipowa 91</address>');
  });

  it('podaje pełny adres nadawcy, nie sam fid', async () => {
    // Sam <fid> zwrocil 6 bledow walidacji na zywym API (fikstura v10-blad-walidacji.xml).
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    const sender = fetchImpl.mock.calls[0][1].body.match(/<sender>[\s\S]*?<\/sender>/)[0];
    for (const pole of ['company', 'address', 'city', 'postalCode', 'countryCode']) {
      expect(sender).toContain(`<${pole}>`);
    }
  });

  it('za pobraniem wysyła kwotę COD w kopercie', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie: { ...zamowienie, kwota_pobrania: '212.90' }, paczka });
    expect(fetchImpl.mock.calls[0][1].body).toContain('<cod><amount>212.90</amount><currency>PLN</currency></cod>');
  });

  it('przedpłata nie wysyła kwoty COD', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    expect(fetchImpl.mock.calls[0][1].body).not.toContain('<cod>');
  });

  // ZAMIENNIK PIERWSZEJ PACZKI (04.09.2026, decyzja właściciela po zdarzeniu na zamówieniu
  // 1385). Klient domówił towar telefonicznie PO wydrukowaniu etykiety, pierwsza etykieta
  // poszła do kosza i paczka nr 1 nigdy nie pojedzie — wygaśnie u DPD. Referencja zamiennika
  // MUSI dostać sufiks („1301/2"), bo gołą DPD już zna (DUPLICATED_PARCEL_SEARCH_KEY) — a
  // pobranie MUSI pojechać mimo numeru 2, inaczej kurier nie zainkasuje ani złotówki.
  it('paczka nr 2 z jawną decyzją operatora wysyła COD', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({
      zamowienie: { ...zamowienie, kwota_pobrania: '212.90' },
      paczka,
      kolejnosc: 2,
      pobranieNaTejPaczce: true,
    });
    expect(fetchImpl.mock.calls[0][1].body).toContain('<cod><amount>212.90</amount><currency>PLN</currency></cod>');
  });

  // ⚠️ BEZ jawnej decyzji zachowanie NIE ZMIENIA SIĘ ANI O JOTĘ — i to jest cała ochrona
  // przed zainkasowaniem pobrania DRUGI RAZ przy zwykłej dosyłce. Domyślnie pobranie jedzie
  // wyłącznie na paczce nr 1, dokładnie jak przed tą zmianą.
  it('paczka nr 2 bez decyzji operatora nadal nie wysyła COD', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie: { ...zamowienie, kwota_pobrania: '212.90' }, paczka, kolejnosc: 2 });
    expect(fetchImpl.mock.calls[0][1].body).not.toContain('<cod>');
  });

  // Decyzja operatora NIE JEST obejściem pozostałych strażników: kwota zerowa dalej nie
  // generuje <cod> (pobranie na zero złotych to nie jest pobranie).
  it('paczka nr 2 z decyzją operatora, ale kwotą „0.00” → bez <cod>', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({
      zamowienie: { ...zamowienie, kwota_pobrania: '0.00' },
      paczka,
      kolejnosc: 2,
      pobranieNaTejPaczce: true,
    });
    expect(fetchImpl.mock.calls[0][1].body).not.toContain('<cod>');
  });

  // HTTP 200 NIE OZNACZA SUKCESU — to najgrozniejsza pulapka tego API.
  it('HTTP 200 z błędem walidacji → wyjątek z powodem, nie cicha przesyłka bez numeru', async () => {
    const { c } = klient([odp(200, fixture('v10-blad-walidacji.xml'))]);
    await expect(c.nadaj({ zamowienie, paczka })).rejects.toThrow(/nadawcy/i);
  });

  // Ustalenie z recenzji: e.surowa nie mial ani jednego testu — refaktoryzacja, ktora by
  // to zgubila, zostawilaby suite zielona. Sprawdzamy co najmniej dwie sciezki throw.
  it('błąd walidacji V10 → e.surowa niesie pełną odpowiedź serwera', async () => {
    const { c } = klient([odp(200, fixture('v10-blad-walidacji.xml'))]);
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.surowa).toContain('NOT_PROCESSED');
    expect(blad.surowa).toContain('ERROR_SENDER_NAME_OR_COMPANY_REQUIRED');
  });

  it('błąd walidacji nie prosi o etykietę', async () => {
    const { c, fetchImpl } = klient([odp(200, fixture('v10-blad-walidacji.xml'))]);
    await c.nadaj({ zamowienie, paczka }).catch(() => {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // faultstring DPD niesie LOGIN ("Login failed for login: <login> ..."), a komunikat
  // trafia do bazy i do logu. Powod zachowujemy, poswiadczenia nie.
  it('błąd DPD niesie powód, ale bez loginu i hasła', async () => {
    // Uzywamy LOGIN ze stalej testowej (nie na sztywno "27821601"), zeby test faktycznie
    // sprawdzal maskowanie skonfigurowanego loginu, a nie przypadkowa niezgodnosc wartosci.
    const fault = `<soap:Fault><faultstring>Login failed for login: ${LOGIN} with status: INCORRECT_LOGIN_OR_PASSWORD</faultstring></soap:Fault>`;
    const { c } = klient([odp(500, fault)]);
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.message).toContain('INCORRECT_LOGIN_OR_PASSWORD');
    expect(blad.message).not.toContain(LOGIN);
    expect(blad.message).not.toContain(HASLO);
  });

  // Ustalenie z recenzji: DISALLOWED_FID / ERROR_NO_FID_PERMISSION / ACCESS_DENIED_FOR_FID
  // przenosza FID do komunikatu. '278216' jest dzis maskowany tylko PRZYPADKIEM, bo jest
  // prefiksem loginu '27821601' — przy loginie '99999999' ta przypadkowa oslona znika.
  it('błąd DPD maskuje też FID, nie tylko login i hasło', async () => {
    const fault = `<soap:Fault><faultstring>DISALLOWED_FID for masterFid: ${FID}</faultstring></soap:Fault>`;
    const { c } = klient([odp(500, fault)]);
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.message).toContain('DISALLOWED_FID');
    expect(blad.message).not.toContain(FID);
    expect(blad.message).toContain('***');
  });

  it('odpowiedź bez numeru listu → czytelny błąd, nie undefined', async () => {
    const { c } = klient([odp(200, '<soap:Envelope><soap:Body><return><Status>OK</Status></return></soap:Body></soap:Envelope>')]);
    await expect(c.nadaj({ zamowienie, paczka })).rejects.toThrow(/numer/i);
  });

  it('odpowiedź bez numeru listu → e.surowa niesie pełną odpowiedź serwera', async () => {
    const odpowiedz = '<soap:Envelope><soap:Body><return><Status>OK</Status></return></soap:Body></soap:Envelope>';
    const { c } = klient([odp(200, odpowiedz)]);
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.surowa).toContain('<Status>OK</Status>');
  });

  it('etykieta ze statusem innym niż OK → wyjątek, nie pusty PDF', async () => {
    const zly = fixture('v4-ok.xml').replace('<status>OK</status>', '<status>NOT_FOUND</status>');
    const { c } = klient([odp(200, fixture('v10-ok.xml')), odp(200, zly)]);
    await expect(c.nadaj({ zamowienie, paczka })).rejects.toThrow(/NOT_FOUND/);
  });

  it('etykieta ze statusem innym niż OK → e.surowa niesie odpowiedź V4', async () => {
    const zly = fixture('v4-ok.xml').replace('<status>OK</status>', '<status>NOT_FOUND</status>');
    const { c } = klient([odp(200, fixture('v10-ok.xml')), odp(200, zly)]);
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.surowa).toContain('NOT_FOUND');
  });

  it('etykieta bez documentData → wyjątek, i e.surowa niesie odpowiedź V4', async () => {
    const bezDanych = fixture('v4-ok.xml').replace(/<documentData>[\s\S]*?<\/documentData>/, '');
    const { c } = klient([odp(200, fixture('v10-ok.xml')), odp(200, bezDanych)]);
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.message).toMatch(/etykiet/i);
    expect(blad.surowa).toContain('1403466702'); // sessionId z fikstury V4
  });

  // Ustalenie z recenzji: kontrola statusu V10 patrzyla tylko na PIERWSZY <Status> w XML-u,
  // czyli status SESJI. Sesja moze byc OK, a konkretna PACZKA/PRZESYLKA — DUPLICATED_WAYBILL.
  // Budujemy odpowiedz w pamieci (nie nowa fikstura), zeby dokladnie odtworzyc ten scenariusz:
  // <return><Status>OK</Status>...<Package><Status>DUPLICATED_WAYBILL</Status>...
  it('sesja OK, ale paczka/przesyłka DUPLICATED_WAYBILL → wyjątek, nie zapis numeru', async () => {
    const sesjaOkPaczkaZla = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
      <soap:Body><ns2:generatePackagesNumbersV10Response xmlns:ns2="http://dpdservices.dpd.com.pl/">
        <return>
          <Status>OK</Status>
          <SessionId>1403466702</SessionId>
          <Packages><Package>
            <Status>DUPLICATED_WAYBILL</Status>
            <PackageId>1320765491</PackageId>
            <Reference>TEST-OMS-DUPLIKAT</Reference>
            <Parcels><Parcel>
              <Status>DUPLICATED_WAYBILL</Status>
              <ParcelId>1433053973</ParcelId>
              <Reference>TEST-OMS-DUPLIKAT</Reference>
              <Waybill>1000000000001U</Waybill>
            </Parcel></Parcels>
          </Package></Packages>
        </return>
      </ns2:generatePackagesNumbersV10Response></soap:Body></soap:Envelope>`;
    const { c, fetchImpl } = klient([odp(200, sesjaOkPaczkaZla)]);
    await expect(c.nadaj({ zamowienie, paczka })).rejects.toThrow(/DUPLICATED_WAYBILL/);
    // I nie idzie po etykietę do numeru, ktory DPD juz odrzucil.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Ustalenie z recenzji: 'zamowienie.kwota_pobrania' sprawdzane truthy → '0.00' (string!)
  // jest truthy i wygenerowaloby <cod><amount>0.00</amount></cod> — pobranie na zero zlotych.
  it('kwota pobrania „0.00” nie generuje elementu <cod> — to nie jest realne pobranie', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie: { ...zamowienie, kwota_pobrania: '0.00' }, paczka });
    expect(fetchImpl.mock.calls[0][1].body).not.toContain('<cod>');
  });

  // Ustalenie z recenzji: nieparsowalna kwota pobrania cicho gubiła <cod> — paczka jechała
  // jako przedpłacona, kurier nie inkasowałby, i nikt by się nie dowiedział. Zły kierunek
  // awarii: wartość nie do odczytania MUSI rzucać, nie po cichu pomijać COD.
  it.each([
    ['212,90 (przecinek dziesiętny)', '212,90'],
    ['212.90 zł (tekst z jednostką)', '212.90 zł'],
    ['1 234.56 (spacja jako separator)', '1 234.56'],
  ])('nieparsowalna kwota pobrania %s → rzuca czytelnym błędem, nie milczy', async (_opis, kwota) => {
    const { c, fetchImpl } = klient(OK());
    await expect(c.nadaj({ zamowienie: { ...zamowienie, kwota_pobrania: kwota }, paczka }))
      .rejects.toThrow(/pobrani/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('kwota pobrania z białymi znakami dookoła → przycięta, bez spacji w XML-u', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie: { ...zamowienie, kwota_pobrania: '  212.90  ' }, paczka });
    expect(fetchImpl.mock.calls[0][1].body).toContain('<cod><amount>212.90</amount><currency>PLN</currency></cod>');
  });

  // Ustalenie z recenzji: kodPocztowy() wycina wszystkie znaki nie-cyfrowe — brytyjski
  // 'SW1A 1AA' zostalby okaleczony do '11', a sessionType jest zaszyty na DOMESTIC.
  // Zamiast cicho nadac zle zaadresowana paczke, klient ma odmowic czytelnym wyjatkiem.
  it('kraj odbiorcy inny niż PL → czytelny wyjątek, nie nadanie z okaleczonym adresem', async () => {
    const { c, fetchImpl } = klient(OK());
    const zagraniczne = { ...zamowienie, dostawa: { ...zamowienie.dostawa, country: 'GB', postcode: 'SW1A 1AA' } };
    await expect(c.nadaj({ zamowienie: zagraniczne, paczka })).rejects.toThrow(/zagraniczne/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Ustalenie z recenzji: strażnik kraju mylił brak adresu z zagranicą. Zamówienie z pustym
  // blokiem `shipping` (admin, import) ma country="" i dostawało "przesyłki zagraniczne ()
  // nie są obsługiwane" — operator szukał problemu z zagranicą, ktorego nie bylo. Puste,
  // małe litery i otoczone spacjami MUSZĄ być traktowane jak 'PL', nie jak obcy kraj.
  it.each([
    ['', 'pusty string'],
    ['pl', 'małe litery'],
    [' PL', 'spacje wokół wielkich liter'],
  ])('country=%j (%s) → traktowany jak PL, nie jak zagranica', async (country) => {
    const { c, fetchImpl } = klient(OK());
    const zam = { ...zamowienie, dostawa: { ...zamowienie.dostawa, country } };
    await expect(c.nadaj({ zamowienie: zam, paczka })).resolves.toBeTruthy();
    const body = fetchImpl.mock.calls[0][1].body;
    const receiver = body.match(/<receiver>[\s\S]*?<\/receiver>/)[0];
    expect(receiver).toContain('<countryCode>PL</countryCode>');
  });

  // Ustalenie z recenzji + sprawdzone na zywym API: powtorzona referencja zwraca
  // Status=DUPLICATED_PARCEL_SEARCH_KEY, pusta <Packages/> i ANI JEDNEGO <Info>.
  // Klient sklejajacy wylacznie <Info> pokazywalby operatorowi pusty komunikat.
  it('powtórzona referencja (brak <Info>) → komunikat niesie sam Status, nie pustkę', async () => {
    const { c } = klient([odp(200, fixture('v10-duplikat.xml'))]);
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.message).toContain('DUPLICATED_PARCEL_SEARCH_KEY');
    expect(blad.surowa).toContain('DUPLICATED_PARCEL_SEARCH_KEY');
    // Numeru listu nie ma — DPD go NIE przydzielilo, wiec ponowienie jest dozwolone.
    expect(blad.numerListu).toBeUndefined();
  });

  it('błąd ze statusem I <Info> → komunikat niesie oba', async () => {
    const { c } = klient([odp(200, fixture('v10-blad-walidacji.xml'))]);
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.message).toContain('NOT_PROCESSED');
    expect(blad.message).toMatch(/nadawcy/i);
  });

  // Ustalenie z recenzji: awaria PO przydzieleniu numeru listu gubila numer, a `e.surowa`
  // niosla odpowiedz V4 — w ktorej <Waybill> W OGOLE NIE MA. Ponowienie z ta sama
  // referencja zostaloby przez DPD odrzucone, wiec numer przepadalby na zawsze.
  describe('awaria po przydzieleniu numeru listu', () => {
    const zlaEtykieta = () => fixture('v4-ok.xml').replace('<status>OK</status>', '<status>NOT_FOUND</status>');

    it('błąd etykiety niesie numer listu przydzielony przez DPD', async () => {
      const { c } = klient([odp(200, fixture('v10-ok.xml')), odp(200, zlaEtykieta())]);
      const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
      expect(blad.numerListu).toBe('1000000000001U');
    });

    it('e.surowa niesie odpowiedź V10 z <Waybill>, nie samo V4', async () => {
      const { c } = klient([odp(200, fixture('v10-ok.xml')), odp(200, zlaEtykieta())]);
      const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
      expect(blad.surowa).toContain('<Waybill>1000000000001U</Waybill>');
      expect(blad.surowa).toContain('NOT_FOUND');
      expect(blad.surowa).not.toContain(LOGIN);
    });

    it('awaria sieci przy etykiecie też niesie numer listu i odpowiedź V10', async () => {
      const { c, fetchImpl } = klient([odp(200, fixture('v10-ok.xml'))]);
      fetchImpl.mockRejectedValueOnce(new Error('ECONNRESET'));
      const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
      expect(blad.numerListu).toBe('1000000000001U');
      expect(blad.surowa).toContain('<Waybill>1000000000001U</Waybill>');
    });

    // Kontrola negatywna: awaria PRZED numerem nie ma prawa udawac, ze numer istnieje —
    // inaczej uslugi nie dalyby sie rozroznic i kazdy blad blokowalby ponowienie.
    it('awaria PRZED przydzieleniem numeru NIE niesie e.numerListu', async () => {
      const { c } = klient([odp(200, fixture('v10-blad-walidacji.xml'))]);
      const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
      expect(blad.numerListu).toBeUndefined();
    });
  });

  it('sieć nieosiągalna → komunikat oczyszczony z loginu', async () => {
    const { c, fetchImpl } = klient([]);
    fetchImpl.mockRejectedValueOnce(new Error(`ECONNREFUSED (login=${LOGIN})`));
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.message).toContain('DPD nieosiągalne');
    expect(blad.message).not.toContain(LOGIN);
  });
});

// ⚠️ MUTACJA OBOWIĄZKOWA z briefu „adres edytowalny": to jest NAJGROŹNIEJSZY MOŻLIWY BŁĄD
// w całym zadaniu. Od chwili, gdy adres na ekranie nadania stał się edytowalny, klient DPD
// MUSI użyć adresu PRZEKAZANEGO przez wołającego (services/nadanie.js, z formularza), a NIE
// przeliczyć go PONOWNIE z `zamowienie` (adresOdbiorcy(zamowienie)) — gdyby to zrobił, poprawka
// operatora byłaby POZORNA: ekran pokazałby jeden adres, a do kuriera pojechałby inny (stary).
//
// Test dowodzi tego wprost: `adres` przekazany do nadaj() celowo RÓŻNI SIĘ od tego, co
// adresOdbiorcy(zamowienie) obliczyłoby z tego samego `zamowienie` — i sprawdzamy, że w
// kopercie SOAP wylądował adres PRZEKAZANY, nie ten wyliczony z zamówienia.
describe('createDpdClient.nadaj — adres odbiorcy PRZEKAZANY, nie czytany ponownie z zamówienia', () => {
  it('adres przekazany jawnie RÓŻNI SIĘ od adresOdbiorcy(zamowienie) → w kopercie ląduje PRZEKAZANY', async () => {
    const { c, fetchImpl } = klient(OK());
    // Kontrola: adresOdbiorcy(zamowienie) dla tego `zamowienie` skłąda miasto 'Pęki' —
    // gdyby dpd.js czytał adres ponownie z zamówienia, w kopercie wylądowałoby 'Pęki',
    // NIE marker poniżej.
    expect(adresOdbiorcy(zamowienie).miasto).toBe('Pęki');
    const adresPoprawionyPrzezOperatora = {
      ...adresOdbiorcy(zamowienie),
      miasto: 'Miasto-Po-Poprawce-Operatora',
      ulica: 'Ulica-Po-Poprawce-Operatora',
    };
    await c.nadaj({ zamowienie, paczka, adres: adresPoprawionyPrzezOperatora });
    const receiver = fetchImpl.mock.calls[0][1].body.match(/<receiver>[\s\S]*?<\/receiver>/)[0];
    expect(receiver).toContain('Miasto-Po-Poprawce-Operatora');
    expect(receiver).toContain('Ulica-Po-Poprawce-Operatora');
    expect(receiver).not.toContain('>Pęki<');
  });

  it('brak przekazanego adresu (wywołanie spoza ekranu nadania) → fallback na adresOdbiorcy(zamowienie), nie awaria', async () => {
    // Fallback istnieje WYŁĄCZNIE dla wywołań spoza HTTP (np. bezpośrednich testów tego
    // klienta, jak reszta tego pliku) — jedyna prawdziwa droga do DPD (POST /nadaj przez
    // services/nadanie.js) ZAWSZE przekazuje adres jawnie, patrz nadanie.test.js.
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    const receiver = fetchImpl.mock.calls[0][1].body.match(/<receiver>[\s\S]*?<\/receiver>/)[0];
    expect(receiver).toContain('>Pęki<');
  });
});

// Zadanie „kolejka druku": drugie żądanie po etykietę w ZPL, obok już istniejącego PDF-a.
// W CHWILI tego żądania numer listu JUŻ ISTNIEJE po stronie DPD — awaria pobrania ZPL
// (sieć, zły status, brak documentData) NIE MOŻE więc wywalić nadania. Ta sama zasada
// obowiązuje już przy zapisie pliku PDF na dysk (services/nadanie.js).
describe('createDpdClient.nadaj — etykieta ZPL nie blokuje nadania', () => {
  it('wysyła ZPL w formacie etykiety — trzecie żądanie', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    expect(fetchImpl.mock.calls).toHaveLength(3);
    const cialoZpl = fetchImpl.mock.calls[2][1].body;
    expect(cialoZpl).toContain('<outputDocFormatV1>ZPL</outputDocFormatV1>');
    expect(cialoZpl).toContain('<outputDocPageFormatV1>LBL_PRINTER</outputDocPageFormatV1>');
    // ⚠️ PDF (drugie żądanie) idzie od 2026-07-31 w TYM SAMYM formacie strony: DPD w A4
    // wkleja etykietę w róg pustej kartki, więc na drukarce etykiet trzeba było ją
    // przycinać albo skalować. LBL_PRINTER daje PDF o rozmiarze samej etykiety.
    const cialoPdf = fetchImpl.mock.calls[1][1].body;
    expect(cialoPdf).toContain('<outputDocFormatV1>PDF</outputDocFormatV1>');
    expect(cialoPdf).toContain('<outputDocPageFormatV1>LBL_PRINTER</outputDocPageFormatV1>');
    expect(cialoPdf).not.toContain('<outputDocPageFormatV1>A4</outputDocPageFormatV1>');
  });

  // MUTACJA OBOWIĄZKOWA z briefu: „błąd pobrania ZPL wywala nadanie" musi zaczerwienić
  // ten test (i pokrewne niżej).
  it('awaria sieci przy ZPL → nadanie i tak się udaje, numerListu i PDF są', async () => {
    const { c, fetchImpl } = klient([odp(200, fixture('v10-ok.xml')), odp(200, fixture('v4-ok.xml'))]);
    fetchImpl.mockRejectedValueOnce(new Error('ECONNRESET'));
    const w = await c.nadaj({ zamowienie, paczka });
    expect(w.numerListu).toBe('1000000000001U');
    expect(Buffer.isBuffer(w.etykietaPdf)).toBe(true);
    expect(w.etykietaZpl).toBeNull();
  });

  it('ZPL ze statusem innym niż OK → nadanie się udaje, etykietaZpl jest null, powód zapisany', async () => {
    const zlyZpl = fixture('v4-ok-zpl.xml').replace('<status>OK</status>', '<status>NOT_FOUND</status>');
    const { c } = klient([odp(200, fixture('v10-ok.xml')), odp(200, fixture('v4-ok.xml')), odp(200, zlyZpl)]);
    const w = await c.nadaj({ zamowienie, paczka });
    expect(w.numerListu).toBe('1000000000001U');
    expect(w.etykietaZpl).toBeNull();
    expect(w.zplBladOpis).toMatch(/NOT_FOUND/);
  });

  it('ZPL bez documentData → nadanie się udaje, etykietaZpl jest null', async () => {
    const bezDanychZpl = fixture('v4-ok-zpl.xml').replace(/<documentData>[\s\S]*?<\/documentData>/, '');
    const { c } = klient([odp(200, fixture('v10-ok.xml')), odp(200, fixture('v4-ok.xml')), odp(200, bezDanychZpl)]);
    const w = await c.nadaj({ zamowienie, paczka });
    expect(w.numerListu).toBe('1000000000001U');
    expect(w.etykietaZpl).toBeNull();
    expect(w.zplBladOpis).toMatch(/etykiet/i);
  });

  // Powód awarii ZPL ma trafić do logu zamówienia (services/nadanie.js) — bez niego
  // operator widziałby tylko „brak ZPL", nie WIEDZIAŁBY dlaczego.
  it('powód awarii ZPL jest oczyszczony z poświadczeń, tak jak każdy inny komunikat DPD', async () => {
    const fault = '<soap:Fault><faultstring>Login failed for login: 99999999 with status: X</faultstring></soap:Fault>';
    const { c } = klient([odp(200, fixture('v10-ok.xml')), odp(200, fixture('v4-ok.xml')), odp(500, fault)]);
    const w = await c.nadaj({ zamowienie, paczka });
    expect(w.etykietaZpl).toBeNull();
    expect(w.zplBladOpis).not.toContain(LOGIN);
  });

  // Kontrola negatywna: awaria PDF (drugie żądanie) MUSI dalej wywalać nadanie — to
  // ta sama, już istniejąca zasada „awaria PO numerze listu → do_wyjaśnienia". Tylko
  // ZPL (trzecie żądanie) dostał nowe, wybaczające zachowanie.
  it('awaria PDF (drugie żądanie) nadal rzuca wyjątkiem — ZPL w ogóle nie jest proszony', async () => {
    const { c, fetchImpl } = klient([odp(200, fixture('v10-ok.xml'))]);
    fetchImpl.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(c.nadaj({ zamowienie, paczka })).rejects.toThrow(/nieosiągalne/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('createDpdClient — walidacja konfiguracji', () => {
  const pelnaKonfiguracja = { url: 'https://dpd/api', login: LOGIN, haslo: HASLO, fid: FID, nadawca, fetchImpl: vi.fn() };

  // Ustalenie z recenzji: bez tej walidacji brak np. 'nadawcy' wywala sie dopiero przy
  // pierwszym nadaniu niezrozumialym TypeError, zamiast czytelnym bledem konfiguracji
  // w momencie tworzenia klienta.
  it('brak nadawcy → czytelny błąd już przy tworzeniu klienta, nie przy nadaniu', () => {
    expect(() => createDpdClient({ ...pelnaKonfiguracja, nadawca: undefined })).toThrow(/nadawca/i);
  });

  it('brak loginu → czytelny błąd przy tworzeniu klienta', () => {
    expect(() => createDpdClient({ ...pelnaKonfiguracja, login: undefined })).toThrow(/login/i);
  });

  // I2. Samo `if (!nadawca)` przepuszczalo obiekt z PUSTYMI polami — a taki wlasnie
  // sklada sie z nieustawionych zmiennych srodowiskowych z domyslnymi ''. Kazda paczka
  // jechalaby wtedy z pusta ulica, kodem i miastem nadawcy, a DPD i tak oddawaloby
  // numer listu, wiec nikt by sie nie zorientowal.
  it('nadawca z PUSTYMI polami → błąd, a nie cicha zgoda', () => {
    const pusty = { nazwa: 'Lumina', ulica: '', kod: '', miasto: '', kraj: 'PL' };
    expect(() => createDpdClient({ ...pelnaKonfiguracja, nadawca: pusty }))
      .toThrow(/nadawca\.ulica.*nadawca\.kod.*nadawca\.miasto/);
  });

  it('nadawca bez miasta → błąd wskazujący brakujące pole', () => {
    const bezMiasta = { ...nadawca, miasto: '   ' };
    expect(() => createDpdClient({ ...pelnaKonfiguracja, nadawca: bezMiasta })).toThrow(/nadawca\.miasto/);
  });

  it('kompletna konfiguracja → tworzy klienta bez wyjątku', () => {
    expect(() => createDpdClient(pelnaKonfiguracja)).not.toThrow();
  });
});

// M3. Nadanie bylo OSTATNIM wywolaniem zewnetrznym panelu bez jakiegokolwiek limitu czasu:
// soapZdarzen mial 5 s, klient inFaktu 60 s, a tu undici czekal na naglowki domyslne
// 300 000 ms. Przez ten czas wiersz przesylki stoi 'w_trakcie', a przegladarka operatora wisi.
describe('twardy limit czasu na nadaniu', () => {
  // TRZY żądania od Zadania „kolejka druku": V10 (numer), V4 PDF, V4 ZPL.
  it('wszystkie trzy żądania nadania (V10, V4 PDF, V4 ZPL) niosą własny sygnał przerwania', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    expect(fetchImpl.mock.calls).toHaveLength(3);
    for (const [, opcje] of fetchImpl.mock.calls) {
      expect(opcje.signal).toBeInstanceOf(AbortSignal);
      expect(opcje.signal.aborted).toBe(false);
    }
  });

  // Sygnal musi byc NOWY na kazde zadanie: wspolny starzalby sie razem z procesem
  // i po godzinie pracy panelu przerywal kazde nadanie natychmiast.
  it('każde żądanie dostaje osobny sygnał, nie jeden wspólny', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    expect(fetchImpl.mock.calls[0][1].signal).not.toBe(fetchImpl.mock.calls[1][1].signal);
  });

  it('limit jest krótszy niż domyślne czekanie undici (300 s)', () => {
    expect(LIMIT_NADANIA_MS).toBeGreaterThan(0);
    expect(LIMIT_NADANIA_MS).toBeLessThan(300_000);
  });

  // NIEZMIENNIK, ten sam co przy inFakcie: „przesylka starsza od progu" MUSI znaczyc
  // „nic juz nie leci". Nadanie to TRZY zadania po kolei (V10, V4 PDF, V4 ZPL — trzecie
  // dolozone w Zadaniu „kolejka druku"), wiec liczy sie ICH SUMA — gdyby dosiegla progu,
  // panel moglby uznac ZYWE nadanie za osierocone, operator odblokowalby je w trakcie,
  // a DPD dostaloby druga paczke do tego samego zamowienia.
  it('suma limitów wszystkich trzech żądań jest KRÓTSZA niż próg zawieszonego nadania', () => {
    expect(3 * LIMIT_NADANIA_MS).toBeLessThan(PROG_ZAWIESZONEGO_NADANIA_MS);
  });

  // Straznik jest przy WCZYTANIU modulu, wiec zlamanie niezmiennika ma nie pozwolic
  // panelowi wstac — a nie po cichu wrocic do wyscigu. Tu tylko przypinamy, ze straznik
  // w ogole jest w kodzie: samo porownanie stalych wyzej nie odroznia „relacja zachodzi"
  // od „relacja jest WYMUSZONA".
  it('moduł ma strażnika wymuszającego tę relację, nie tylko ją spełnia', () => {
    const zrodlo = readFileSync(fileURLToPath(new URL('../../src/oms/kurierzy/dpd.js', import.meta.url)), 'utf8');
    expect(zrodlo).toMatch(/if\s*\([^)]*LIMIT_NADANIA_MS\s*>=\s*PROG_ZAWIESZONEGO_NADANIA_MS\s*\)/);
    expect(zrodlo).toMatch(/throw new Error\(/);
  });
});

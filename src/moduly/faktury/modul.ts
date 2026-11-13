import type { ModulOms, Srodowisko, Zegar } from '../../core/kontrakty.ts';
import { wczytajSprzedawce } from '../../core/sprzedawca.ts';
import { createPuls } from '../../core/puls.js';
import { kanalKlientaUmie } from '../../domena/moduly-kanalow.ts';
import { mapaNaZadanie } from '../kanaly/kolekcje-na-zadanie.ts';
import { ocenZdrowie } from '../../domena/zdrowie.js';
import { integracje } from '../../integracje/klucze.js';
import { createInfaktClient } from '../../oms/infakt/client.js';
import { createVies } from '../../oms/services/vies.js';
import { createFaktura } from './services/faktura.js';
import { createFakturaHurtem } from './services/faktura-hurtem.js';
import { createProforma } from './services/proforma.js';
import { createFakturyWidok } from './services/faktury-widok.js';
import { createWysylkaKsef } from './services/wysylka-ksef.js';
import { createFakturaAllegro } from './services/faktura-allegro.js';
import { createPoNumerzeKsef } from './services/po-numerze-ksef.js';
import { createDoczytanieKsef } from './services/ksef-doczytanie.js';
import { createCzuwaczKsef, najdluzszyPrzebiegMs } from './services/czuwacz-ksef.js';
import {
  createCzuwaczArchiwumSprzedazy, najdluzszyPrzebiegArchiwumSprzedazyMs,
} from './services/czuwacz-archiwum-sprzedazy.js';
import { przypiszDoOkresu } from './services/okres.js';
import { createZapytania as fakturyDb } from './db/faktury.js';
import { createZapytania as proformyDb } from './db/proformy.js';
import { createZapytania as kolejkaDruku } from './db/kolejka-druku-faktur.js';
import { zgloszenia as zgloszeniaDruku } from './db/stanowiska-druku.js';
import { stanStanowisk } from '../../domena/druk-faktur.js';
import { registerFakturyRoutes } from './trasy/faktury.js';
import { registerOkresyRoutes } from './trasy/okresy.js';
import { registerDokumentyRoutes } from './trasy/dokumenty.js';
import { registerDrukFakturRoutes } from './trasy/druk.js';
import { registerUstawieniaFirmyRoutes } from './trasy/ustawienia-firma.js';
// PRZ-122.ZGODA-TFc: cały kod TwojeFaktury (program, edycja, trasy, KSeF sprzedaży, migracje, funkcje dla plików
// wspólnych) wchodzi wyłącznie przez szew; kopia bez modułu ma tu `null`. Żadnych statycznych importów plików TF.
import { szewTwojeFaktury } from './wczytaj-szew.ts';
import type { SzewTwojeFaktury } from './szew-kontrakt.ts';
import { pobierzZamowienie, dopiszLog } from '../../oms/db/zamowienia.js';
import { kwotaOczekiwanaGrosze } from '../../domena/suma-pozycji.js';
import { stawkiDlaProgramu } from '../../domena/vat.js';
import { zwolnienieDlaProgramu } from './db/zwolnienie-vat.js';
import { wplatyPowiazane, dopiszWplatePowiazana } from './db/wplaty-dokumentu.js';
import { zegarKsef, zegarArchiwumSprzedazy, zegarAutomatuKsef, createAutomatKsef, ODSTEP_AUTOMATU_KSEF_MS } from './zegary.ts';
import { paczkaBiuraDlaTras } from './paczka-biura.ts';
import { skonfigurowanyUrl } from '../../core/konfiguracja-wartosci.ts';
import { efektywnyTryb } from '../../core/tryb.ts';
import { adresFirmyZEnv } from '../../core/adres-firmy.ts';
import { zrodloAdresuFirmy } from '../../oms/db/adres-firmy.js';
import { zrodloRachunkuFirmy } from '../../oms/db/rachunek-firmy.js';
import { zrodloNipuIBdoFirmy } from '../../oms/db/nip-bdo-firmy.js';
import { wczytajKonfiguracjeIntegracji } from '../../oms/db/konfiguracja-integracji.js';
import { infaktZUstawien, odmowaInfaktuWProbie, odmowaViesWProbie } from './infakt-ustawien.ts';
import { registerUstawieniaInfaktuRoutes } from './trasy/ustawienia-infakt.js';
import { registerUstawieniaFakturowniRoutes } from './trasy/ustawienia-fakturownia.js';
import { registerUstawieniaProgramuRoutes, trybRestartu } from './trasy/ustawienia-programu.js';
import { registerResetDemoRoutes } from './trasy/reset-demo.js';
import { resetDemoDostepny } from '../../domena/reset-demo.js';
import { bladOperatora } from '../../domena/bledy.js';
import { opcjeKlientaInfakt } from '../../domena/konfiguracja-infakt.js';
import { programInfakt } from '../../integracje/programy/infakt.ts';
import { sprawdzProgramFakturowy } from '../../integracje/program-fakturowy.ts';
import { zgodaTwojeFaktury, wyborZPliku, wybierzProgram, jawnyBrak, zdanieBrakuProgramu, zdanieCzekaniaNaRestart } from '../../domena/wybor-programu.js';
import { wczytajWyborProgramu } from '../../oms/db/wybor-programu.js';
import { createFakturowniaClient } from '../../oms/fakturownia/client.js';
import { programFakturownia, NAZWA_FAKTUROWNI } from '../../integracje/programy/fakturownia.ts';
import { utworzAlarmAutoKsef } from './db/alarm-auto-ksef.js';
import { fakturowniaZUstawien, odmowaFakturowniWProbie } from './fakturownia-ustawien.ts';
import { opcjeKlientaFakturowni, EKRAN_FAKTUROWNI, WZOR_DOMENY_FAKTUROWNI } from '../../domena/konfiguracja-fakturownia.js';

export const ODSTEP_FAKTUR_MS = 3600000;

export function wczytajFaktury(env: Srodowisko, szew: SzewTwojeFaktury | null = szewTwojeFaktury) {
  // PRZ-121.01: moduł faktur z pliku — zła wartość (literówka, moduł „wkrótce”) = odmowa startu z nazwą zmiennej.
  const zgodaTf = zgodaTwojeFaktury(env);
  // PRZ-122.ZGODA-TFc (decyzja 3): zgoda w kopii bez plików modułu = odmowa startu, nie ciche „wkrótce”.
  if (zgodaTf && !szew) {
    throw new Error('OMS_TWOJEFAKTURY: ustawione na tak, ale ta wersja OMS-u nie ma modułu TwojeFaktury (brak pliku '
      + 'src/moduly/faktury/szew-twojefaktury.ts) — usuń zmienną albo dołóż pliki modułu.');
  }
  const programZPliku = wyborZPliku(env.OMS_PROGRAM_FAKTUROWY, { zgoda: zgodaTf });
  const adresInfaktuZPliku = skonfigurowanyUrl(env.INFAKT_API_URL, 'INFAKT_API_URL');
  const sprzedawca = wczytajSprzedawce(env);
  const katalog = env.OMS_PROFORMY_KATALOG?.trim();
  if (!katalog) throw new Error('OMS_PROFORMY_KATALOG: wymagany katalog proform');
  // Harmonogram źródła: raz na godzinę, aby nie ominąć nocnego okna archiwum.
  const odstepMs = ODSTEP_FAKTUR_MS;
  // PRZ-093.08: adres z pliku; w zbuduj dokłada się adres z Ustawień (config.adresFirmy), gdy pliku nie ma.
  const nadawca = adresFirmyZEnv(env);
  // PRZ-093.10: archiwum sprzedaży (katalog na serwerze) tylko z pliku — także przy kluczu z Ustawień.
  const archiwum = env.INFAKT_ARCHIWUM?.trim() || null;
  // PRZ-119.05: Fakturownia z pliku — token i domena tylko parą (połowa pary = odmowa startu, bez wartości w zdaniu).
  // Sama para niczego nie włącza: Fakturownia działa wyłącznie z jawnego wyboru (OMS_PROGRAM_FAKTUROWY albo Ustawienia).
  const tokenFakturowni = env.FAKTUROWNIA_API_TOKEN?.trim() || null;
  const domenaFakturowni = env.FAKTUROWNIA_DOMENA?.trim() || null;
  if (Boolean(tokenFakturowni) !== Boolean(domenaFakturowni)) {
    const [brak, jest] = tokenFakturowni ? ['FAKTUROWNIA_DOMENA', 'FAKTUROWNIA_API_TOKEN'] : ['FAKTUROWNIA_API_TOKEN', 'FAKTUROWNIA_DOMENA'];
    throw new Error(`${brak}: wymagana razem z ${jest} (Fakturownia z pliku konfiguracji) — wpisz obie zmienne albo usuń obie.`);
  }
  if (domenaFakturowni && !WZOR_DOMENY_FAKTUROWNI.test(domenaFakturowni)) {
    throw new Error('FAKTUROWNIA_DOMENA: tylko domena konta — małe litery, cyfry i myślnik, część przed .fakturownia.pl (bez https://).');
  }
  // `infakt` — kształt sprzed PRZ-093.10, tylko z pliku (.env wygrywa w całości); `infaktUstawien` — co z pliku
  // dotyczy klucza z ekranu Ustawienia → Integracje → inFakt (adres z pliku go NIE dotyczy, archiwum tak).
  return { proforma: { ...sprzedawca, katalog }, nadawca,
    infakt: env.INFAKT_API_KEY ? { apiKey: env.INFAKT_API_KEY, baseUrl: env.INFAKT_API_URL || undefined,
      archiwum } : null, infaktUstawien: { archiwum, adresWPliku: Boolean(adresInfaktuZPliku) },
    fakturownia: tokenFakturowni && domenaFakturowni ? { token: tokenFakturowni, domena: domenaFakturowni } : null,
    archiwumSprzedazy: env.OMS_ARCHIWUM_SPRZEDAZY?.trim() || archiwum,
    odstepMs, zgodaTf, proba: efektywnyTryb(env) === 'proba', programZPliku,
    // PRZ-121.06: przycisk „Uruchom OMS ponownie” — `tak` / `atrapa` (demo); inna wartość = bez przycisku, nie błąd startu.
    restartZPanelu: trybRestartu(env.OMS_RESTART_Z_PANELU),
    // PRZ-123.C04b: wysyłka TwojeFaktury do KSeF — ten sam token i adres co koszty (plik wygrywa nad Ustawieniami),
    // czytane tu, żeby faktury nie zależały od modułu Koszty (ten waliduje KSEF_API przy starcie).
    ksef: { token: env.KSEF_TOKEN?.trim() || null, baseUrl: env.KSEF_API?.trim().replace(/\/+$/, '') || undefined },
    // PRZ-123.KSEF-TEST: piaskownica z KSeF TEST — para zmiennych, wyłącznie w próbie i wyłącznie adres TEST (inaczej
    // odmowa startu). Bez pary `null` — wszystko jak dotąd.
    // ZGODA-TFc: sprawdza szew (plik TF); bez szwu para nie ma czego włączyć — `null`.
    ksefTest: szew ? szew.wczytajKsefTestProby({ api: env.OMS_PROBA_KSEF_TEST_API, token: env.OMS_PROBA_KSEF_TEST_TOKEN,
      proba: efektywnyTryb(env) === 'proba' }) : null };
}

// PRZ-121.06: domyślne ubicie po „Uruchom OMS ponownie” — SIGTERM do siebie (main.ts zamyka łagodnie, nadzorca procesu
// podnosi kontener). Szew `fabryki.zakonczProces` podmienia je w testach i w piaskownicy (node --watch).
// Bezpiecznik (recenzja): zawieszony przebieg zegara trzymałby proces po zamknięciu serwera — po 20 s wyjście.
const zakonczProcesDomyslnie = () => {
  process.kill(process.pid, 'SIGTERM');
  setTimeout(() => process.exit(0), 20_000).unref();
};

// PRZ-076: atrapy piaskownicy (deploy/proba/atrapy) wchodzą WYŁĄCZNIE tymi dwiema fabrykami i wyłącznie w trybie
// próby. (createCzuwacz* niżej to szwy testów sprzed PRZ-076 — nie podmieniają klienta inFaktu ani VIES.)
// Odmowa tutaj, a nie tylko w start.mjs piaskownicy: pomyłka w składaniu produkcji ma zatrzymać start, a nie
// wystawiać faktury w atrapie zamiast w inFakcie.
// PRZ-118.05: `programFakturowy` — trzeci szew tej samej klasy (program fakturowy inny niż inFakt, np. o innych
// limitach albo regule VAT), wyłącznie w trybie próby; razem z `createInfaktClient` = odmowa (jedno źródło programu).
// PRZ-123.C07a: `atrapaKsefWysylki` — atrapa KSeF wysyłki (deploy/proba/atrapy/ksef-wysylka.mjs) dla programu
// wbudowanego: `() => ({ baseUrl, fetchImpl, fabryka, spij? })` (fabryka = klient logowania atrapy KSeF).
// PRZ-119.05: `createFakturowniaClient` — atrapa Fakturowni (deploy/proba/atrapy/fakturownia.mjs): `({ db, teraz, token })`.
// Piaskownica podaje ją obok `createInfaktClient`; składana tylko przy wyborze Fakturowni.
// PRZ-119.11a: `fakturowniaProby` — profil próby (deploy/proba/atrapy/fakturownia-proba.ts) ZAMIAST atrapy Fakturowni:
// `{ domena, fetchImpl, znacznik(db) }` — prawdziwy klient z tokenem z ekranu, wyłącznie na domenę z pliku profilu,
// `oid` z prefiksem bazy próby, KSeF (ręcznie i automat) wyłączony.
const FABRYKI_ATRAP = ['createInfaktClient', 'createVies', 'programFakturowy', 'atrapaKsefWysylki', 'createFakturowniaClient', 'fakturowniaProby'];
// Atrapa bez zapisu z ekranu: demo działa od razu (token „demo”, jak klucz inFaktu atrapy).
const ZAPIS_DEMO_FAKTUROWNI = { ustawienia: { domena: 'demo' }, sekrety: { token: 'demo' } };

// PRZ-122.ZGODA-TFc: `fabryki.szewTwojeFaktury` — szew testów (`null` = kopia bez modułu TwojeFaktury); bez klucza
// moduł bierze szew wczytany z drzewa. Migracje TF są w module `twojefaktury` (szew, `src/moduly/lista.ts`).
export function createModulFaktury({ fabryki = {} }: { fabryki?: Record<string, any> } = {}): ModulOms<ReturnType<typeof wczytajFaktury>> {
const szew: SzewTwojeFaktury | null = Object.hasOwn(fabryki, 'szewTwojeFaktury') ? fabryki.szewTwojeFaktury : szewTwojeFaktury;
return {
  nazwa: 'faktury', wersja: '1.0.0', wymaga: ['rdzen', 'kanaly', 'web'],
  kluczeIntegracji: [...integracje.infakt.kluczeIntegracji, ...integracje.fakturownia.kluczeIntegracji, ...integracje.allegro.kluczeIntegracji],
  konfiguracja: (env) => wczytajFaktury(env, szew), migracje: [],
  uprawnienia: [{ klucz: 'faktury', etykieta: 'Faktury', role: ['admin', 'operator'] },
    { klucz: 'faktury-zamowienia', etykieta: 'Faktury zamówień', role: ['admin', 'operator'] },
    { klucz: 'pozostale-dokumenty-zamowienia', etykieta: 'Pozostałe dokumenty zamówień', role: ['admin', 'operator'] },
    { klucz: 'okresy', etykieta: 'Okresy rozliczeniowe', role: ['admin', 'operator'] }],
  menu: [{ dzial: 'sprzedaz', grupa: 'obsluga', etykieta: 'Faktury', adres: '/faktury', uprawnienie: 'faktury', kolejnosc: 30 },
    // PRZ-102.03: grupa „Klienci” w menu bocznym (zgodnie z EKRANY.nawigacja).
    { dzial: 'sprzedaz', grupa: 'klienci', etykieta: 'Rozliczenia', adres: '/okresy', uprawnienie: 'okresy', kolejnosc: 60 }],
  zbuduj: (ctx) => {
    const { db, konfiguracja: k, teraz } = ctx;
    const atrapy = FABRYKI_ATRAP.filter((n) => fabryki[n]);
    if (atrapy.length && !k.proba) throw new Error(`Fabryki ${atrapy.join(', ')} (atrapy piaskownicy) wolno podać tylko z OMS_TRYB=proba`);
    const wszyscyKlienci = ctx.usluga<Record<string, any>>('kanaly', 'klienciKanalow');
    const kanaly = mapaNaZadanie(() => Object.keys(wszyscyKlienci).filter(sklep => kanalKlientaUmie(sklep, u => u.plikFaktury)), sklep => wszyscyKlienci[sklep]);
    const adresFirmy = zrodloAdresuFirmy({ db, zPliku: k.nadawca });
    // PRZ-102.20: rachunek i bank z bieżącej konfiguracji (plik → Ustawienia → Firma → brak) — proforma i maile płatnicze
    // (config kopiowany do wiadomości) czytają go przy każdym użyciu; `proforma.rachunek` zostaje wartością z pliku.
    // Źródło nie trzyma stanu (czyta bazę przy każdym wywołaniu), więc własna instancja = ta sama odpowiedź co usługa rdzenia.
    const rachunekFirmy = zrodloRachunkuFirmy({ db, zPliku: k.proforma });
    // PRZ-108.10: NIP i BDO tak samo (każde pole osobno: plik → Ustawienia → Firma → brak), czytane przy każdym dokumencie,
    // fakturze WDT i zapytaniu VIES; `proforma.nip` / `.bdo` zostają wartościami z pliku.
    const nipBdoFirmy = zrodloNipuIBdoFirmy({ db, zPliku: k.proforma });
    const nipTeraz = () => nipBdoFirmy.biezacy().nip;
    // PRZ-122.ZGODA-TFc: cały kod TwojeFaktury przez szew. Bez szwu — inFakt / „brak” jak w kopii bez modułu,
    // moduł „wkrótce” (zgodę bez szwu odrzuca już `wczytajFaktury`). Schemat `tf_*` daje moduł `twojefaktury`.
    // PRZ-122.AS3: szew w drzewie to za mało — bez zgody instalacji (`OMS_TWOJEFAKTURY=tak`) żadnych tras, usług,
    // `zlozKsef` ani numeru demo TF (decyzja właściciela 28.10: „wkrótce”, nic z TF nie działa ani nie zapisuje).
    const tf = k.zgodaTf ? szew : null;
    const zgodaTf = Boolean(tf);
    // PRZ-123.C04b / C07a / KSEF-TEST: źródło KSeF sprzedaży i połączenie wysyłki — w szwie (`zlozKsef`).
    const { ksefSprzedazy = null, polaczenieKsef = null, atrapaWysylki = null } = tf ? tf.zlozKsef({ db, teraz, k, fabryki, nipTeraz }) : {};
    const config = { ...ctx.usluga<any>('kanaly', 'config'), proforma: k.proforma, infakt: k.infakt, nadawca: k.nadawca,
      adresFirmy: adresFirmy.adres, rachunekFirmy: rachunekFirmy.biezacy, nipBdoFirmy: nipBdoFirmy.biezacy };
    const puls = createPuls({ teraz });
    // PRZ-093.10: inFakt z Ustawień (wiersz „infakt” w konfiguracja_integracji) — tylko gdy plik nie ma INFAKT_API_KEY
    // (.env wygrywa w całości; wtedy ścieżka niżej jest identyczna jak przed zmianą). Pośrednik czyta zapis przy każdym
    // żądaniu (zmiana klucza bez restartu); usługi faktur powstają z nim tylko, gdy zapis był w bazie przy starcie.
    // Piaskownica bez atrapy dostaje odmowę zamiast prawdziwego klienta; z atrapą — zawsze atrapę (gałąź pierwsza).
    // Zapis klucza z ekranu Ustawienia → Integracje → inFakt (wiersz „infakt”; nazwa bez słowa — strażnik PRZ-118.10).
    const zapisKlucza = () => wczytajKonfiguracjeIntegracji(db, 'infakt');
    if (fabryki.programFakturowy && fabryki.createInfaktClient) {
      throw new Error('Fabryki programFakturowy i createInfaktClient naraz — podaj jedną (jedno źródło programu fakturowego).');
    }
    // PRZ-121.01: wybór modułu faktur (domena/wybor-programu.js) — plik → zapis z Ustawień → inFakt, gdy gotowy → „brak”.
    // „Gotowy” = to samo, co przed zmianą dawało niepusty `infakt` niżej (szew programu, atrapa, plik, zapis z ekranu
    // przy starcie), więc bez wyboru moduł składa się jak dotąd. Zapis czytany przy każdym `teraz()`; składanie — raz.
    const gotowy = () => Boolean(fabryki.programFakturowy || fabryki.createInfaktClient || k.infakt || zapisKlucza());
    const regula = () => wybierzProgram({ zPliku: k.programZPliku, zUstawien: wczytajWyborProgramu(db)?.program ?? null,
      infaktGotowy: gotowy(), zgoda: zgodaTf });
    const wybor = regula();
    // PRZ-119.05: Fakturownia — zapis z ekranu Ustawienia → Integracje → Fakturownia (wiersz „fakturownia”: domena
    // w ustawieniach, token w sekretach). Gotowa = atrapa piaskownicy, para w pliku albo pełny zapis. Reguła wyboru
    // dalej pyta wyłącznie o inFakt (Fakturownia nigdy domyślnie); ta gotowość służy zdaniu „czeka na restart”.
    const zapisFakturowni = () => wczytajKonfiguracjeIntegracji(db, 'fakturownia');
    const fakturowniaZapisana = () => {
      const zapis = zapisFakturowni();
      const opcje = zapis ? opcjeKlientaFakturowni(zapis) : null;
      return Boolean(opcje?.token && opcje.domena);
    };
    const gotowoscProgramu = (program: string) => (program === 'fakturownia'
      ? Boolean(fabryki.createFakturowniaClient || k.fakturownia || fakturowniaZapisana()) : gotowy());
    // ⛔ Jawny „brak” (plik albo Ustawienia): NIE powstaje żaden program ani klient — ani z pliku, ani pośrednik
    // z Ustawień, ani atrapa, ani szew próby; fabryk się nie woła. Usługi zależne są `null` jak dziś bez inFaktu.
    // „Brak” domyślny (nic nie wybrano i nic nie ma) składa się jak przed zmianą — z pośrednikiem pierwszego podłączenia.
    const wylaczone = jawnyBrak(wybor);
    const wyborProgramu = { program: wybor.program, zrodlo: wybor.zrodlo, uwaga: wybor.uwaga,
      zgoda: zgodaTf,
      // PRZ-119.05: gotowość ZAPISANEGO programu (inFakt: klucz; Fakturownia: domena i token) — ekran „Moduł faktur”.
      teraz: regula, gotowy: () => gotowoscProgramu(regula().program), czekaNaRestart: () => regula().program !== wybor.program };
    const brakTeraz = () => wylaczone || jawnyBrak(regula());
    // PRZ-119.05: przy wyborze Fakturowni nie powstaje nic z inFaktu (klient, pośrednik z Ustawień, atrapa, szew programu).
    const fakturowniaWybrana = !wylaczone && wybor.program === 'fakturownia';
    const proba = fakturowniaWybrana ? fabryki.fakturowniaProby ?? null : null;
    const klientFakturowni = !fakturowniaWybrana ? null
      // Profil próby: zapis z ekranu czytany przy każdym wywołaniu; domena inna niż w pliku profilu = 400 przed siecią.
      : proba ? fakturowniaZUstawien({ wczytaj: zapisFakturowni, fabryka: (o) => {
        if (o.domena !== proba.domena) {
          throw bladOperatora(`Piaskownica łączy się wyłącznie z kontem próbnym z pliku profilu (${proba.domena}.fakturownia.pl) — zapisz formularz w Ustawienia → Integracje → Fakturownia ponownie. Nic nie poszło do Fakturowni.`, { status: 400, bezProgramu: true });
        }
        return createFakturowniaClient({ token: o.token, domena: proba.domena, fetchImpl: proba.fetchImpl });
      } })
      : fabryki.createFakturowniaClient ? fakturowniaZUstawien({ wczytaj: () => zapisFakturowni() ?? ZAPIS_DEMO_FAKTUROWNI,
        fabryka: (o) => fabryki.createFakturowniaClient({ db, teraz, token: o.token }) })
      : k.fakturownia ? createFakturowniaClient({ ...k.fakturownia, fetchImpl: undefined })
      : fakturowniaZapisana() ? fakturowniaZUstawien({ wczytaj: zapisFakturowni,
        fabryka: k.proba ? odmowaFakturowniWProbie : createFakturowniaClient })
      : null;
    // Magazyn alarmu automatycznej wysyłki do KSeF — wspólny dla adaptera (warstwa 2) i czuwacza (warstwa 3).
    const alarmAutoKsef = klientFakturowni ? utworzAlarmAutoKsef(db, { teraz }) : null;
    const programFakturowni = klientFakturowni && alarmAutoKsef
      ? sprawdzProgramFakturowy(programFakturownia(klientFakturowni as any, { alarmAutoKsef, teraz,
        ...(proba ? { piaskownica: { znacznik: () => proba.znacznik(db) } } : {}) })) : null;
    const infaktUstawien = k.infakt || wylaczone || fakturowniaWybrana ? null : infaktZUstawien({ wczytaj: zapisKlucza,
      fabryka: k.proba ? odmowaInfaktuWProbie : createInfaktClient });
    // Wybór źródła jak dla klienta; na zewnątrz modułu wychodzi wyłącznie adres, nigdy klucz API. Przy „brak” — nic.
    const celeLacznosci = () => {
      if (brakTeraz() || fakturowniaWybrana) return { infakt: null };
      const zapis = infaktUstawien ? zapisKlucza() : null;
      return { infakt: infaktUstawien ? (zapis ? { baseUrl: opcjeKlientaInfakt(zapis).baseUrl } : null)
        : k.infakt ? { baseUrl: k.infakt.baseUrl } : null };
    };
    const zUstawienPrzyStarcie = Boolean(!fabryki.createInfaktClient && infaktUstawien && zapisKlucza());
    const programZFabryki = !wylaczone && !fakturowniaWybrana && fabryki.programFakturowy ? fabryki.programFakturowy({ db, teraz }) : null;
    // Sprzedawca programu wbudowanego z bieżącej konfiguracji (czytany przy każdym dokumencie) — ten sam dla
    // wystawienia i dla zapisu zmian na ekranie faktury (B20c).
    const sprzedawcaWbudowanego = () => {
      const adres = adresFirmy.adres();
      const { nip, bdo } = nipBdoFirmy.biezacy();
      const { rachunek, bank } = rachunekFirmy.biezacy();
      return { nazwa: adres?.nazwa, nip, ulica: adres?.ulica, kod: adres?.kod, miasto: adres?.miasto,
        kraj: 'PL', email: adres?.email, telefon: adres?.phone, bdo, rachunek, bank };
    };
    const wbudowany = tf && wybor.program === 'twojefaktury' ? sprawdzProgramFakturowy(programZFabryki ?? tf.programTwojeFaktury({
      db, teraz, log: ctx.log, zwolnienie: () => zwolnienieDlaProgramu(db), sprzedawca: sprzedawcaWbudowanego,
      // Dostawca JS przyjmuje listę tekstowych id; bez JSDoc TS wnioskuje wyłącznie domyślne null.
      wplatyPowiazane: (ids: string[] | null) => (wplatyPowiazane as
        (baza: typeof db, ids: string[] | null) => ReturnType<typeof wplatyPowiazane>)(db, ids),
      dopiszWplatePowiazana: (id: string, wplata: { kwotaGr: number; data: string; uwaga: string }) => dopiszWplatePowiazana(db, id, wplata),
      ksef: polaczenieKsef, ...(atrapaWysylki?.spij ? { spij: atrapaWysylki.spij } : {}),
      // B10a: środowisko KOD I na PDF nabywcy — ten sam adres, na który idzie wysyłka (w próbie: atrapa).
      adresKsef: k.proba && atrapaWysylki ? atrapaWysylki.baseUrl : k.ksefTest?.baseUrl ?? k.ksef.baseUrl,
    })) : null;
    // PRZ-122.B20c: edycja wystawionej faktury (usługa B20b) i jej ekran — WYŁĄCZNIE przy programie wbudowanym
    // (przy inFakcie trasy nie ma). Należność zamówienia jak wszędzie (`kwotaOczekiwanaGrosze`), pobranie z zamówienia;
    // zamówienia już nie ma → null (bez różnicy). Log zamówienia przez dopiszLog (konto z kontekstu żądania).
    const edycjaTwojeFaktur = tf && wbudowany ? tf.edycjaTwojeFaktury({
      db, teraz, stawki: stawkiDlaProgramu({ wbudowany: true }), sprzedawca: sprzedawcaWbudowanego,
      zwolnienie: () => zwolnienieDlaProgramu(db),
      kwotaZamowienia: (id: number) => {
        const z = pobierzZamowienie(db, id);
        return z ? { kwotaGr: kwotaOczekiwanaGrosze(z), pobranie: Boolean(z.pobranie) } : null;
      },
      log: (id: number, { akcja, wynik }: { akcja: string, wynik: string }) => dopiszLog(db, id, { akcja, wynik }),
      // PRZ-122.B21: korekta z ekranu faktury idzie przez `wystawKorekte` programu wbudowanego.
      program: wbudowany,
      // PRZ-126 C09c: odmowa zamiany bez numeru KSeF podaje powód ze źródła połączenia (brak tokenu, zgody…).
      ksef: polaczenieKsef,
    }) : null;
    // PRZ-119.05: przy Fakturowni `infakt` = program Fakturowni (jak przy programie wbudowanym — `zProgramu` go nie owija).
    const infakt = wylaczone ? null : fakturowniaWybrana ? programFakturowni
      : wbudowany ?? programZFabryki ?? (fabryki.createInfaktClient ? fabryki.createInfaktClient({ db, teraz })
      : k.infakt ? createInfaktClient({ ...k.infakt, fetchImpl: undefined })
      : zUstawienPrzyStarcie ? infaktUstawien : null);
    // PRZ-118.05: program fakturowy = ten sam obiekt „inFakt” (klient z pliku, pośrednik z Ustawień — zmiana klucza
    // dalej bez restartu, bo program woła pośrednika przy każdym wywołaniu — albo atrapa próby) za kontraktem.
    // Wybór źródła bez zmian (w PRZ-118 brak wyboru programu). Strażnik kontraktu tu, przy składaniu (nie w podkładce).
    // Atrapa z fabryki `createInfaktClient` (próba) idzie bez strażnika: test szwu PRZ-076 (tests/moduly/faktury/
    // modul.test.ts) podaje atrapę z dwiema metodami; atrapa piaskownicy ma komplet (tests/instalacja/atrapy-kontrakt).
    //
    // ⚠️ DECYZJA KIEROWNIKA PRZ-118.05: usługa `infakt` ZOSTAJE (koniec aliasu nie w PRZ-118). Testy podmieniają
    // `nadpisania['faktury.infakt']` (core/aplikacja.ts:72), więc konsumenci czytają klucz `infakt` i owijają go
    // `zProgramu`/`programInfakt`. ≠ plan 05.1(1): `infakt` NIE jest tym samym obiektem co `programFakturowy`, tylko
    // klientem pod nim — usługi i trasy faktur do zmian 06–07 wołają jeszcze znajdzKlientaPoNip/zalozKlienta, których
    // program nie wystawia, a istniejące testy przypinają `uslugi.infakt` = atrapa (`toBe`, `.atrapa === true`).
    // Wyjątek: program z fabryki `programFakturowy` nie ma klienta pod spodem — wtedy `infakt` = ten sam program.
    const programFakturowy = fakturowniaWybrana ? programFakturowni : wbudowany ?? (programZFabryki ? sprawdzProgramFakturowy(programZFabryki)
      : !infakt ? null
      : fabryki.createInfaktClient ? programInfakt(infakt)
      : sprawdzProgramFakturowy(programInfakt(infakt)));
    // Strażnik budżetu z limitów WYBRANEGO programu.
    if (programFakturowy) {
      const { limity, nazwa } = programFakturowy.opis;
      const ksef = najdluzszyPrzebiegMs(limity);
      const archiwumMs = najdluzszyPrzebiegArchiwumSprzedazyMs(limity);
      if (ksef >= k.odstepMs) {
        throw new Error(`Budżet czuwacza KSeF z limitów programu „${nazwa.mianownik}” (${ksef} ms) nie mieści się między tyknięciami zegara (${k.odstepMs} ms) — panel nie wstanie z tym programem.`);
      }
      if (archiwumMs >= k.odstepMs) {
        throw new Error(`Budżet czuwacza archiwum sprzedaży z limitów programu „${nazwa.mianownik}” (${archiwumMs} ms) nie mieści się między tyknięciami zegara (${k.odstepMs} ms) — panel nie wstanie z tym programem.`);
      }
    }
    // PRZ-119.05: archiwum sprzedaży (INFAKT_ARCHIWUM) dotyczy inFaktu i programu wbudowanego — przy Fakturowni brak.
    const archiwum = fakturowniaWybrana ? null : wbudowany ? k.archiwumSprzedazy : k.infakt ? k.infakt.archiwum : zUstawienPrzyStarcie ? (k.infaktUstawien?.archiwum ?? null) : null;
    // Ekran sprawdza zapisane połączenie niezależnie od wyboru programu. W próbie wyłącznie atrapa albo — przy pliku
    // profilu (PRZ-119.11b) — konto próbne przez transport profilu; nigdy klient bez transportu.
    const profilProby = fabryki.fakturowniaProby ?? null;
    const zdanieKontaProby = (domena: string) => `Piaskownica łączy się wyłącznie z kontem próbnym ${domena}.fakturownia.pl (z pliku profilu) — zapisz formularz ponownie. Nic nie poszło do Fakturowni.`;
    const sprawdzPolaczenieFakturowni = async () => {
      const zapis = zapisFakturowni();
      const opcje = k.fakturownia ?? opcjeKlientaFakturowni(zapis);
      try {
        if (brakTeraz()) throw bladOperatora(zdanieBrakuProgramu(regula(), 'Nic nie poszło do programu.')
          ?? 'Wybór modułu faktur czeka na ponowne uruchomienie OMS-u. Nic nie poszło do programu.', { status: 400 });
        if (profilProby && opcje.domena !== profilProby.domena) throw bladOperatora(zdanieKontaProby(profilProby.domena), { status: 400 });
        const klient = fabryki.createFakturowniaClient
          ? fabryki.createFakturowniaClient({ db, teraz, token: opcje.token })
          : profilProby ? createFakturowniaClient({ token: opcje.token, domena: profilProby.domena, fetchImpl: profilProby.fetchImpl })
          : k.proba ? odmowaFakturowniWProbie()
          : createFakturowniaClient({ ...opcje, fetchImpl: undefined });
        return await klient.sprawdzPolaczenie();
      } catch (e: any) {
        // Klient maskuje token i host. Ekran dodatkowo usuwa samą domenę, także odbitą bez hosta.
        let tekst = e?.dlaOperatora ? String(e.message) : 'Nie udało się sprawdzić połączenia z Fakturownią. Spróbuj ponownie.';
        for (const wartosc of [opcje.token, opcje.domena]) {
          if (!wartosc) continue;
          for (const forma of new Set([wartosc, encodeURIComponent(wartosc),
            encodeURIComponent(wartosc).replace(/%[0-9A-F]{2}/g, m => m.toLowerCase())])) {
            tekst = tekst.split(forma).join('[ukryto]');
          }
        }
        throw bladOperatora(tekst, { status: e?.status });
      }
    };
    const konfiguracjaInfaktu = {
      // PRZ-121.05c: klucz niepotrzebny, gdy klient pochodzi z atrapy piaskownicy.
      atrapa: infakt?.atrapa === true,
      zEnv: Boolean(k.infakt), adresWPliku: Boolean(k.infaktUstawien?.adresWPliku),
      archiwumWPliku: Boolean(k.infaktUstawien?.archiwum),
      // PRZ-121.01: ekran automatu KSeF i Automatyzacje dostają wybór bez nowych parametrów.
      wyborProgramu,
      // PRZ-121.02: ekran „Moduł faktur” opisuje ten moduł i stan jego klucza (bez wartości klucza).
      idModulu: 'infakt', kluczZapisany: () => Boolean(zapisKlucza()?.sekrety?.apiKey),
      sprawdzPolaczenie: async () => {
        // Przy „brak” klucz z Ustawień nie wychodzi z panelu — także do sprawdzenia połączenia, także gdy „brak”
        // zapisano po starcie (pośrednik istnieje do restartu). Zdanie z tego „brak”, które obowiązuje.
        if (brakTeraz()) {
          const obecny = regula();
          // Start z „brak”, potem wybrany inny moduł — zdanie o restarcie zamiast „wybrano Brak” (ekran pokazuje już nowy).
          const czeka = jawnyBrak(obecny) ? null : zdanieCzekaniaNaRestart(wybor, obecny, { gotowy: gotowoscProgramu(obecny.program) });
          throw bladOperatora(czeka ? `${czeka} Nic nie poszło do programu.`
            : zdanieBrakuProgramu(jawnyBrak(obecny) ? obecny : wybor, 'Nic nie poszło do programu.'), { status: 400 });
        }
        // PRZ-119.05: ekran inFaktu przy Fakturowni nie sprawdza Fakturowni (ani atrapy piaskownicy) pod nazwą inFaktu.
        if (fakturowniaWybrana) throw bladOperatora('Moduł faktur to teraz Fakturownia — ten ekran nie sprawdza jej połączenia. Nic nie zostało wysłane.', { status: 400 });
        if (fabryki.createInfaktClient) return infakt.sprawdzPolaczenie();
        if (!infaktUstawien) throw bladOperatora('inFakt jest ustawiony w pliku konfiguracji — ten ekran go nie sprawdza.');
        return infaktUstawien.sprawdzPolaczenie();
      },
      // Pierwsze podłączenie: usługi faktur nie powstały przy starcie. Odłączenie: usługi zostają do restartu, ale odmawiają.
      wymagaRestartu: () => !jawnyBrak(regula()) && !infakt && Boolean(infaktUstawien && zapisKlucza()),
      odlaczonyDoRestartu: () => zUstawienPrzyStarcie && !zapisKlucza(),
    };
    // PRZ-119.07: stan Fakturowni dla ekranu „Moduł faktur” i automatu KSeF (bez wartości tokenu). Rodzaj żeński
    // w zdaniach automatu („odłączona”). Klient z zapisu Ustawień przy starcie = można go odłączyć do restartu.
    const fakturowniaZUstawienPrzyStarcie = Boolean(klientFakturowni && !fabryki.createFakturowniaClient && !k.fakturownia);
    const konfiguracjaFakturowni = {
      atrapa: Boolean(fabryki.createFakturowniaClient), zEnv: Boolean(k.fakturownia),
      wyborProgramu, idModulu: 'fakturownia', nazwa: NAZWA_FAKTUROWNI, zenska: true,
      tokenZapisany: () => Boolean(zapisFakturowni()?.sekrety?.token),
      wymagaRestartu: () => !jawnyBrak(regula()) && !klientFakturowni && fakturowniaZapisana(),
      odlaczonyDoRestartu: () => fakturowniaZUstawienPrzyStarcie && !fakturowniaZapisana(),
      // PRZ-119.06: ekran Ustawienia → Integracje → Fakturownia.
      sprawdzPolaczenie: sprawdzPolaczenieFakturowni,
      // PRZ-119.11b: profil próby — ekran przyjmuje wyłącznie domenę z pliku profilu (inna = 400 przed zapisem).
      domenaProby: profilProby?.domena ?? null,
      zdanieKontaProby,
    };
    // PRZ-119.07: automat KSeF czyta stan programu wybranego przy starcie — Fakturowni albo (jak dotąd) inFaktu.
    const konfiguracjaProgramu = fakturowniaWybrana ? konfiguracjaFakturowni : konfiguracjaInfaktu;
    // PRZ-093.10: inFakt z Ustawień w trybie próby bez atrapy VIES — odmowa zamiast prawdziwego VIES (wcześniej ta
    // kombinacja nie istniała: tryb próby odmawia startu z INFAKT_API_KEY, więc bez atrapy inFaktu nie było).
    const vies = !infakt ? null : fabryki.createVies ? fabryki.createVies({ db })
      : k.proba ? odmowaViesWProbie()
      : createVies({ nipSprzedawcy: nipTeraz, fetchImpl: undefined });
    const faktura = infakt ? createFaktura({ db, infakt, vies: vies as any, nipSprzedawcy: nipTeraz }) : null;
    const fakturaHurtem = faktura ? createFakturaHurtem({ faktura }) : null;
    const proforma = createProforma({ db, config, teraz });
    const paczkaDlaBiura = infakt ? paczkaBiuraDlaTras(() => ctx.usluga('koszty', 'paczkaDlaBiura')) : null;
    const fakturyWidok = infakt ? createFakturyWidok({ db, infakt }) : null;
    const wysylkaKsef = infakt && fakturyWidok ? createWysylkaKsef({ db, infakt, fakturyWidok, wpisTf: (tf?.wpisTwojeFaktury ?? null) as any }) : null;
    const fakturaAllegro = infakt ? createFakturaAllegro({ db, infakt, klienciKanalow: kanaly }) : null;
    const poNumerzeKsef = createPoNumerzeKsef({ db, fakturaAllegro: fakturaAllegro as any });
    const doczytanieKsef = infakt ? createDoczytanieKsef({ db, infakt, poNumerzeKsef: poNumerzeKsef as any }) : null;
    // PRZ-123.C07b: rozstrzyganie niepewnych wysyłek KSeF — tylko program wbudowany; czuwacz działa wtedy także bez
    // kanałów. Przy inFakcie argumenty czuwacza bez zmian (bez klucza `rozstrzyganie`).
    const rozstrzyganieKsef = tf && wbudowany ? tf.createRozstrzyganieKsef({ db, ksef: polaczenieKsef, teraz, log: ctx.log }) : null;
    const czuwaczKsef = infakt ? (fabryki.createCzuwacz ?? createCzuwaczKsef)({ db, infakt, klienciKanalow: kanaly, fakturaAllegro: fakturaAllegro as any,
      ...(rozstrzyganieKsef ? { rozstrzyganie: rozstrzyganieKsef } : {}),
      // PRZ-119.05: warstwa 3 — dokument Fakturowni w KSeF bez zlecenia z panelu = alarm (tylko przy Fakturowni).
      ...(alarmAutoKsef ? { alarmAutoKsef } : {}) }) : null;
    const czuwaczArchiwumSprzedazy = infakt && archiwum ? (fabryki.createCzuwaczArchiwumSprzedazy ?? createCzuwaczArchiwumSprzedazy)({ db, infakt, katalogArchiwum: archiwum, teraz }) : null;
    // PRZ-102.12: automat wysyłki do KSeF o godzinie z Ustawień — tylko na tych samych usługach co przycisk
    // (fakturyWidok + wysylkaKsef). Bez inFaktu przy starcie nie ma ani usług, ani automatu; ekran mówi dlaczego.
    // PRZ-123 C09: TwojeFaktury — własny automat z trybem (ręcznie / po wystawieniu / o godzinie), kandydaci z bazy.
    // PRZ-119.07: ekran i automat czytają ten sam stan — odłączenie wybranego programu (inFakt albo Fakturownia).
    const dostepny = () => !konfiguracjaProgramu.odlaczonyDoRestartu() && !brakTeraz();
    const automatKsef = !wysylkaKsef || !fakturyWidok ? null : tf && wbudowany ? tf.createAutomatKsefWbudowany({ db, wysylkaKsef, teraz, log: ctx.log, dostepny })
      // PRZ-121.01: zapis „brak” zatrzymuje automat OD RAZU (jedyna czynność bez człowieka); reszta — po restarcie.
      // PRZ-119.11a: profil próby Fakturowni — automat nic nie wysyła, stan „wyłączony — piaskownica”.
      : createAutomatKsef({ db, fakturyWidok, wysylkaKsef, teraz, log: ctx.log, dostepny, piaskownica: Boolean(proba) });
    const zegary: Zegar[] = [];
    if (czuwaczKsef) zegary.push(zegarKsef({ czuwacz: czuwaczKsef, puls, odstepMs: k.odstepMs, log: ctx.log }));
    if (czuwaczArchiwumSprzedazy) zegary.push(zegarArchiwumSprzedazy({ czuwacz: czuwaczArchiwumSprzedazy, odstepMs: k.odstepMs, log: ctx.log }));
    if (automatKsef) zegary.push(zegarAutomatuKsef({ automat: automatKsef, odstepMs: ODSTEP_AUTOMATU_KSEF_MS, log: ctx.log }));
    // PRZ-119.12a: niezgaszony alarm auto-KSeF Fakturowni jako zdanie alarmu — dla zdrowie() faktur i /health.
    const alarmyAutoKsef = (): string[] => {
      const wpisy = alarmAutoKsef?.wczytaj() ?? [];
      if (wpisy.length === 0) return [];
      // Bez numeru dokumentu: /health jest otwarty, a numer bywa dowolnym tekstem z Fakturowni — numery są na ekranie.
      return [`Fakturownia wysłała do KSeF ${wpisy.length} dokument(y/ów) bez zlecenia z panelu — sprawdź i kliknij „Sprawdziłem” w Ustawienia → Integracje → Fakturownia (${EKRAN_FAKTUROWNI}).`];
    };
    return { uslugi: { config, alarmyAutoKsef, infakt, programFakturowy, edycjaTwojeFaktur, ksefSprzedazy, wyborProgramu, puls, vies, faktura, fakturaHurtem, proforma, fakturyWidok, wysylkaKsef, automatKsef, celeLacznosci,
      fakturaAllegro, poNumerzeKsef, doczytanieKsef, czuwaczKsef, czuwaczArchiwumSprzedazy, paczkaDlaBiura, konfiguracjaInfaktu, konfiguracjaProgramu, konfiguracjaFakturowni,
      okres: (o: any) => przypiszDoOkresu({ ...o, db }), zapytania: fakturyDb(db), proformy: proformyDb(db), kolejkaDruku: kolejkaDruku(db),
      // PRZ-126.C05a: komputery z drukarką faktur → { podlaczone, stanowiska: [{ nazwa, at, minutTemu, aktywne }] } (karta, C05b).
      stanDrukuFaktur: () => stanStanowisk(zgloszeniaDruku(db), teraz()),
      // ZGODA-TFb/TFc: funkcje TF dla kosztów i zamówień tylko z szwem — bez niego usługi nie ma („nie istnieje”),
      // a pliki wspólne pytają leniwie w try/catch i mają bezpieczny brak.
      ...(tf ? { plikiKsefDokumentu: (uuid: string) => tf.plikiKsefDokumentu(db, uuid),
        niepewneKsefPonadDobe: (t: Date) => tf.niepewneKsefPonadDobe(db, t) } : {}) },
      trasy: (app) => {
        const usluga = (n: string) => ctx.usluga<any>('faktury', n);
        // PRZ-121.01: wybór modułu faktur w opcjach tras faktur, okresów, dokumentów i druku — zdania „faktury
        // wyłączone” dokłada w trasach A03a (do tego czasu trasy tej opcji nie czytają).
        const zWyborem = { wyborProgramu: usluga('wyborProgramu') };
        registerFakturyRoutes(app, { ...zWyborem, db: db as any, infakt: usluga('infakt'), fakturyWidok: usluga('fakturyWidok'),
          wysylkaKsef: usluga('wysylkaKsef'), czuwaczArchiwumSprzedazy: usluga('czuwaczArchiwumSprzedazy'),
          paczkaDlaBiura: usluga('paczkaDlaBiura') });
        registerOkresyRoutes(app, { ...zWyborem, db, config: usluga('config'), infakt: usluga('infakt'), vies: usluga('vies') });
        const opcje = { ...zWyborem, db, teraz, config: usluga('config'), faktura: usluga('faktura'), fakturaHurtem: usluga('fakturaHurtem'),
          proforma: usluga('proforma'), infakt: usluga('infakt'), fakturaAllegro: usluga('fakturaAllegro'),
          ksefDoczytanie: usluga('doczytanieKsef'), kartaZamowienia: () => { try { return ctx.usluga<(...a: unknown[]) => unknown>('zamowienia', 'renderujKarte'); } catch { return null; } },
          wczytajListe: (...a: unknown[]) => ctx.usluga<(...a: unknown[]) => unknown[]>('zamowienia', 'wczytajListe')(...a),
          miniaturyEkranu: (...args: unknown[]) => ctx.usluga<(...args: unknown[]) => unknown>('zamowienia', 'miniaturyEkranu')(...args) };
        registerDokumentyRoutes(app, opcje); registerDrukFakturRoutes(app, opcje);
        // PRZ-093.08: Ustawienia → Firma — ekran w module faktur (właściciel sprzedawcy na dokumentach),
        // tak jak ekran kuriera DPD siedzi w module wysyłki.
        registerUstawieniaFirmyRoutes(app, { db, adresFirmy, rachunekFirmy, nipBdoFirmy, wyborProgramu: usluga('wyborProgramu') });
        // PRZ-093.10: Ustawienia → Integracje → inFakt (wzór: ekrany kurierów w module wysyłki).
        // PRZ-119.07: automat KSeF (stary adres zapisu i adres pod programem fakturowym) — stan wybranego programu.
        registerUstawieniaInfaktuRoutes(app, { db, konfiguracjaInfaktu: usluga('konfiguracjaInfaktu'),
          konfiguracjaProgramu: usluga('konfiguracjaProgramu'), automatKsef: usluga('automatKsef'), teraz, infakt: usluga('infakt') });
        registerUstawieniaFakturowniRoutes(app, { db, konfiguracjaFakturowni: usluga('konfiguracjaFakturowni'), teraz });
        // PRZ-122.ZGODA-TFc: trasy TwojeFaktury (ekran faktury, serie, Wysyłka do KSeF) rejestruje WYŁĄCZNIE szew.
        if (tf) {
          tf.zarejestrujTrasy(app, { db, teraz, edycja: edycjaTwojeFaktur ? usluga('edycjaTwojeFaktur') : null,
            sprzedawca: sprzedawcaWbudowanego, ksefSprzedazy: usluga('ksefSprzedazy') });
        }
        // PRZ-121.02: Ustawienia → Integracje → Moduł faktur (wybór modułu; zapis tylko admin).
        registerUstawieniaProgramuRoutes(app, { db, wyborProgramu: usluga('wyborProgramu'), proba: k.proba, zgoda: zgodaTf,
          konfiguracjaInfaktu: usluga('konfiguracjaInfaktu'), konfiguracjaFakturowni, program: usluga('infakt'), kopie: () => ctx.usluga<() => any>('zdrowie', 'kopie')(),
          restart: { tryb: k.restartZPanelu, zakoncz: fabryki.zakonczProces ?? zakonczProcesDomyslnie, log: ctx.log } });
        if (resetDemoDostepny({ proba: k.proba, restart: k.restartZPanelu })) {
          registerResetDemoRoutes(app, { db, wyborProgramu, nipTeraz, teraz,
            numerDemo: (tf ? () => tf.nastepnyNumerDemo(db, teraz()) : null) as any,
            restart: { zakoncz: fabryki.zakonczProces ?? zakonczProcesDomyslnie } });
        }
      }, zegary,
      zdrowie: () => {
        const ocena = ocenZdrowie({ teraz: teraz(), startAt: puls.startAt,
          ksefWlaczony: Boolean(czuwaczKsef) && Object.keys(wszyscyKlienci).length > 0, pulsKsef: (puls.stan().czuwaczKsef ?? null) as any });
        // PRZ-121.01: zdania o konfiguracji są uwagami i nie zmieniają `ok`.
        // PRZ-119.12a: auto-KSeF jest alarmem i zmienia `ok`; /health dokłada go sam (usługa `alarmyAutoKsef`).
        const wylaczoneZdanie = zdanieBrakuProgramu(wybor);
        if (wylaczoneZdanie) ocena.uwagi.push(wylaczoneZdanie);
        else if (!infakt) {
          ocena.uwagi.push(fakturowniaWybrana
            ? `Fakturownia nie jest skonfigurowana — wpisz domenę konta i token API w Ustawienia → Integracje → Fakturownia (${EKRAN_FAKTUROWNI}); faktury ruszą po ponownym uruchomieniu OMS-u.`
            : 'Fakturowanie inFakt nie jest skonfigurowane.');
        }
        // Zmiana czeka na restart — tylko gdy to wybór człowieka (pierwszy klucz bez wyboru ma swój ekran, jak dotąd).
        const zapisany = regula();
        if (zapisany.zrodlo !== 'domyslny') {
          const czeka = zdanieCzekaniaNaRestart(wybor, zapisany, { gotowy: gotowoscProgramu(zapisany.program) });
          if (czeka) ocena.uwagi.push(czeka);
        }
        ocena.alarmy.push(...alarmyAutoKsef());
        ocena.ok = ocena.alarmy.length === 0;
        return ocena;
      },
    };
  },
};
}
export const modulFaktury = createModulFaktury();

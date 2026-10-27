import type { ModulOms, Srodowisko, Zegar } from '../../core/kontrakty.ts';
import { wczytajSprzedawce } from '../../core/sprzedawca.ts';
import { createPuls } from '../../core/puls.js';
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
import { createCzuwaczKsef, NAJDLUZSZY_PRZEBIEG_MS, najdluzszyPrzebiegMs } from './services/czuwacz-ksef.js';
import {
  createCzuwaczArchiwumSprzedazy, NAJDLUZSZY_PRZEBIEG_ARCHIWUM_SPRZEDAZY_MS, najdluzszyPrzebiegArchiwumSprzedazyMs,
} from './services/czuwacz-archiwum-sprzedazy.js';
import { przypiszDoOkresu } from './services/okres.js';
import { createZapytania as fakturyDb } from './db/faktury.js';
import { createZapytania as proformyDb } from './db/proformy.js';
import { createZapytania as kolejkaDruku } from './db/kolejka-druku-faktur.js';
import { registerFakturyRoutes } from './trasy/faktury.js';
import { registerOkresyRoutes } from './trasy/okresy.js';
import { registerDokumentyRoutes } from './trasy/dokumenty.js';
import { registerDrukFakturRoutes } from './trasy/druk.js';
import { registerUstawieniaFirmyRoutes } from './trasy/ustawienia-firma.js';
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
import { registerUstawieniaProgramuRoutes, trybRestartu } from './trasy/ustawienia-programu.js';
import { bladOperatora } from '../../domena/bledy.js';
import { opcjeKlientaInfakt } from '../../domena/konfiguracja-infakt.js';
import { programInfakt } from '../../integracje/programy/infakt.ts';
import { sprawdzProgramFakturowy } from '../../integracje/program-fakturowy.ts';
import { wyborZPliku, wybierzProgram, jawnyBrak, zdanieBrakuProgramu, zdanieCzekaniaNaRestart } from '../../domena/wybor-programu.js';
import { wczytajWyborProgramu } from '../../oms/db/wybor-programu.js';

export const ODSTEP_FAKTUR_MS = 3600000;

export function wczytajFaktury(env: Srodowisko) {
  // PRZ-121.01: moduł faktur z pliku — zła wartość (literówka, moduł „wkrótce”) = odmowa startu z nazwą zmiennej.
  const programZPliku = wyborZPliku(env.OMS_PROGRAM_FAKTUROWY);
  const adresInfaktuZPliku = skonfigurowanyUrl(env.INFAKT_API_URL, 'INFAKT_API_URL');
  const sprzedawca = wczytajSprzedawce(env);
  const katalog = env.OMS_PROFORMY_KATALOG?.trim();
  if (!katalog) throw new Error('OMS_PROFORMY_KATALOG: wymagany katalog proform');
  // Harmonogram źródła: raz na godzinę, aby nie ominąć nocnego okna archiwum.
  const odstepMs = ODSTEP_FAKTUR_MS;
  if (NAJDLUZSZY_PRZEBIEG_MS >= odstepMs || NAJDLUZSZY_PRZEBIEG_ARCHIWUM_SPRZEDAZY_MS >= odstepMs) {
    throw new Error('Budżet czuwacza KSeF lub archiwum sprzedaży nie mieści się między tyknięciami zegara.');
  }
  // PRZ-093.08: adres z pliku; w zbuduj dokłada się adres z Ustawień (config.adresFirmy), gdy pliku nie ma.
  const nadawca = adresFirmyZEnv(env);
  // PRZ-093.10: archiwum sprzedaży (katalog na serwerze) tylko z pliku — także przy kluczu z Ustawień.
  const archiwum = env.INFAKT_ARCHIWUM?.trim() || null;
  // `infakt` — kształt sprzed PRZ-093.10, tylko z pliku (.env wygrywa w całości); `infaktUstawien` — co z pliku
  // dotyczy klucza z ekranu Ustawienia → Integracje → inFakt (adres z pliku go NIE dotyczy, archiwum tak).
  return { proforma: { ...sprzedawca, katalog }, nadawca,
    infakt: env.INFAKT_API_KEY ? { apiKey: env.INFAKT_API_KEY, baseUrl: env.INFAKT_API_URL || undefined,
      archiwum } : null, infaktUstawien: { archiwum, adresWPliku: Boolean(adresInfaktuZPliku) },
    odstepMs, proba: efektywnyTryb(env) === 'proba', programZPliku,
    // PRZ-121.06: przycisk „Uruchom OMS ponownie” — `tak` / `atrapa` (demo); inna wartość = bez przycisku, nie błąd startu.
    restartZPanelu: trybRestartu(env.OMS_RESTART_Z_PANELU) };
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
const FABRYKI_ATRAP = ['createInfaktClient', 'createVies', 'programFakturowy'];

export function createModulFaktury({ fabryki = {} }: { fabryki?: Record<string, (...args: any[]) => any> } = {}): ModulOms<ReturnType<typeof wczytajFaktury>> {
return {
  nazwa: 'faktury', wersja: '1.0.0', wymaga: ['rdzen', 'kanaly', 'web'],
  kluczeIntegracji: [...integracje.infakt.kluczeIntegracji, ...integracje.allegro.kluczeIntegracji],
  konfiguracja: wczytajFaktury, migracje: [],
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
    const kanaly = ctx.usluga<Record<string, any>>('kanaly', 'klienciKanalow');
    const adresFirmy = zrodloAdresuFirmy({ db, zPliku: k.nadawca });
    // PRZ-102.20: rachunek i bank z bieżącej konfiguracji (plik → Ustawienia → Firma → brak) — proforma i maile płatnicze
    // (config kopiowany do wiadomości) czytają go przy każdym użyciu; `proforma.rachunek` zostaje wartością z pliku.
    // Źródło nie trzyma stanu (czyta bazę przy każdym wywołaniu), więc własna instancja = ta sama odpowiedź co usługa rdzenia.
    const rachunekFirmy = zrodloRachunkuFirmy({ db, zPliku: k.proforma });
    // PRZ-108.10: NIP i BDO tak samo (każde pole osobno: plik → Ustawienia → Firma → brak), czytane przy każdym dokumencie,
    // fakturze WDT i zapytaniu VIES; `proforma.nip` / `.bdo` zostają wartościami z pliku.
    const nipBdoFirmy = zrodloNipuIBdoFirmy({ db, zPliku: k.proforma });
    const nipTeraz = () => nipBdoFirmy.biezacy().nip;
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
      infaktGotowy: gotowy() });
    const wybor = regula();
    // ⛔ Jawny „brak” (plik albo Ustawienia): NIE powstaje żaden program ani klient — ani z pliku, ani pośrednik
    // z Ustawień, ani atrapa, ani szew próby; fabryk się nie woła. Usługi zależne są `null` jak dziś bez inFaktu.
    // „Brak” domyślny (nic nie wybrano i nic nie ma) składa się jak przed zmianą — z pośrednikiem pierwszego podłączenia.
    const wylaczone = jawnyBrak(wybor);
    const wyborProgramu = { program: wybor.program, zrodlo: wybor.zrodlo, uwaga: wybor.uwaga,
      teraz: regula, gotowy, czekaNaRestart: () => regula().program !== wybor.program };
    const brakTeraz = () => wylaczone || jawnyBrak(regula());
    const infaktUstawien = k.infakt || wylaczone ? null : infaktZUstawien({ wczytaj: zapisKlucza,
      fabryka: k.proba ? odmowaInfaktuWProbie : createInfaktClient });
    // Wybór źródła jak dla klienta; na zewnątrz modułu wychodzi wyłącznie adres, nigdy klucz API. Przy „brak” — nic.
    const celeLacznosci = () => {
      if (brakTeraz()) return { infakt: null };
      const zapis = infaktUstawien ? zapisKlucza() : null;
      return { infakt: infaktUstawien ? (zapis ? { baseUrl: opcjeKlientaInfakt(zapis).baseUrl } : null)
        : k.infakt ? { baseUrl: k.infakt.baseUrl } : null };
    };
    const zUstawienPrzyStarcie = Boolean(!fabryki.createInfaktClient && infaktUstawien && zapisKlucza());
    const programZFabryki = !wylaczone && fabryki.programFakturowy ? fabryki.programFakturowy({ db, teraz }) : null;
    const infakt = wylaczone ? null : programZFabryki ?? (fabryki.createInfaktClient ? fabryki.createInfaktClient({ db, teraz })
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
    const programFakturowy = programZFabryki ? sprawdzProgramFakturowy(programZFabryki)
      : !infakt ? null
      : fabryki.createInfaktClient ? programInfakt(infakt)
      : sprawdzProgramFakturowy(programInfakt(infakt));
    // Strażnik budżetu z limitów WYBRANEGO programu (stały strażnik inFaktu zostaje w wczytajFaktury).
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
    const archiwum = k.infakt ? k.infakt.archiwum : zUstawienPrzyStarcie ? (k.infaktUstawien?.archiwum ?? null) : null;
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
          const czeka = jawnyBrak(obecny) ? null : zdanieCzekaniaNaRestart(wybor, obecny, { gotowy: gotowy() });
          throw bladOperatora(czeka ? `${czeka} Nic nie poszło do programu.`
            : zdanieBrakuProgramu(jawnyBrak(obecny) ? obecny : wybor, 'Nic nie poszło do programu.'), { status: 400 });
        }
        if (fabryki.createInfaktClient) return infakt.sprawdzPolaczenie();
        if (!infaktUstawien) throw bladOperatora('inFakt jest ustawiony w pliku konfiguracji — ten ekran go nie sprawdza.');
        return infaktUstawien.sprawdzPolaczenie();
      },
      // Pierwsze podłączenie: usługi faktur nie powstały przy starcie. Odłączenie: usługi zostają do restartu, ale odmawiają.
      wymagaRestartu: () => !jawnyBrak(regula()) && !infakt && Boolean(infaktUstawien && zapisKlucza()),
      odlaczonyDoRestartu: () => zUstawienPrzyStarcie && !zapisKlucza(),
    };
    // PRZ-093.10: inFakt z Ustawień w trybie próby bez atrapy VIES — odmowa zamiast prawdziwego VIES (wcześniej ta
    // kombinacja nie istniała: tryb próby odmawia startu z INFAKT_API_KEY, więc bez atrapy inFaktu nie było).
    const vies = !infakt ? null : fabryki.createVies ? fabryki.createVies({ db })
      : k.proba && zUstawienPrzyStarcie ? odmowaViesWProbie()
      : createVies({ nipSprzedawcy: nipTeraz, fetchImpl: undefined });
    const faktura = infakt ? createFaktura({ db, infakt, vies: vies as any, nipSprzedawcy: nipTeraz }) : null;
    const fakturaHurtem = faktura ? createFakturaHurtem({ faktura }) : null;
    const proforma = createProforma({ db, config, teraz });
    const paczkaDlaBiura = infakt ? paczkaBiuraDlaTras(() => ctx.usluga('koszty', 'paczkaDlaBiura')) : null;
    const fakturyWidok = infakt ? createFakturyWidok({ db, infakt }) : null;
    const wysylkaKsef = infakt && fakturyWidok ? createWysylkaKsef({ db, infakt, fakturyWidok }) : null;
    const fakturaAllegro = infakt && Object.keys(kanaly).length ? createFakturaAllegro({ db, infakt, klienciKanalow: kanaly }) : null;
    const poNumerzeKsef = createPoNumerzeKsef({ db, fakturaAllegro: fakturaAllegro as any });
    const doczytanieKsef = infakt ? createDoczytanieKsef({ db, infakt, poNumerzeKsef: poNumerzeKsef as any }) : null;
    const czuwaczKsef = infakt && Object.keys(kanaly).length ? (fabryki.createCzuwacz ?? createCzuwaczKsef)({ db, infakt, klienciKanalow: kanaly, fakturaAllegro: fakturaAllegro as any }) : null;
    const czuwaczArchiwumSprzedazy = infakt && archiwum ? (fabryki.createCzuwaczArchiwumSprzedazy ?? createCzuwaczArchiwumSprzedazy)({ db, infakt, katalogArchiwum: archiwum, teraz }) : null;
    // PRZ-102.12: automat wysyłki do KSeF o godzinie z Ustawień — tylko na tych samych usługach co przycisk
    // (fakturyWidok + wysylkaKsef). Bez inFaktu przy starcie nie ma ani usług, ani automatu; ekran mówi dlaczego.
    const automatKsef = wysylkaKsef && fakturyWidok ? createAutomatKsef({ db, fakturyWidok, wysylkaKsef, teraz, log: ctx.log,
      // PRZ-121.01: zapis „brak” zatrzymuje automat OD RAZU (jedyna czynność bez człowieka); reszta — po restarcie.
      dostepny: () => !konfiguracjaInfaktu.odlaczonyDoRestartu() && !brakTeraz() }) : null;
    const zegary: Zegar[] = [];
    if (czuwaczKsef) zegary.push(zegarKsef({ czuwacz: czuwaczKsef, puls, odstepMs: k.odstepMs, log: ctx.log }));
    if (czuwaczArchiwumSprzedazy) zegary.push(zegarArchiwumSprzedazy({ czuwacz: czuwaczArchiwumSprzedazy, odstepMs: k.odstepMs, log: ctx.log }));
    if (automatKsef) zegary.push(zegarAutomatuKsef({ automat: automatKsef, odstepMs: ODSTEP_AUTOMATU_KSEF_MS, log: ctx.log }));
    return { uslugi: { config, infakt, programFakturowy, wyborProgramu, puls, vies, faktura, fakturaHurtem, proforma, fakturyWidok, wysylkaKsef, automatKsef, celeLacznosci,
      fakturaAllegro, poNumerzeKsef, doczytanieKsef, czuwaczKsef, czuwaczArchiwumSprzedazy, paczkaDlaBiura, konfiguracjaInfaktu,
      okres: (o: any) => przypiszDoOkresu({ ...o, db }), zapytania: fakturyDb(db), proformy: proformyDb(db), kolejkaDruku: kolejkaDruku(db) },
      trasy: (app) => {
        const usluga = (n: string) => ctx.usluga<any>('faktury', n);
        // PRZ-121.01: wybór modułu faktur w opcjach tras faktur, okresów, dokumentów i druku — zdania „faktury
        // wyłączone” dokłada w trasach A03a (do tego czasu trasy tej opcji nie czytają).
        const zWyborem = { wyborProgramu: usluga('wyborProgramu') };
        registerFakturyRoutes(app, { ...zWyborem, db: db as any, infakt: usluga('infakt'), fakturyWidok: usluga('fakturyWidok'),
          wysylkaKsef: usluga('wysylkaKsef'), czuwaczArchiwumSprzedazy: usluga('czuwaczArchiwumSprzedazy'),
          paczkaDlaBiura: usluga('paczkaDlaBiura') });
        registerOkresyRoutes(app, { ...zWyborem, db, config: usluga('config'), infakt: usluga('infakt'), vies: usluga('vies') });
        const opcje = { ...zWyborem, db, config: usluga('config'), faktura: usluga('faktura'), fakturaHurtem: usluga('fakturaHurtem'),
          proforma: usluga('proforma'), infakt: usluga('infakt'), fakturaAllegro: usluga('fakturaAllegro'),
          ksefDoczytanie: usluga('doczytanieKsef'),
          wczytajListe: (...a: unknown[]) => ctx.usluga<(...a: unknown[]) => unknown[]>('zamowienia', 'wczytajListe')(...a),
          miniaturyEkranu: (...args: unknown[]) => ctx.usluga<(...args: unknown[]) => unknown>('zamowienia', 'miniaturyEkranu')(...args) };
        registerDokumentyRoutes(app, opcje); registerDrukFakturRoutes(app, opcje);
        // PRZ-093.08: Ustawienia → Firma — ekran w module faktur (właściciel sprzedawcy na dokumentach),
        // tak jak ekran kuriera DPD siedzi w module wysyłki.
        registerUstawieniaFirmyRoutes(app, { db, adresFirmy, rachunekFirmy, nipBdoFirmy });
        // PRZ-093.10: Ustawienia → Integracje → inFakt (wzór: ekrany kurierów w module wysyłki).
        registerUstawieniaInfaktuRoutes(app, { db, konfiguracjaInfaktu: usluga('konfiguracjaInfaktu'),
          automatKsef: usluga('automatKsef'), teraz, infakt: usluga('infakt') });
        // PRZ-121.02: Ustawienia → Integracje → Moduł faktur (wybór modułu; zapis tylko admin).
        registerUstawieniaProgramuRoutes(app, { db, wyborProgramu: usluga('wyborProgramu'),
          konfiguracjaInfaktu: usluga('konfiguracjaInfaktu'), program: usluga('infakt'),
          restart: { tryb: k.restartZPanelu, zakoncz: fabryki.zakonczProces ?? zakonczProcesDomyslnie, log: ctx.log } });
      }, zegary,
      zdrowie: () => {
        const ocena = ocenZdrowie({ teraz: teraz(), startAt: puls.startAt,
          ksefWlaczony: Boolean(czuwaczKsef), pulsKsef: (puls.stan().czuwaczKsef ?? null) as any });
        // PRZ-121.01: jawny „brak” — zdanie o wyłączonych fakturach; inaczej stary tekst znak w znak. Uwagi, nie alarmy:
        // /health i jego `ok` się nie zmieniają.
        const wylaczoneZdanie = zdanieBrakuProgramu(wybor);
        if (wylaczoneZdanie) ocena.uwagi.push(wylaczoneZdanie);
        else if (!infakt) ocena.uwagi.push('Fakturowanie inFakt nie jest skonfigurowane.');
        // Zmiana czeka na restart — tylko gdy to wybór człowieka (pierwszy klucz bez wyboru ma swój ekran, jak dotąd).
        const zapisany = regula();
        if (zapisany.zrodlo !== 'domyslny') {
          const czeka = zdanieCzekaniaNaRestart(wybor, zapisany, { gotowy: gotowy() });
          if (czeka) ocena.uwagi.push(czeka);
        }
        return ocena;
      },
    };
  },
};
}
export const modulFaktury = createModulFaktury();

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
import { createCzuwaczKsef, NAJDLUZSZY_PRZEBIEG_MS } from './services/czuwacz-ksef.js';
import { createCzuwaczArchiwumSprzedazy, NAJDLUZSZY_PRZEBIEG_ARCHIWUM_SPRZEDAZY_MS } from './services/czuwacz-archiwum-sprzedazy.js';
import { przypiszDoOkresu } from './services/okres.js';
import { createZapytania as fakturyDb } from './db/faktury.js';
import { createZapytania as proformyDb } from './db/proformy.js';
import { createZapytania as kolejkaDruku } from './db/kolejka-druku-faktur.js';
import { registerFakturyRoutes } from './trasy/faktury.js';
import { registerOkresyRoutes } from './trasy/okresy.js';
import { registerDokumentyRoutes } from './trasy/dokumenty.js';
import { registerDrukFakturRoutes } from './trasy/druk.js';
import { registerUstawieniaFirmyRoutes } from './trasy/ustawienia-firma.js';
import { zegarKsef, zegarArchiwumSprzedazy } from './zegary.ts';
import { paczkaBiuraDlaTras } from './paczka-biura.ts';
import { skonfigurowanyUrl } from '../../core/konfiguracja-wartosci.ts';
import { efektywnyTryb } from '../../core/tryb.ts';
import { adresFirmyZEnv } from '../../core/adres-firmy.ts';
import { zrodloAdresuFirmy } from '../../oms/db/adres-firmy.js';
import { wczytajKonfiguracjeIntegracji } from '../../oms/db/konfiguracja-integracji.js';
import { infaktZUstawien, odmowaInfaktuWProbie, odmowaViesWProbie } from './infakt-ustawien.ts';
import { registerUstawieniaInfaktuRoutes } from './trasy/ustawienia-infakt.js';
import { bladOperatora } from '../../domena/bledy.js';
import { opcjeKlientaInfakt } from '../../domena/konfiguracja-infakt.js';

export const ODSTEP_FAKTUR_MS = 3600000;

export function wczytajFaktury(env: Srodowisko) {
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
    odstepMs, proba: efektywnyTryb(env) === 'proba' };
}

// PRZ-076: atrapy piaskownicy (deploy/proba/atrapy) wchodzą WYŁĄCZNIE tymi dwiema fabrykami i wyłącznie w trybie
// próby. (createCzuwacz* niżej to szwy testów sprzed PRZ-076 — nie podmieniają klienta inFaktu ani VIES.)
// Odmowa tutaj, a nie tylko w start.mjs piaskownicy: pomyłka w składaniu produkcji ma zatrzymać start, a nie
// wystawiać faktury w atrapie zamiast w inFakcie.
const FABRYKI_ATRAP = ['createInfaktClient', 'createVies'];

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
    { dzial: 'sprzedaz', grupa: 'obsluga', etykieta: 'Rozliczenia', adres: '/okresy', uprawnienie: 'okresy', kolejnosc: 40 }],
  zbuduj: (ctx) => {
    const { db, konfiguracja: k, teraz } = ctx;
    const atrapy = FABRYKI_ATRAP.filter((n) => fabryki[n]);
    if (atrapy.length && !k.proba) throw new Error(`Fabryki ${atrapy.join(', ')} (atrapy piaskownicy) wolno podać tylko z OMS_TRYB=proba`);
    const kanaly = ctx.usluga<Record<string, any>>('kanaly', 'klienciKanalow');
    const adresFirmy = zrodloAdresuFirmy({ db, zPliku: k.nadawca });
    const config = { ...ctx.usluga<any>('kanaly', 'config'), proforma: k.proforma, infakt: k.infakt, nadawca: k.nadawca,
      adresFirmy: adresFirmy.adres };
    const puls = createPuls({ teraz });
    // PRZ-093.10: inFakt z Ustawień (wiersz „infakt” w konfiguracja_integracji) — tylko gdy plik nie ma INFAKT_API_KEY
    // (.env wygrywa w całości; wtedy ścieżka niżej jest identyczna jak przed zmianą). Pośrednik czyta zapis przy każdym
    // żądaniu (zmiana klucza bez restartu); usługi faktur powstają z nim tylko, gdy zapis był w bazie przy starcie.
    // Piaskownica bez atrapy dostaje odmowę zamiast prawdziwego klienta; z atrapą — zawsze atrapę (gałąź pierwsza).
    const wczytajInfakt = () => wczytajKonfiguracjeIntegracji(db, 'infakt');
    const infaktUstawien = k.infakt ? null : infaktZUstawien({ wczytaj: wczytajInfakt,
      fabryka: k.proba ? odmowaInfaktuWProbie : createInfaktClient });
    // Wybór źródła jak dla klienta; na zewnątrz modułu wychodzi wyłącznie adres, nigdy klucz API.
    const celeLacznosci = () => {
      const zapis = infaktUstawien ? wczytajInfakt() : null;
      return { infakt: infaktUstawien ? (zapis ? { baseUrl: opcjeKlientaInfakt(zapis).baseUrl } : null)
        : k.infakt ? { baseUrl: k.infakt.baseUrl } : null };
    };
    const zUstawienPrzyStarcie = Boolean(!fabryki.createInfaktClient && infaktUstawien && wczytajInfakt());
    const infakt = fabryki.createInfaktClient ? fabryki.createInfaktClient({ db, teraz })
      : k.infakt ? createInfaktClient({ ...k.infakt, fetchImpl: undefined })
      : zUstawienPrzyStarcie ? infaktUstawien : null;
    const archiwum = k.infakt ? k.infakt.archiwum : zUstawienPrzyStarcie ? (k.infaktUstawien?.archiwum ?? null) : null;
    const konfiguracjaInfaktu = {
      zEnv: Boolean(k.infakt), adresWPliku: Boolean(k.infaktUstawien?.adresWPliku),
      archiwumWPliku: Boolean(k.infaktUstawien?.archiwum),
      sprawdzPolaczenie: async () => {
        if (fabryki.createInfaktClient) return infakt.sprawdzPolaczenie();
        if (!infaktUstawien) throw bladOperatora('inFakt jest ustawiony w pliku konfiguracji — ten ekran go nie sprawdza.');
        return infaktUstawien.sprawdzPolaczenie();
      },
      // Pierwsze podłączenie: usługi faktur nie powstały przy starcie. Odłączenie: usługi zostają do restartu, ale odmawiają.
      wymagaRestartu: () => !infakt && Boolean(infaktUstawien && wczytajInfakt()),
      odlaczonyDoRestartu: () => zUstawienPrzyStarcie && !wczytajInfakt(),
    };
    // PRZ-093.10: inFakt z Ustawień w trybie próby bez atrapy VIES — odmowa zamiast prawdziwego VIES (wcześniej ta
    // kombinacja nie istniała: tryb próby odmawia startu z INFAKT_API_KEY, więc bez atrapy inFaktu nie było).
    const vies = !infakt ? null : fabryki.createVies ? fabryki.createVies({ db })
      : k.proba && zUstawienPrzyStarcie ? odmowaViesWProbie()
      : createVies({ nipSprzedawcy: k.proforma.nip, fetchImpl: undefined });
    const faktura = infakt ? createFaktura({ db, infakt, vies: vies as any, nipSprzedawcy: k.proforma.nip }) : null;
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
    const zegary: Zegar[] = [];
    if (czuwaczKsef) zegary.push(zegarKsef({ czuwacz: czuwaczKsef, puls, odstepMs: k.odstepMs, log: ctx.log }));
    if (czuwaczArchiwumSprzedazy) zegary.push(zegarArchiwumSprzedazy({ czuwacz: czuwaczArchiwumSprzedazy, odstepMs: k.odstepMs, log: ctx.log }));
    return { uslugi: { config, infakt, puls, vies, faktura, fakturaHurtem, proforma, fakturyWidok, wysylkaKsef, celeLacznosci,
      fakturaAllegro, poNumerzeKsef, doczytanieKsef, czuwaczKsef, czuwaczArchiwumSprzedazy, paczkaDlaBiura, konfiguracjaInfaktu,
      okres: (o: any) => przypiszDoOkresu({ ...o, db }), zapytania: fakturyDb(db), proformy: proformyDb(db), kolejkaDruku: kolejkaDruku(db) },
      trasy: (app) => {
        const usluga = (n: string) => ctx.usluga<any>('faktury', n);
        registerFakturyRoutes(app, { db: db as any, infakt: usluga('infakt'), fakturyWidok: usluga('fakturyWidok'),
          wysylkaKsef: usluga('wysylkaKsef'), czuwaczArchiwumSprzedazy: usluga('czuwaczArchiwumSprzedazy'),
          paczkaDlaBiura: usluga('paczkaDlaBiura') });
        registerOkresyRoutes(app, { db, config: usluga('config'), infakt: usluga('infakt'), vies: usluga('vies') });
        const opcje = { db, config: usluga('config'), faktura: usluga('faktura'), fakturaHurtem: usluga('fakturaHurtem'),
          proforma: usluga('proforma'), infakt: usluga('infakt'), fakturaAllegro: usluga('fakturaAllegro'),
          ksefDoczytanie: usluga('doczytanieKsef'),
          wczytajListe: (...a: unknown[]) => ctx.usluga<(...a: unknown[]) => unknown[]>('zamowienia', 'wczytajListe')(...a),
          miniaturyEkranu: (...args: unknown[]) => ctx.usluga<(...args: unknown[]) => unknown>('zamowienia', 'miniaturyEkranu')(...args) };
        registerDokumentyRoutes(app, opcje); registerDrukFakturRoutes(app, opcje);
        // PRZ-093.08: Ustawienia → Firma — ekran w module faktur (właściciel sprzedawcy na dokumentach),
        // tak jak ekran kuriera DPD siedzi w module wysyłki.
        registerUstawieniaFirmyRoutes(app, { db, adresFirmy });
        // PRZ-093.10: Ustawienia → Integracje → inFakt (wzór: ekrany kurierów w module wysyłki).
        registerUstawieniaInfaktuRoutes(app, { db, konfiguracjaInfaktu: usluga('konfiguracjaInfaktu') });
      }, zegary,
      zdrowie: () => {
        const ocena = ocenZdrowie({ teraz: teraz(), startAt: puls.startAt,
          ksefWlaczony: Boolean(czuwaczKsef), pulsKsef: (puls.stan().czuwaczKsef ?? null) as any });
        if (!infakt) ocena.uwagi.push('Fakturowanie inFakt nie jest skonfigurowane.');
        return ocena;
      },
    };
  },
};
}
export const modulFaktury = createModulFaktury();

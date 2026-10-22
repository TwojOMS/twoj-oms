import type { ModulOms } from '../../core/kontrakty.ts';
import { wczytajSprzedawce, type DaneSprzedawcy } from '../../core/sprzedawca.ts';
import { zrodloRachunkuFirmy } from '../../oms/db/rachunek-firmy.js';
import { zrodloNipuIBdoFirmy } from '../../oms/db/nip-bdo-firmy.js';
import { migracjaBaseline, KLUCZE_UPRAWNIEN_W_DNIU_ZAMROZENIA } from './migracje/baseline.ts';
import { oznaczKluczeZamrozenia } from '../../core/uprawnienia.ts';
import { migracjaWersjaHasla } from './migracje/0003-wersja-hasla.ts';
import { migracjaKartProduktow } from './migracje/0004-karty-produktow.ts';
import { migracjaStanowMagazynowych } from './migracje/0005-stany-magazynowe.ts';
import { migracjaKonfiguracjiIntegracji } from './migracje/0006-konfiguracja-integracji.ts';
import { migracjaTerminuWysylkiRecznego } from './migracje/0007-termin-wysylki-reczny.ts';

export const modulRdzen: ModulOms<{ sprzedawca: DaneSprzedawcy }> = {
  nazwa: 'rdzen', wersja: '1.0.0', wymaga: [],
  konfiguracja: (env) => ({ sprzedawca: wczytajSprzedawce(env) }),
  migracje: [
    migracjaBaseline,
    { numer: 2, nazwa: 'klucze uprawnień w dniu zamrożenia', wykonaj: (db) => oznaczKluczeZamrozenia(db, KLUCZE_UPRAWNIEN_W_DNIU_ZAMROZENIA, () => new Date()) },
    migracjaWersjaHasla,
    migracjaKartProduktow,
    migracjaStanowMagazynowych,
    migracjaKonfiguracjiIntegracji,
    migracjaTerminuWysylkiRecznego,
  ],
  uprawnienia: [], menu: [],
  // PRZ-102.20: `rachunekFirmy` — JEDNO źródło rachunku i banku dla maili, proform i WzA: plik (OMS_RACHUNEK/OMS_BANK)
  // → Ustawienia → Firma → brak, czytane przy każdym użyciu. `sprzedawca.rachunek` to wyłącznie wartość z pliku.
  // PRZ-108.10: `nipBdoFirmy` — to samo dla NIP-u i BDO (każde pole osobno: plik → Ustawienia → Firma → brak).
  // `sprzedawca.nip` / `.bdo` to wyłącznie wartości z pliku (null, gdy pusto).
  zbuduj: (ctx) => ({ uslugi: { sprzedawca: ctx.konfiguracja.sprzedawca,
    rachunekFirmy: zrodloRachunkuFirmy({ db: ctx.db, zPliku: ctx.konfiguracja.sprzedawca }),
    nipBdoFirmy: zrodloNipuIBdoFirmy({ db: ctx.db, zPliku: ctx.konfiguracja.sprzedawca }) } }),
};

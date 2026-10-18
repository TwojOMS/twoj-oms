import type { ModulOms } from '../../core/kontrakty.ts';
import { wczytajSprzedawce, type DaneSprzedawcy } from '../../core/sprzedawca.ts';
import { migracjaBaseline, KLUCZE_UPRAWNIEN_W_DNIU_ZAMROZENIA } from './migracje/baseline.ts';
import { oznaczKluczeZamrozenia } from '../../core/uprawnienia.ts';
import { migracjaWersjaHasla } from './migracje/0003-wersja-hasla.ts';
import { migracjaKartProduktow } from './migracje/0004-karty-produktow.ts';
import { migracjaStanowMagazynowych } from './migracje/0005-stany-magazynowe.ts';
import { migracjaKonfiguracjiIntegracji } from './migracje/0006-konfiguracja-integracji.ts';

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
  ],
  uprawnienia: [], menu: [],
  zbuduj: (ctx) => ({ uslugi: { sprzedawca: ctx.konfiguracja.sprzedawca } }),
};

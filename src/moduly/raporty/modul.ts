import type { ModulOms } from '../../core/kontrakty.ts';
import type { DefinicjaKanalu } from '../kanaly/konfiguracja.ts';
import { wczytajRaportyDlaKanalow, type KonfiguracjaRaportow } from './konfiguracja.ts';
import { zarejestrujTrasyRaportow } from './trasy/raporty.js';
import { zarejestrujTrasyStatystyk } from './trasy/statystyki.js';
import { zarejestrujTrasyFinansow } from './trasy/finanse.js';

/** Raporty i Finanse używają istniejących danych oraz ręcznego zapisu miesiąca. Moduł nie buduje klientów integracji. */
export function createModulRaporty(definicje: readonly DefinicjaKanalu[]): ModulOms<KonfiguracjaRaportow> { return {
  nazwa: 'raporty', wersja: '1.0.0', wymaga: ['rdzen', 'web', 'kanaly'],
  konfiguracja: env => wczytajRaportyDlaKanalow(env, definicje), migracje: [],
  uprawnienia: [
    { klucz: 'raporty', etykieta: 'Raporty', role: ['administrator', 'sprzedaz'] },
    { klucz: 'statystyki', etykieta: 'Statystyki', role: ['administrator', 'sprzedaz'] },
    { klucz: 'finanse', etykieta: 'Finanse', role: ['administrator'] },
  ],
  menu: [
    { dzial: 'analizy-cele', grupa: 'analizy-cele', etykieta: 'Raporty', adres: '/raporty', uprawnienie: 'raporty', kolejnosc: 10 },
    { dzial: 'analizy-cele', grupa: 'analizy-cele', etykieta: 'Statystyki', adres: '/statystyki', uprawnienie: 'statystyki', kolejnosc: 20 },
    { dzial: 'analizy-cele', grupa: 'analizy-cele', etykieta: 'Finanse', adres: '/finanse', uprawnienie: 'finanse', kolejnosc: 50 },
  ],
  zbuduj: ctx => ({
    uslugi: { config: ctx.konfiguracja, opcjeTras: { db: ctx.db, config: ctx.konfiguracja } },
    trasy: app => {
      const opcje = { ...ctx.usluga<{ db: typeof ctx.db; config: KonfiguracjaRaportow }>('raporty', 'opcjeTras'),
        config: ctx.usluga<KonfiguracjaRaportow>('raporty', 'config') };
      zarejestrujTrasyRaportow(app, opcje);
      zarejestrujTrasyStatystyk(app, opcje);
      zarejestrujTrasyFinansow(app, opcje);
    },
  }),
};
}
export const modulRaporty = createModulRaporty([]);

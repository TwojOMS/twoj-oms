import type { ModulOms } from '../../core/kontrakty.ts';
import { registerZwrotyRoutes } from './trasy/rejestracja.js';
import { registerFormularzRoutes } from './trasy/formularz.js';
import { registerAkcjeRoutes } from './trasy/akcje.js';
import { registerKorektyRoutes } from './trasy/korekty.js';
import { createKorekta } from './services/korekta.js';

// Klient należy do faktur; zwroty budują wyłącznie usługę domenową korekt.
export const modulZwroty: ModulOms = {
  nazwa: 'zwroty', wersja: '1.0.0', wymaga: ['rdzen', 'web', 'faktury'],
  konfiguracja: () => ({}), migracje: [], menu: [],
  uprawnienia: [{ klucz: 'zwroty-zamowienia', etykieta: 'Obsługa zwrotu i korekty',
    role: ['administrator', 'sprzedaz', 'produkcja'] }],
  zbuduj: (ctx) => {
    const infakt = ctx.usluga<any>('faktury', 'infakt');
    const korekta = infakt ? createKorekta({ db: ctx.db, infakt }) : null;
    return { uslugi: { korekta }, trasy: (app) => {
      const definicje = ctx.usluga<any>('faktury', 'config').definicje;
      const opcje = { db: ctx.db, definicje, korekta: ctx.usluga<any>('zwroty', 'korekta') };
      registerZwrotyRoutes(app, { db: ctx.db, definicje });
      registerFormularzRoutes(app, opcje);
      registerAkcjeRoutes(app, opcje);
      registerKorektyRoutes(app, opcje);
    } };
  },
};

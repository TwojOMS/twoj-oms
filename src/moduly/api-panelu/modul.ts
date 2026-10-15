import type { ModulOms } from '../../core/kontrakty.ts';
import { trasaApiZamowieniaZKarty } from './trasy/api-zamowienia-z-karty.js';
import { trasaApiSprzedaz } from './trasy/api-sprzedaz.js';

/** API panelu indywidualnego i raportów; te same usługi co interfejs OMS. */
export const modulApiPanelu: ModulOms<null> = {
  nazwa: 'api-panelu', wersja: '1.0.0',
  wymaga: ['rdzen', 'web', 'kanaly', 'faktury', 'zamowienia'],
  konfiguracja: () => null,
  migracje: [], uprawnienia: [], menu: [],
  zbuduj: ctx => ({
    zegary: [],
    trasy: app => {
      trasaApiZamowieniaZKarty(app, {
        db: ctx.db,
        config: ctx.usluga<any>('kanaly', 'config'),
        proforma: ctx.usluga<any>('faktury', 'proforma'),
        syncSklep: ctx.usluga<any>('zamowienia', 'syncSklep'),
      });
      trasaApiSprzedaz(app, { db: ctx.db });
    },
  }),
};

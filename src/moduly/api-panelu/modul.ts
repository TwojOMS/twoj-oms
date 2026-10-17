import type { ModulOms } from '../../core/kontrakty.ts';
import { trasaApiZamowieniaZKarty } from './trasy/api-zamowienia-z-karty.js';
import { trasaApiSprzedaz } from './trasy/api-sprzedaz.js';
import { kanalIndywidualnyWlaczony } from '../kanaly/klasyfikacja.ts';

/** API panelu indywidualnego i raportów; te same usługi co interfejs OMS. */
export const modulApiPanelu: ModulOms<{ kanalIndywidualny: boolean }> = {
  nazwa: 'api-panelu', wersja: '1.0.0',
  wymaga: ['rdzen', 'web', 'kanaly', 'faktury', 'zamowienia'],
  // PRZ-089: bez panelu zamówień indywidualnych trasa z karty odmawia (OMS_KANAL_INDYWIDUALNY).
  konfiguracja: env => ({ kanalIndywidualny: kanalIndywidualnyWlaczony(env) }),
  migracje: [], uprawnienia: [], menu: [],
  zbuduj: ctx => ({
    zegary: [],
    trasy: app => {
      trasaApiZamowieniaZKarty(app, {
        db: ctx.db,
        config: ctx.usluga<any>('kanaly', 'config'),
        proforma: ctx.usluga<any>('faktury', 'proforma'),
        syncSklep: ctx.usluga<any>('zamowienia', 'syncSklep'),
        kanalIndywidualny: ctx.konfiguracja.kanalIndywidualny,
      });
      trasaApiSprzedaz(app, { db: ctx.db });
    },
  }),
};

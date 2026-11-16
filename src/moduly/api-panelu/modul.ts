import type { ModulOms } from '../../core/kontrakty.ts';
import { trasaApiZamowieniaZKarty } from './trasy/api-zamowienia-z-karty.js';
import { kanalIndywidualnyWlaczony } from '../kanaly/klasyfikacja.ts';

/** API panelu indywidualnego (zamówienia z karty); te same usługi co interfejs OMS. */
export const modulApiPanelu: ModulOms<{ kanalIndywidualny: boolean }> = {
  nazwa: 'api-panelu', wersja: '1.0.0',
  wymaga: ['rdzen', 'web', 'kanaly', 'faktury', 'zamowienia'],
  // Bez panelu zamówień indywidualnych trasa z karty odmawia (OMS_KANAL_INDYWIDUALNY).
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
        opcjeZw: ctx.usluga<any>('zamowienia', 'opcjeZw'),
        kanalIndywidualny: ctx.konfiguracja.kanalIndywidualny,
      });
    },
  }),
};

import { migracjaZalacznikow } from './migracje/0001-zalaczniki.ts';
import type { ModulOms, Zegar } from '../../core/kontrakty.ts';
import type { DaneSprzedawcy } from '../../core/sprzedawca.ts';
import { konfiguracjaWiadomosci } from './konfiguracja.ts';
import { utworzUslugiWiadomosci, type FabrykiWiadomosci, type UslugiWiadomosci } from './uslugi.ts';
import { zegarPolleraWiadomosci, zegarCzuwaczaFormulki } from './zegary.ts';
import { registerKlienciRoutes } from './trasy/klienci.js';
import { registerWiadomosciRoutes } from './trasy/wiadomosci.js';

export { utworzUslugiWiadomosci } from './uslugi.ts';

export function createModulWiadomosci({ fabryki = {}, uslugi }: {
  fabryki?: FabrykiWiadomosci; uslugi?: UslugiWiadomosci;
} = {}): ModulOms<ReturnType<typeof konfiguracjaWiadomosci>> {
  return {
    nazwa: 'wiadomosci', wersja: '1.0.0', wymaga: ['rdzen', 'web', 'kanaly', 'faktury'], migracje: [migracjaZalacznikow],
    konfiguracja: konfiguracjaWiadomosci, kluczeIntegracji: ['SMTP_USER', 'SMTP_PASS'],
    uprawnienia: [
      { klucz: 'wiadomosci', etykieta: 'Wiadomości', role: ['administrator', 'sprzedaz'] },
      { klucz: 'klienci', etykieta: 'Stali klienci', role: ['administrator', 'sprzedaz'] },
    ],
    menu: [
      { dzial: 'sprzedaz', grupa: 'obsluga', etykieta: 'Wiadomości', adres: '/wiadomosci', uprawnienie: 'wiadomosci', kolejnosc: 60 },
      { dzial: 'sprzedaz', grupa: 'obsluga', etykieta: 'Stali klienci', adres: '/klienci', uprawnienie: 'klienci', kolejnosc: 50 },
    ],
    zbuduj: ctx => {
      // Faktury posiadają dane dokumentów; jawny sprzedawca pochodzi z rdzenia.
      // Zamówienia są konsumentem wiadomości, więc GUS pobieramy dopiero w fazie tras.
      const u: UslugiWiadomosci = uslugi ?? utworzUslugiWiadomosci({
        db: ctx.db, config: { ...ctx.usluga<object>('kanaly', 'config'),
          ...ctx.usluga<object>('faktury', 'config'), ...ctx.konfiguracja,
          sprzedawca: ctx.usluga<DaneSprzedawcy>('rdzen', 'sprzedawca') },
        klienciKanalow: ctx.usluga('kanaly', 'klienciKanalow'),
        tokenyKanalow: ctx.usluga('kanaly', 'tokenyKanalow'),
        proforma: ctx.usluga('faktury', 'proforma'), infakt: ctx.usluga('faktury', 'infakt'),
        teraz: ctx.teraz, fabryki,
      });
      // Te same dwa argumenty frozen dochodzą do loggera rzeczywistego produktu.
      const log = ctx.log;
      const zegary: Zegar[] = [];
      if (u.pollerWiadomosci) zegary.push(zegarPolleraWiadomosci({ pollerWiadomosci: u.pollerWiadomosci, log }));
      if (u.czuwaczFormulki) zegary.push(zegarCzuwaczaFormulki({ czuwaczFormulki: u.czuwaczFormulki, log }));
      return { uslugi: u, zegary, trasy: app => {
        const klienci = ctx.usluga<Record<string, any>>('wiadomosci', 'klienciWiadomosci');
        registerWiadomosciRoutes(app, { db: ctx.db, klienci });
        const gus = Object.hasOwn(u, 'gus') ? u.gus : ctx.usluga('zamowienia', 'gus');
        registerKlienciRoutes(app, { db: ctx.db, gus: gus as any });
      } };
    },
  };
}

export const modulWiadomosci = createModulWiadomosci();

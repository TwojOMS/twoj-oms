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
import { migracjaDokumentuProgramu } from './migracje/0008-dokument-programu.ts';
import { migracjaKolejkiDrukuProform } from './migracje/0009-kolejka-druku-proform.ts';
import { migracjaKluczyApi } from './migracje/0010-klucze-api.ts';
import { migracjaKartApi } from './migracje/0011-karty-api.ts';
import { migracjaTresciKart } from './migracje/0012-tresc-kart.ts';
import { migracjaBleduTresci } from './migracje/0013-blad-tresci.ts';
import { migracjaAiZdjec } from './migracje/0014-ai-zdjec.ts';
import { migracjaKurierska } from './migracje/0015-kurierska.ts';
import { migracjaSlownikowKart } from './migracje/0016-slowniki-kart.ts';
import { migracjaStanowOtwarciaLustra } from './migracje/0017-stany-otwarcia-lustro.ts';
import { migracjaCenZakupu } from './migracje/0018-ceny-zakupu.ts';
import { migracjaCenKanalowKart } from './migracje/0019-ceny-kanalow-kart.ts';
import { migracjaProducentow } from './migracje/0020-producenci.ts';
import { migracjaProguNiskiegoStanu } from './migracje/0021-prog-niskiego-stanu.ts';
export const modulRdzen: ModulOms<{ sprzedawca: DaneSprzedawcy }> = {
  nazwa: 'rdzen',
  wersja: '1.0.0',
  wymaga: [],
  konfiguracja: (env) => ({ sprzedawca: wczytajSprzedawce(env) }),
  migracje: [
    migracjaBaseline,
    {
      numer: 2,
      nazwa: 'klucze uprawnień w dniu zamrożenia',
      wykonaj: (db) => oznaczKluczeZamrozenia(db, KLUCZE_UPRAWNIEN_W_DNIU_ZAMROZENIA, () => new Date()),
    },
    migracjaWersjaHasla,
    migracjaKartProduktow,
    migracjaStanowMagazynowych,
    migracjaKonfiguracjiIntegracji,
    migracjaTerminuWysylkiRecznego,
    migracjaDokumentuProgramu,
    migracjaKolejkiDrukuProform,
    migracjaKluczyApi,
    migracjaKartApi,
    migracjaTresciKart,
    migracjaBleduTresci,
    migracjaAiZdjec,
    migracjaKurierska,
    migracjaSlownikowKart,
    migracjaStanowOtwarciaLustra,
    migracjaCenZakupu,
    migracjaCenKanalowKart,
    migracjaProducentow,
    migracjaProguNiskiegoStanu,
  ],
  uprawnienia: [],
  menu: [],
  // `rachunekFirmy` — JEDNO źródło rachunku i banku dla maili, proform i WzA: plik (OMS_RACHUNEK/OMS_BANK)
  // → Ustawienia → Firma → brak, czytane przy każdym użyciu. `sprzedawca.rachunek` to wyłącznie wartość z pliku.
  // `nipBdoFirmy` — to samo dla NIP-u i BDO (każde pole osobno: plik → Ustawienia → Firma → brak).
  // `sprzedawca.nip` / `.bdo` to wyłącznie wartości z pliku (null, gdy pusto).
  zbuduj: (ctx) => ({
    uslugi: {
      sprzedawca: ctx.konfiguracja.sprzedawca,
      rachunekFirmy: zrodloRachunkuFirmy({ db: ctx.db, zPliku: ctx.konfiguracja.sprzedawca }),
      nipBdoFirmy: zrodloNipuIBdoFirmy({ db: ctx.db, zPliku: ctx.konfiguracja.sprzedawca }),
    },
  }),
};

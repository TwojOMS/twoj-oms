import type { ModulOms } from '../../core/kontrakty.ts';
import type { DefinicjaKanalu } from '../kanaly/konfiguracja.ts';
import { wczytajRaportyDlaKanalow, type KonfiguracjaRaportow } from './konfiguracja.ts';
import { zarejestrujTrasyRaportow } from './trasy/raporty.js';
import { zarejestrujTrasyStatystyk } from './trasy/statystyki.js';
import { zarejestrujTrasyFinansow } from './trasy/finanse.js';
import { konfiguracjaZPokryciem } from './pokrycie.js';
import { zarejestrujTrasyPokrycia } from './trasy/pokrycie.js';
import { zalozGraniceDlaRaportow } from './granice-start.js';
import {listaNaZadanie,mapaNaZadanie} from '../kanaly/kolekcje-na-zadanie.ts';
import {granice} from '../../oms/db/historia-sprzedazy.js';
import type {PolaczenieKanalu} from '../kanaly/kontrakty-allegro.ts';

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
  zbuduj: ctx => {
    const kanaly=ctx.usluga<any>('kanaly','config');
    const stareReguly=ctx.konfiguracja.regulySprzedazy;
    const stareNazwy=ctx.konfiguracja.nazwyKanalow;
    const stareZrodla=ctx.konfiguracja.zrodlaKanalow;
    const pierwotneDefinicje=ctx.konfiguracja.definicje;
    const definicjeBiezace=()=>kanaly.definicje as readonly DefinicjaKanalu[];
    const reguly={...stareReguly,get klasyfikacja(){
      const baza=stareReguly.klasyfikacja,sklepy=new Map(baza.sklepy),raporty=new Set(baza.raporty);
      for(const d of definicjeBiezace())if(d.raport){sklepy.set(d.klucz,d.raport);raporty.add(d.raport);}
      return {...baza,sklepy,raporty};
    }};
    ctx.konfiguracja.regulySprzedazy=reguly;
    ctx.konfiguracja.definicje=listaNaZadanie(definicjeBiezace);
    const nazwy=()=>({
      ...Object.fromEntries(definicjeBiezace().filter(d=>d.raport&&d.etykieta).map(d=>[d.raport!,d.etykieta!])),...stareNazwy,
      ...Object.fromEntries(definicjeBiezace().filter(d=>d.typ==='allegro'&&d.raport&&d.etykieta&&d.etykieta!==(pierwotneDefinicje.find(p=>p.klucz===d.klucz)?.etykieta??d.klucz)).map(d=>[d.raport!,d.etykieta!])),
    });
    ctx.konfiguracja.nazwyKanalow=mapaNaZadanie(()=>Object.keys(nazwy()),k=>nazwy()[k]);
    ctx.konfiguracja.zrodlaKanalow=listaNaZadanie(()=>[
      ...stareZrodla,
      ...definicjeBiezace().filter(d=>!stareZrodla.some(s=>s.prefiks===d.prefiks)).map(d=>{
        const utc=kanaly.odKanalu?.(d.klucz);
        const od=utc?new Date(utc).toLocaleDateString('sv-SE',{timeZone:'Europe/Warsaw'}):'';
        return {typ:d.typ,prefiks:d.prefiks,raport:d.raport??null,od,braki:[]};
      }),
    ]);
    try {
      zalozGraniceDlaRaportow(ctx.db, ctx.konfiguracja, ctx.teraz(), tekst => ctx.log(tekst));
    } catch (e) {
      ctx.log(`raporty: granice raportów — nie udało się założyć: ${e instanceof Error ? e.message : e}`);
    }
    return {
      uslugi: { config: ctx.konfiguracja, opcjeTras: { db: ctx.db, config: ctx.konfiguracja },poAktywacjiKanalu:(k:PolaczenieKanalu)=>{
        if(k.zrodlo!=='panel')return;
        if(granice(ctx.db).has(k.raport))return;
        // Nowy raport UUID nie ma powiązanej historii. Zapis jest częścią istniejącej
        // transakcji aktywacji, więc nie uruchamia drugiego BEGIN IMMEDIATE.
        if([...ctx.konfiguracja.regulySprzedazy.klasyfikacja.konta.values()].includes(k.raport))throw new Error('Nowy kanał nie może przejąć raportu historii.');
        const od=new Date(k.odUtc).toLocaleDateString('sv-SE',{timeZone:'Europe/Warsaw'});
        const doDnia=new Date(Date.parse(od+'T00:00:00Z')-86400000).toISOString().slice(0,10);
        const stare=ctx.db.prepare('SELECT utworzone_at FROM zamowienia WHERE sklep=?').all(k.klucz) as {utworzone_at:string}[];
        if(stare.some(z=>!Number.isFinite(Date.parse(z.utworzone_at))||new Date(z.utworzone_at).toLocaleDateString('sv-SE',{timeZone:'Europe/Warsaw'})<=doDnia))throw new Error('Granica nie może wyciąć zamówień istniejącego kanału.');
        ctx.db.prepare('INSERT INTO granice_historii(kanal,do_dnia,zrodlo,uwaga) VALUES (?,?,?,?)').run(k.raport,doDnia,'oms-bez-historii','Aktywacja nowego konta Allegro');
      } },
      trasy: app => {
        const opcje = { ...ctx.usluga<{ db: typeof ctx.db; config: KonfiguracjaRaportow }>('raporty', 'opcjeTras'),
          config: ctx.usluga<KonfiguracjaRaportow>('raporty', 'config') };
        zarejestrujTrasyPokrycia(app, opcje);
        const naZadanie = { ...opcje, config: konfiguracjaZPokryciem(ctx.db, opcje.config) };
        zarejestrujTrasyRaportow(app, naZadanie);
        zarejestrujTrasyStatystyk(app, naZadanie);
        zarejestrujTrasyFinansow(app, naZadanie);
      },
    };
  },
};
}
export const modulRaporty = createModulRaporty([]);

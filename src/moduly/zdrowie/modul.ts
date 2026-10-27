import type { ModulOms, Zegar } from '../../core/kontrakty.ts';
import { ocenZdrowie } from '../../domena/zdrowie.js';
import { registerZdrowieRoutes } from './trasy.js';
import { createCzuwaczOstrzezen, NAJDLUZSZY_PRZEBIEG_OSTRZEZEN_MS } from './services/czuwacz-ostrzezen.js';
import { alarmyKonfiguracjiKanalow, alarmyNazwKanalow } from './bezpiecznik-kanalow.ts';
import { zegarOstrzezen } from './zegary.ts';
import { stanKopii, wersjaWydania } from './kopie.ts';
import { UWAGA_BRAK_RACHUNKU } from '../../domena/rachunek-firmy.js';
import { UWAGA_BRAK_NIP } from '../../domena/nip-bdo-firmy.js';

export const ODSTEP_OSTRZEZEN_MS=3600000;
export const modulZdrowie: ModulOms<{proba:boolean;kopieKatalog:string;kopiaZewnetrzna:string}> = {
  nazwa:'zdrowie',wersja:'1.0.0',wymaga:['rdzen','web','kanaly','faktury','wysylka'],
  konfiguracja:env=>{
    if(NAJDLUZSZY_PRZEBIEG_OSTRZEZEN_MS>=ODSTEP_OSTRZEZEN_MS)throw Error('Budżet czuwacza ostrzeżeń nie mieści się między tyknięciami.');
    return {proba:env.OMS_TRYB==='proba',kopieKatalog:(env.OMS_KOPIE_KATALOG??'').trim(),kopiaZewnetrzna:(env.OMS_KOPIA_ZEWNETRZNA??'').trim()};
  },migracje:[],uprawnienia:[],menu:[],
  zbuduj:ctx=>{
    // PRZ-059: wersja z obrazu klienta (/app/wydanie.json z paczki); w repo i obrazie produkcji pliku nie ma.
    const wersja=wersjaWydania(new URL('../../../wydanie.json',import.meta.url));
    const infakt=ctx.usluga<any>('faktury','infakt');
    const fakturyWidok=ctx.usluga<any>('faktury','fakturyWidok');
    const puls=ctx.usluga<any>('faktury','puls');
    const czuwaczOstrzezen=infakt?createCzuwaczOstrzezen({db:ctx.db,infakt,fakturyWidok}):null;
    // PRZ-118.08: strażnik budżetu z limitów programu, który naprawdę stoi za czuwaczem (stały strażnik inFaktu zostaje wyżej).
    if(czuwaczOstrzezen&&czuwaczOstrzezen.najdluzszyPrzebiegMs>=ODSTEP_OSTRZEZEN_MS){
      throw Error(`Budżet czuwacza ostrzeżeń z limitów programu „${czuwaczOstrzezen.program?.opis.nazwa.mianownik}” (${czuwaczOstrzezen.najdluzszyPrzebiegMs} ms) nie mieści się między tyknięciami zegara (${ODSTEP_OSTRZEZEN_MS} ms) — panel nie wstanie z tym programem.`);
    }
    // Lookup kosztów odroczony do odczytu: nie wprowadza cyklu z faktury.paczkaDlaBiura.
    const opcjonalna=<T>(modul:string,nazwa:string):T|null=>{
      try{return ctx.usluga<T>(modul,nazwa);}catch(e){
        if(e instanceof Error && e.message.startsWith(`Usługa „${modul}.${nazwa}" nie istnieje`))return null;
        throw e;
      }
    };
    const rachunekFirmy=opcjonalna<{biezacy:()=>{rachunek:string|null}}>('rdzen','rachunekFirmy');
    const nipBdoFirmy=opcjonalna<{biezacy:()=>{nip:string|null}}>('rdzen','nipBdoFirmy');
    const zdrowie=()=>{
      const config=ctx.usluga<any>('kanaly','config');
      const kurierzy=ctx.usluga<Record<string,unknown>>('wysylka','kurierzy');
      // PRZ-102.22: koszty mówią to funkcją (token z Ustawień i przełącznik modułu bez restartu); wartość — starsze składy.
      const wlaczone=opcjonalna<boolean|(()=>boolean)>('koszty','kosztyWlaczone');
      const kosztyWlaczone=typeof wlaczone==='function'?wlaczone():(wlaczone??false);
      const kosztyModulWylaczony=opcjonalna<()=>boolean>('koszty','modulWylaczony')?.()??false;
      const kosztyWlaczoneOd=opcjonalna<()=>string|null>('koszty','wlaczoneOd')?.()??null;
      const stanKosztow=opcjonalna<()=>any>('koszty','stanKosztow');
      const p=puls.stan();
      const teraz=ctx.teraz();
      const wynik=ocenZdrowie({teraz,startAt:puls.startAt,
        // JS domeny bez JSDoc inferuje [] jako never[]; ta granica jest taka jak w faktury/wysylka.
        zrodla:[...Object.keys(config.sklepy),...Object.keys(config.kanaly)] as any,
        stanyPollera:ctx.db.prepare('SELECT sklep, ostatni_przebieg_at, ostatni_blad, ostatni_blad_od_at, ostatni_blad_rodzaj, ostatni_blad_prob FROM stan_pollera').all() as any,
        ksefWlaczony:Boolean(ctx.usluga('faktury','czuwaczKsef')),pulsKsef:p.czuwaczKsef??null,
        przesylkiWlaczone:Object.keys(kurierzy).length>0,pulsPrzesylek:p.czuwaczPrzesylek??null,
        ostrzezeniaWlaczone:Boolean(czuwaczOstrzezen),pulsOstrzezen:p.czuwaczOstrzezen??null,
        kosztyWlaczone,kosztyModulWylaczony,kosztyWlaczoneOd,stanKosztow:stanKosztow?.()??null,
        kanaly:ctx.usluga<()=>any[]>('kanaly','stanyKanalow')() as any,
      });
      const alarmy=alarmyKonfiguracjiKanalow(ctx.db,config,teraz,ctx.konfiguracja.proba);
      // Podmieniamy wartości istniejących pól, zachowując ich kolejność dla monitoring.
      wynik.alarmy.push(...alarmy);
      // PRZ-102.20: bez rachunku (ani w pliku, ani w panelu) panel działa, ale maile o płatności idą bez danych do
      // przelewu, a proforma odmawia — uwaga, nie alarm: to brak ustawienia, nie awaria do budzenia czujki.
      if(rachunekFirmy&&!rachunekFirmy.biezacy().rachunek)wynik.uwagi.push(UWAGA_BRAK_RACHUNKU);
      // PRZ-108.10: tak samo NIP — bez niego proforma, specyfikacja, wywóz i faktura WDT odmawiają.
      if(nipBdoFirmy&&!nipBdoFirmy.biezacy().nip)wynik.uwagi.push(UWAGA_BRAK_NIP);
      // PRZ-059: nadzór kopii tylko tam, gdzie compose klienta ustawia OMS_KOPIE_KATALOG.
      if(ctx.konfiguracja.kopieKatalog){
        const kopie=stanKopii({katalog:ctx.konfiguracja.kopieKatalog,zewnetrzna:ctx.konfiguracja.kopiaZewnetrzna,teraz});
        wynik.alarmy.push(...kopie.alarmy);
        wynik.uwagi.push(...kopie.uwagi);
        // PRZ-062: klucz kanału niezgodny z regułą Allegro — tylko w instalacji klienta (ten sam przełącznik).
        wynik.alarmy.push(...alarmyNazwKanalow(config.definicje??[]));
      }
      wynik.ok=wynik.alarmy.length===0;
      // Na końcu odpowiedzi (umowa kolejności kluczy z czujką monitoring).
      return wersja?{...wynik,wersja}:wynik;
    };
    const zegary:Zegar[]=czuwaczOstrzezen?[zegarOstrzezen({czuwacz:czuwaczOstrzezen,puls,odstepMs:ODSTEP_OSTRZEZEN_MS,log:ctx.log})]:[];
    return {uslugi:{zdrowie,czuwaczOstrzezen},zegary,zdrowie,
      trasy:app=>registerZdrowieRoutes(app,{zdrowie})};
  },
};

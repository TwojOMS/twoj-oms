import {it,expect} from 'vitest';
import ejs from 'ejs';
import {modulKanalu} from '../../../src/domena/moduly-kanalow.ts';
const kroki=modulKanalu('allegro').konfigurator.kroki;
it('połączone konto udostępnia przegląd także bez blokady całego konta; pojedynczą blokadę można odznaczyć',async()=>{
 const html=await ejs.renderFile('src/moduly/kanaly/widoki/allegro-polaczenie.ejs',{
  k:{klucz:'allegro_polcien',nazwa:'Półcień',autoryzacja:'polaczone',pobieranie:'wlaczone',srodowisko:'produkcja',wersja:1},
  root:'/allegro',adres:'/allegro/polcien',blad:null,komunikat:null,stan:null,historia:0,diagnostyka:null,kandydat:null,device:null,oczekujacaProba:null,aplikacjaGotowa:true,zapisyZablokowane:false,kroki,numerKroku:5,krok:kroki.find(k=>k.numer===5),brakUprawnien:false,wersja:1,wartosci:{od:'2026-11-01'},dcrDostepne:false,
  przeglad:{przegladId:'fixture',kandydaci:{},niejednoznaczne:[{id:'operacja',metoda:'POST',sciezka:'/order/1/invoices'}]},
 });
 expect(html).toContain('action="/allegro/polcien/przeglad"');
 const checkbox=html.match(/<input[^>]*name="pozostaw"[^>]*>/)?.[0];
 expect(checkbox).toContain('checked');expect(checkbox).not.toContain('required');expect(html).toContain('Odznaczenie zwalnia blokadę');
});

import {afterEach,describe,it,expect,vi} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {migracjaKanalowSprzedazy} from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {createRepozytoriumKanalow} from '../../../src/moduly/kanaly/repozytorium-kanalow.ts';
import {createSklepyWoo} from '../../../src/moduly/kanaly/services/sklepy-woo.ts';
import {RAPORTY_ZASTRZEZONE} from '../../../src/moduly/kanaly/konfiguracja.ts';
const aktor={id:1,login:'admin'};
const input={nazwa:'Pracownia Półcień',adres:'https://sklep-polcien.test',ck:'ck_polcien',cs:'cs_polcien',od:'2026-10-31'};
const bazy:ReturnType<typeof openOmsDb>[]=[];
afterEach(()=>{for(const db of bazy.splice(0))db.close();});
function setup(envSklepy:any[]=[],sprawdzPolaczenie:()=>Promise<{ok:boolean;powod?:string}>=async()=>({ok:true}),pobierzBramkiPlatnosci:()=>Promise<unknown>=async()=>[{id:'cod',tytul:'Płatność przy odbiorze',nazwaWoo:'Za pobraniem',wlaczona:true}]){const db=openOmsDb();bazy.push(db);migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);const teraz=()=>new Date('2026-11-01T12:00:00Z');const repozytorium=createRepozytoriumKanalow({db,definicjeEnv:[],konfiguracjaEnv:{},teraz});const serwis=createSklepyWoo({db,repozytorium,envSklepy,teraz,tryb:'produkcja',klient:()=>({sprawdzPolaczenie,pobierzMetodyWysylki:async()=>[{instance_id:1,tytul:'Kurier DPD'}],pobierzBramkiPlatnosci})});return {db,serwis,repozytorium};}
function dane(w:any){expect(w.ok).toBe(true);return w.dane;}
describe('zarządzanie Woo',()=>{
 it.each(['sprawdz','metodyWysylki'] as const)('piaskownica blokuje %s wcześniej zapisanego sklepu przed utworzeniem klienta',async operacja=>{
  const {db,repozytorium,serwis:produkcja}=setup();
  const s=dane(produkcja.utworzSzkic(input,aktor));
  const klient=vi.fn(()=>({sprawdzPolaczenie:async()=>({ok:true}),pobierzMetodyWysylki:async()=>[],pobierzBramkiPlatnosci:async()=>[]}));
  const serwis=createSklepyWoo({db,repozytorium,klient,envSklepy:[],tryb:'proba'});
  expect(await serwis[operacja](s.klucz)).toEqual({ok:false,kod:'walidacja',komunikat:'Piaskownica nie łączy się z prawdziwymi sklepami — działa tu tylko sklep przykładowy.'});
  expect(klient).not.toHaveBeenCalled();
 });
 it('C5: nie tworzy klienta ani nie zapisuje obcego sklepu w próbie; dopuszcza adres przykładowy',async()=>{
  const {db,repozytorium}=setup();
  const klient=vi.fn(()=>({sprawdzPolaczenie:async()=>({ok:true}),pobierzMetodyWysylki:async()=>[],pobierzBramkiPlatnosci:async()=>[]}));
  const serwis=createSklepyWoo({db,repozytorium,klient,envSklepy:[],tryb:'proba',teraz:()=>new Date('2026-11-01T12:00:00Z'),przykladowySklep:adres=>adres==='https://demo.example.test'});
  const odmowa={ok:false,komunikat:'Piaskownica nie łączy się z prawdziwymi sklepami — działa tu tylko sklep przykładowy.'};
  expect(await serwis.sprawdzNowe(input)).toMatchObject(odmowa);
  expect(serwis.utworzSzkic(input,aktor)).toMatchObject(odmowa);
  expect(klient).not.toHaveBeenCalled();
  expect(db.prepare('SELECT * FROM kanaly_sklepy').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM konfiguracja_integracji WHERE integracja LIKE ?').all('woo_klucze:%')).toEqual([]);
  expect(await serwis.sprawdzNowe({...input,adres:'https://demo.example.test'})).toMatchObject({ok:true});
  expect(klient).toHaveBeenCalledTimes(1);
 });
 it('B9: wyjaśnia błędy sieci, adresu i braku API oraz podpowiada co sprawdzić',async()=>{
  const komunikaty:string[]=[];
  for(const powod of ['siec','adres','brak_api']){
   const {serwis}=setup([],async()=>({ok:false,powod}));
   const wynik=await serwis.sprawdzNowe({...input,adres:'https://example.test'});
   expect(wynik.ok).toBe(false);
   if(!wynik.ok){expect(wynik.komunikat.length).toBeGreaterThan(0);komunikaty.push(wynik.komunikat);}
  }
  expect(new Set(komunikaty).size).toBe(3);
  expect(komunikaty[0]).toContain('nie odpowiada');
  expect(komunikaty[1]).toContain('Sprawdź adres');
  expect(komunikaty[2]).toContain('WooCommerce');expect(komunikaty[2]).toContain('Sprawdź');
 });
 it('aktywuje po sprawdzeniu i ponownie wymaga sprawdzenia po zmianie kluczy',async()=>{const {serwis,repozytorium}=setup();const s0=dane(serwis.utworzSzkic(input,aktor));const s=dane(serwis.zapiszMapowanie(s0.klucz,{instancje:{},bramkiPobrania:[]},s0.wersja,aktor));dane(await serwis.sprawdz(s.klucz));const a=dane(serwis.aktywuj(s.klucz,s.wersja,aktor));expect(a).toMatchObject({autoryzacja:'polaczone',pobieranie:'wlaczone'});const b=dane(serwis.zmienKlucze(s.klucz,{ck:'ck_nowe',cs:'cs_nowe'},a.wersja,aktor));expect(repozytorium.listaTypu('woo').find(x=>x.klucz===s.klucz)).toMatchObject({autoryzacja:'brak',pobieranie:'wylaczone'});expect(serwis.aktywuj(s.klucz,b.wersja,aktor)).toMatchObject({ok:false});});
 it('odrzuca niepoprawny i zbyt duży kształt mapowania',()=>{const {serwis}=setup();const s=dane(serwis.utworzSzkic(input,aktor));for(const instancje of [{x:{metoda:'dpd',inne:'x'.repeat(100000)}},Object.fromEntries(Array.from({length:51},(_,i)=>[i,{metoda:'dpd'}]))])expect(serwis.zapiszMapowanie(s.klucz,{instancje,bramkiPobrania:[]},s.wersja,aktor)).toMatchObject({ok:false});});
 it('w razie kolizji raportu z env losuje inny bez pozostawienia szkicu',()=>{const env:any[]=[];const {serwis,repozytorium,db}=setup(env);const oryginal=repozytorium.utworzSzkicSklepu;let pierwsza=true;repozytorium.utworzSzkicSklepu=(d)=>{const w=oryginal(d);if(pierwsza&&w.ok){env.push({klucz:'env',raport:w.dane.raport});pierwsza=false;}return w;};const s=dane(serwis.utworzSzkic(input,aktor));expect(s.raport).not.toBe(env[0].raport);expect(db.prepare('SELECT * FROM kanaly_sprzedazy').all()).toHaveLength(1);});
 it('pomija również zastrzeżone identyfikatory raportu',()=>{const {serwis,repozytorium}=setup();const oryginal=repozytorium.utworzSzkicSklepu;let zastrzezony='';repozytorium.utworzSzkicSklepu=(d)=>{const w=oryginal(d);if(!zastrzezony&&w.ok){zastrzezony=w.dane.raport;RAPORTY_ZASTRZEZONE.push(zastrzezony);}return w;};try{expect(dane(serwis.utworzSzkic(input,aktor)).raport).not.toBe(zastrzezony);}finally{RAPORTY_ZASTRZEZONE.pop();}});
 it('odrzuca adres sklepu z pliku po normalizacji',()=>{const {serwis}=setup([{klucz:'woo_env',adres:'https://SKLEP-polcien.test/'}]);expect(serwis.utworzSzkic(input,aktor)).toMatchObject({ok:false,komunikat:'Ten sklep jest już w pliku konfiguracji.'});});
 it('wykrywa duplikat adresu z końcową kropką hosta',()=>{const {serwis}=setup();dane(serwis.utworzSzkic({...input,adres:'https://sklep.polcien.example'},aktor));expect(serwis.utworzSzkic({...input,adres:'https://sklep.polcien.example.'},aktor)).toMatchObject({ok:false,kod:'konflikt'});});
 it('wykrywa adres z env niezależnie od schematu',()=>{const {serwis}=setup([{klucz:'woo_env',adres:'http://sklep-polcien.test/'}]);expect(serwis.utworzSzkic(input,aktor)).toMatchObject({ok:false,kod:'konflikt'});});
 it('nie aktywuje bez sprawdzenia',()=>{const {serwis}=setup();const s=dane(serwis.utworzSzkic(input,aktor));expect(serwis.aktywuj(s.klucz,s.wersja,aktor)).toMatchObject({ok:false});});
 it('odrzuca mapowanie Allegro',()=>{const {serwis}=setup();const s=dane(serwis.utworzSzkic(input,aktor));expect(serwis.zapiszMapowanie(s.klucz,{instancje:{'1':{metoda:'allegro_one'}},bramkiPobrania:[]},s.wersja,aktor)).toMatchObject({ok:false});});
 it('odłącza i usuwa klucze, zachowując zamówienia',async()=>{const {db,serwis}=setup();const s=dane(serwis.utworzSzkic(input,aktor));db.prepare("INSERT INTO zamowienia(sklep,zrodlo_id,numer,kwota_brutto,utworzone_at) VALUES (?,1,'TEST-1','10.00','2026-11-01')").run(s.klucz);dane(serwis.odlacz(s.klucz,s.wersja,aktor));expect(db.prepare('SELECT integracja FROM konfiguracja_integracji').all()).toHaveLength(0);expect(db.prepare('SELECT * FROM zamowienia WHERE sklep=?').all(s.klucz)).toHaveLength(1);});
 it('nieudane sprawdzenie czyści datę i zwraca bezpieczny komunikat',async()=>{let ok=true;const {db,serwis}=setup([],async()=>ok?{ok:true}:{ok:false,powod:'klucze'});const s=dane(serwis.utworzSzkic(input,aktor));dane(await serwis.sprawdz(s.klucz));ok=false;const w=await serwis.sprawdz(s.klucz);expect(w).toMatchObject({ok:false,kod:'tymczasowy',komunikat:'Sklep odrzucił klucze. Sprawdź, czy skopiowałeś oba i czy klucz ma uprawnienie „Zapis/odczyt”.'});expect(db.prepare('SELECT sprawdzono_at FROM kanaly_sklepy WHERE klucz=?').get(s.klucz)).toMatchObject({sprawdzono_at:null});});
 it('odmawia operacji na sklepie z pliku',async()=>{const {serwis}=setup([{klucz:'woo_env'}]);expect(await serwis.sprawdz('woo_env')).toMatchObject({ok:false,kod:'z_pliku'});expect(serwis.zmienKlucze('woo_env',input,1,aktor)).toMatchObject({ok:false,kod:'z_pliku'});});
 it('nie ujawnia kluczy w wynikach i błędach sprawdzenia oraz zmiany kluczy',async()=>{const {serwis}=setup([],async()=>{throw new Error(input.ck+input.cs);});const wynik=serwis.utworzSzkic(input,aktor);const s=dane(wynik);const blad=await serwis.sprawdz(s.klucz);const zmiana=serwis.zmienKlucze(s.klucz,{ck:input.ck,cs:input.cs},s.wersja,aktor);expect(zmiana.ok).toBe(true);const tekst=JSON.stringify([wynik,blad,zmiana]);expect(tekst).not.toContain(input.ck);expect(tekst).not.toContain(input.cs);});
 it('odrzuca wynik sprawdzenia rozpoczętego przed zmianą kluczy',async()=>{let zakoncz!:(w:{ok:boolean})=>void;const {db,serwis}=setup([],()=>new Promise(resolve=>{zakoncz=resolve;}));const s=dane(serwis.utworzSzkic(input,aktor));const pending=serwis.sprawdz(s.klucz);dane(serwis.zmienKlucze(s.klucz,{ck:'ck_nowe',cs:'cs_nowe'},s.wersja,aktor));zakoncz({ok:true});expect(await pending).toMatchObject({ok:false,kod:'konflikt'});expect(db.prepare('SELECT sprawdzono_at FROM kanaly_sklepy WHERE klucz=?').get(s.klucz)).toMatchObject({sprawdzono_at:null});});
 it('nie ujawnia kluczy w błędach ani audycie',()=>{const {db,serwis}=setup();const s=dane(serwis.utworzSzkic(input,aktor));const blad=serwis.zapiszMapowanie(s.klucz,{instancje:{'1':{metoda:'cs_polcien'}},bramkiPobrania:[]},s.wersja,aktor);const zapis=JSON.stringify([blad,db.prepare('SELECT * FROM kanaly_audit').all()]);expect(zapis).not.toContain(input.ck);expect(zapis).not.toContain(input.cs);});
 describe('PRZ-134 pobranie: decyzja w mapowaniu',()=>{
  const ODBIOR='Odbiór osobisty i pobranie wykluczają się — pobranie inkasuje kurier, a przy odbiorze osobistym kuriera nie ma.';
  const AKTYWACJA='Najpierw zapisz krok 3 „Metody wysyłki”: zaznacz bramki płatności za pobraniem (albo żadnej, jeśli sklep nie sprzedaje za pobraniem) i kliknij „Zapisz mapowanie”.';
  const mapowanieZBazy=(db:any,k:string)=>JSON.parse((db.prepare('SELECT ustawienia_json FROM kanaly_sklepy WHERE klucz=?').get(k) as any).ustawienia_json).mapowanie;
  it('zapisuje bramki i instancję z pobraniem dokładnie',()=>{const {db,serwis}=setup();const s=dane(serwis.utworzSzkic(input,aktor));dane(serwis.zapiszMapowanie(s.klucz,{instancje:{'3':{metoda:'dpd',pobranie:true},'4':{metoda:'inpost_paczkomat'}},bramkiPobrania:['cod']},s.wersja,aktor));expect(mapowanieZBazy(db,s.klucz)).toEqual({instancje:{'3':{metoda:'dpd',pobranie:true},'4':{metoda:'inpost_paczkomat'}},poPozycji:[],bramkiPobrania:['cod']});});
  it('odrzuca pobranie przy odbiorze osobistym z tekstem D5',()=>{const {db,serwis}=setup();const s=dane(serwis.utworzSzkic(input,aktor));expect(serwis.zapiszMapowanie(s.klucz,{instancje:{'5':{metoda:'odbior_osobisty',pobranie:true}},bramkiPobrania:['cod']},s.wersja,aktor)).toMatchObject({ok:false,kod:'walidacja',komunikat:ODBIOR});expect(mapowanieZBazy(db,s.klucz)).toBeUndefined();});
  it('zły identyfikator bramki dostaje komunikat, co poprawić (PRZ-134.03k)',()=>{const {db,serwis}=setup();const s=dane(serwis.utworzSzkic(input,aktor));const w=serwis.zapiszMapowanie(s.klucz,{instancje:{'5':{metoda:'dpd',pobranie:true}},bramkiPobrania:['cod','za pobraniem']},s.wersja,aktor);expect(w).toMatchObject({ok:false,kod:'walidacja'});expect((w as any).komunikat).toContain('„za pobraniem”');expect(serwis.zapiszMapowanie(s.klucz,{instancje:{},bramkiPobrania:Array.from({length:21},(_,i)=>'b'+i)},s.wersja,aktor)).toMatchObject({ok:false,komunikat:'Za dużo bramek płatności za pobraniem — najwyżej 20.'});expect(mapowanieZBazy(db,s.klucz)).toBeUndefined();});
  it('odrzuca pobranie przy metodzie innej niż DPD i paczkomat oraz pobranie inne niż true',()=>{const {serwis}=setup();const s=dane(serwis.utworzSzkic(input,aktor));for(const m of [{metoda:'nieznana',pobranie:true},{metoda:'dpd',pobranie:'tak'},{metoda:'dpd',pobranie:1}])expect(serwis.zapiszMapowanie(s.klucz,{instancje:{'1':m},bramkiPobrania:['cod']},s.wersja,aktor)).toMatchObject({ok:false,kod:'walidacja'});});
  it('odrzuca niepoprawne, zbyt liczne, powtórzone i brakujące bramki',()=>{const {serwis}=setup();const s=dane(serwis.utworzSzkic(input,aktor));for(const bramkiPobrania of [['cod; drop'],Array.from({length:21},(_,i)=>'b'+i),['cod','cod'],[''],[1],'cod',undefined])expect(serwis.zapiszMapowanie(s.klucz,{instancje:{},bramkiPobrania} as any,s.wersja,aktor)).toMatchObject({ok:false,kod:'walidacja'});expect(dane(serwis.zapiszMapowanie(s.klucz,{instancje:{},bramkiPobrania:Array.from({length:20},(_,i)=>'b'+i)},s.wersja,aktor)).wersja).toBe(s.wersja+1);});
  it('odrzuca instancję z pobraniem przy pustej liście bramek (inaczej każde zamówienie z bramką byłoby „nieznana”)',()=>{const {serwis}=setup();const s=dane(serwis.utworzSzkic(input,aktor));expect(serwis.zapiszMapowanie(s.klucz,{instancje:{'3':{metoda:'dpd',pobranie:true}},bramkiPobrania:[]},s.wersja,aktor)).toMatchObject({ok:false,kod:'walidacja',komunikat:expect.stringContaining('bramk')});});
  it('aktywacja bez decyzji o pobraniu odmawia, z pustą listą przechodzi',async()=>{const {serwis}=setup();const s=dane(serwis.utworzSzkic(input,aktor));dane(await serwis.sprawdz(s.klucz));expect(serwis.aktywuj(s.klucz,s.wersja,aktor)).toMatchObject({ok:false,kod:'walidacja',komunikat:AKTYWACJA});const m=dane(serwis.zapiszMapowanie(s.klucz,{instancje:{'1':{metoda:'dpd'}},bramkiPobrania:[]},s.wersja,aktor));expect(dane(serwis.aktywuj(s.klucz,m.wersja,aktor))).toMatchObject({autoryzacja:'polaczone',pobieranie:'wlaczone'});});
  it('aktywacja ze starym mapowaniem bez bramkiPobrania odmawia',async()=>{const {db,serwis}=setup();const s=dane(serwis.utworzSzkic(input,aktor));db.prepare('UPDATE kanaly_sklepy SET ustawienia_json=? WHERE klucz=?').run(JSON.stringify({mapowanie:{instancje:{'1':{metoda:'dpd'}},poPozycji:[]}}),s.klucz);dane(await serwis.sprawdz(s.klucz));expect(serwis.aktywuj(s.klucz,s.wersja,aktor)).toMatchObject({ok:false,komunikat:AKTYWACJA});});
  it('odczyt metod zwraca bramki; błąd bramek nie psuje metod',async()=>{const ok=setup();const s1=dane(ok.serwis.utworzSzkic(input,aktor));expect(dane(await ok.serwis.metodyWysylki(s1.klucz))).toMatchObject({metody:[{instance_id:1}],bramki:[{id:'cod',wlaczona:true}],bladBramek:null});const zly=setup([],async()=>({ok:true}),async()=>{throw new Error('403 '+input.cs);});const s2=dane(zly.serwis.utworzSzkic(input,aktor));const w=await zly.serwis.metodyWysylki(s2.klucz);expect(w).toMatchObject({ok:true,dane:{metody:[{instance_id:1}],bramki:null,bladBramek:'Nie udało się odczytać bramek płatności ze sklepu.'}});expect(JSON.stringify(w)).not.toContain(input.cs);});
  it('sklep z pliku: odczyt, zapis i aktywacja dają z_pliku',async()=>{const {serwis}=setup([{klucz:'woo_env'}]);expect(await serwis.metodyWysylki('woo_env')).toMatchObject({ok:false,kod:'z_pliku'});expect(serwis.zapiszMapowanie('woo_env',{instancje:{},bramkiPobrania:['cod']},1,aktor)).toMatchObject({ok:false,kod:'z_pliku'});expect(serwis.aktywuj('woo_env',1,aktor)).toMatchObject({ok:false,kod:'z_pliku'});});
  it('audyt zapisu niesie liczby bramek i instancji z pobraniem, bez identyfikatorów i treści',()=>{const {db,serwis}=setup();const s=dane(serwis.utworzSzkic(input,aktor));dane(serwis.zapiszMapowanie(s.klucz,{instancje:{'3':{metoda:'dpd',pobranie:true},'4':{metoda:'dpd'}},bramkiPobrania:['cod','bramka_polcien']},s.wersja,aktor));const audyt=db.prepare('SELECT operacja FROM kanaly_audit WHERE kanal=?').all(s.klucz).map((r:any)=>r.operacja);expect(audyt).toContain('mapowanie_pobrania:bramki=2,instancje_pobranie=1');expect(JSON.stringify(audyt)).not.toContain('bramka_polcien');});
 // PRZ-134.PT9: usunąć wolno tylko sklep, z którego nic jeszcze nie pobrano
 // Decyzja kierownika: blokują tylko prawdziwe dane (zamówienia, import, produkty) i stan „połączony”; sama aktywacja
 // (generacja_importu, stan pollera bez zamówień) nie — inaczej adres aktywowanego i odłączonego sklepu zostaje zablokowany na zawsze.
 it('PT9: usuwa aktywowany i odłączony sklep bez danych razem z jego granicą historii; odmawia przy imporcie, produktach, połączeniu i dla sklepu z pliku',()=>{
  const {db,serwis}=setup([{klucz:'z-pliku',adres:'https://plik.polcien.test'}]);const s=dane(serwis.utworzSzkic(input,aktor));
  expect(serwis.blokadaUsuniecia(s.klucz)).toBeNull();
  db.prepare("UPDATE kanaly_sprzedazy SET generacja_importu=1,autoryzacja='polaczone' WHERE klucz=?").run(s.klucz);
  expect(serwis.blokadaUsuniecia(s.klucz)).toBe('Najpierw odłącz sklep, potem go usuń.');
  expect(serwis.usun(s.klucz,s.wersja,aktor)).toMatchObject({ok:false,kod:'konflikt',komunikat:'Najpierw odłącz sklep, potem go usuń.'});expect(db.prepare('SELECT count(*) n FROM kanaly_sprzedazy').get()).toMatchObject({n:1});
  db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='odlaczone' WHERE klucz=?").run(s.klucz);
  db.prepare("INSERT INTO stan_pollera(sklep,zsynchronizowane_do) VALUES (?,'2026-11-01T10:00:00Z')").run(s.klucz);
  db.prepare("INSERT INTO kanaly_blokady_zapisu(kanal,zablokowane,aktor_id,aktor_login,zmieniono_at) VALUES (?,1,1,'admin','2026-11-01')").run(s.klucz);
  db.prepare("INSERT INTO kanaly_operacje_niejednoznaczne(id,kanal,metoda,sciezka,zmieniono_at) VALUES ('op-1',?,'PUT','/x','2026-11-01')").run(s.klucz);
  const granica=db.prepare("INSERT INTO granice_historii(kanal,do_dnia,zrodlo,uwaga) VALUES (?,'2026-10-30','oms-bez-historii','test')");granica.run(s.raport);granica.run('INNY_RAPORT');
  expect(serwis.blokadaUsuniecia(s.klucz)).toBeNull();
  dane(serwis.usun(s.klucz,s.wersja,aktor));
  for(const [t,kol] of [['kanaly_sprzedazy','klucz'],['kanaly_sklepy','klucz'],['stan_pollera','sklep'],['kanaly_blokady_zapisu','kanal'],['kanaly_operacje_niejednoznaczne','kanal']])expect(db.prepare(`SELECT count(*) n FROM ${t} WHERE ${kol}=?`).get(s.klucz),t).toMatchObject({n:0});
  expect(db.prepare('SELECT kanal FROM granice_historii ORDER BY kanal').all()).toEqual([{kanal:'INNY_RAPORT'}]);
  expect(serwis.usun('z-pliku',0,aktor)).toMatchObject({ok:false,kod:'z_pliku'});expect(serwis.blokadaUsuniecia('z-pliku')).not.toBeNull();
  const t=dane(serwis.utworzSzkic(input,aktor));db.prepare('INSERT INTO produkty_sklepowe(kanal,produkt_id,nazwa,odczytane_at) VALUES (?,?,?,?)').run(t.klucz,'1','Szablon Półcień','2026-11-01');
  expect(serwis.blokadaUsuniecia(t.klucz)).toBe('Sklep ma już pobrane zamówienia — możesz go tylko odłączyć.');db.prepare('DELETE FROM produkty_sklepowe').run();
  db.prepare("INSERT INTO stan_importu_sklepu(sklep) VALUES (?)").run(t.klucz);expect(serwis.blokadaUsuniecia(t.klucz)).toBe('Sklep ma już pobrane zamówienia — możesz go tylko odłączyć.');
 });
 });
});

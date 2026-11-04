import {expect,it} from 'vitest';
import {createRequire} from 'node:module';
import {MODUL_WOO} from '../../../src/domena/modul-woo.ts';
import {stanKrokow,adresAkcji} from '../../../src/core/web/konfigurator/konfigurator.ts';
import {METODY_WYSYLKI} from '../../../src/domena/wysylka.js';
import {fmtDataCzas,fmtDataCzasKrotko} from '../../../src/domena/format-daty.js';
const ejs=createRequire(import.meta.url)('ejs') as {renderFile:(path:string,data:Record<string,unknown>)=>Promise<string>};
const render=(env=false,zmiany:Record<string,unknown>={},wartosci:Record<string,unknown>={od:'2026-11-02',ck:true,cs:true},inne:Record<string,unknown>={})=>ejs.renderFile('src/moduly/kanaly/widoki/woo-sklep.ejs',{
 k:{klucz:'woo_polcien',nazwa:'Pracownia Półcień',zrodlo:env?'env':'panel',wersja:2,odUtc:'2026-11-01T23:00:00Z',generacjaImportu:0,autoryzacja:'brak',pobieranie:'wylaczone',...zmiany},
 root:MODUL_WOO.konfigurator.sciezka,adres:MODUL_WOO.konfigurator.sciezka+'/woo_polcien',adresSklepu:'https://sklep.polcien.example',fmtDataCzas,fmtDataCzasKrotko,
 konfigurator:MODUL_WOO.konfigurator,kroki:stanKrokow(MODUL_WOO.konfigurator,{biezacy:'mapowanie',zrobione:['nazwa','klucze']}),adresAkcji,
 wartosci,formularzId:'',blad:null,komunikat:null,stan:{ostatni_przebieg_at:'2026-11-03',zsynchronizowane_do:'2026-11-02',ostatni_blad:null},
 metody:Array.from({length:4},(_,i)=>({strefa:i===3?'Pozostałe lokalizacje (0)':'Polska',instanceId:i+1,tytul:'Metoda '+(i+1),metodaWoo:i===3?'local_pickup':'flat_rate'})),
 mapowanie:{instancje:{'1':{metoda:'dpd'}}},metodyOms:METODY_WYSYLKI.filter(m=>!m.startsWith('allegro_')),etykiety:{dpd:'DPD',inpost_paczkomat:'InPost Paczkomat',odbior_osobisty:'Odbiór osobisty'},...inne,
});
it('pokazuje cztery metody, strefę 0 i wybór z mapowaniem; sekrety są puste',async()=>{
 const html=await render();for(let i=1;i<=4;i++)expect(html).toContain('Metoda '+i);expect(html).toContain('Pozostałe lokalizacje (0)');expect(html).toContain('Nie przypisuj');expect(html).toContain('local_pickup');expect(html).toContain('nieznana');
 expect(html).toMatch(/value="dpd" selected/);expect(html).toContain('autocomplete="off"');expect(html).not.toMatch(/type="password"[^>]*value=/);expect(html).toContain('zapisane');
 // PRZ-134.PT9: krok 4 szkicu widać dopiero, gdy jest bieżący
 expect(html).not.toContain('<h2>4.');expect(await render(false,{},undefined,{kroki:START})).toContain('<h2>4.');
});
it('sklep env pokazuje te same sekcje bez formularzy',async()=>{const html=await render(true);expect(html).not.toContain('<form');expect(html).toContain('ustawił administrator serwera — zmiany zgłoś jemu');expect(html).toContain('Metoda 4');for(const krok of MODUL_WOO.konfigurator.kroki)expect(html).toContain(krok.tytul.replaceAll('„','„'));});
// PRZ-134.PT9: „Aktywuj” szkicu jest w kroku 4 (karta 5 tylko dla aktywnego sklepu); przed krokiem 4 go nie ma
it('stan po polsku, „Aktywuj” w karcie 4 szkicu, jedno sprawdzenie bez zapisanych kluczy',async()=>{
 const sekcja4=(h:string)=>h.slice(h.indexOf('<h2>4.'));
 expect(await render()).not.toContain('/aktywuj');
 let html=await render(false,{},undefined,{kroki:START});expect(sekcja4(html)).toMatch(/action="[^"]*\/aktywuj"/);expect(html.slice(0,html.indexOf('<h2>4.'))).not.toContain('/aktywuj');expect(html).not.toContain('<h2>5.');
 expect(html).toContain('Sklep: nieaktywny');expect(html).toContain('Pobieranie zamówień: wyłączone');expect(html).not.toMatch(/: (brak|wylaczone|polaczone)\./);
 expect(html).not.toMatch(/action="[^"]*\/pobieranie"/);
 html=await render(false,{},{od:'2026-11-02',ck:false,cs:false});expect(html).not.toMatch(/action="[^"]*\/sprawdz"/);
 html=await render(false,{autoryzacja:'polaczone',pobieranie:'wlaczone'});expect(html).toContain('Sklep: aktywny');expect(html).toContain('Pobieranie zamówień: włączone');expect(html).not.toContain('/aktywuj');expect(html).toMatch(/action="[^"]*\/pobieranie"/);
});
it('zapisane klucze: jeden przycisk sprawdzenia w kroku 2, pomoc mówi o pustych polach',async()=>{
 const sekcja2=(h:string)=>h.slice(h.indexOf('<h2>2.'),h.indexOf('<h2>3.'));
 let s=sekcja2(await render());expect(s.match(/<button/g)).toHaveLength(1);expect(s.match(/<form/g)).toHaveLength(1);expect(s).toMatch(/action="[^"]*\/klucze"/);
 expect(s).not.toMatch(/action="[^"]*\/sprawdz"/);expect(s).toContain('Sprawdź zapisane lub nowe klucze');expect(s).toContain('Zostaw pola puste, aby sprawdzić zapisane klucze');
 expect(s).not.toMatch(/ required/);expect(s).not.toMatch(/type="password"[^>]*value=/);
 s=sekcja2(await render(false,{},{od:'2026-11-02',ck:false,cs:false}));expect(s.match(/<button/g)).toHaveLength(1);expect(s).toContain('Sprawdź połączenie');
 expect(s).not.toContain('Zostaw pola puste');expect(s.match(/ required/g)).toHaveLength(2);
});
const START=stanKrokow(MODUL_WOO.konfigurator,{biezacy:'start',zrobione:['nazwa','klucze','mapowanie']});
it('C4/C7: polskie klucze i instrukcja w kolejności formularza Woo',async()=>{
 const html=await render(false,{},{ck:false,cs:false});
 for(const etykieta of ['Klucz konsumenta (ck_…)','Tajny konsumenta (cs_…)'])expect(html).toContain(etykieta);
 expect(html).not.toMatch(/Consumer (key|secret)/i);
 const instrukcja=MODUL_WOO.konfigurator.kroki[1].instrukcja.join(' ');
 const punkty=['W polu „Opis” wpisz','W polu „Użytkownik” zostaw swoje konto administratora.','W polu „Uprawnienia” wybierz „Zapis/odczyt”.','Wygeneruj klucz API','Tajny konsumenta WooCommerce pokazuje tylko raz — skopiuj oba klucze, zanim opuścisz stronę.'];
 let poprzedni=-1;for(const punkt of punkty){const indeks=instrukcja.indexOf(punkt);expect(indeks,punkt).toBeGreaterThan(poprzedni);poprzedni=indeks;expect(html).toContain(punkt);}
});
const BRAMKI=[{id:'cod',tytul:'Za pobraniem',nazwaWoo:'Cash on delivery',wlaczona:true},{id:'bacs',tytul:'Przelew bankowy',nazwaWoo:'',wlaczona:false},{id:'platnosc_przy_odbiorze_x',tytul:'Płatność przy odbiorze',nazwaWoo:'',wlaczona:true}];
const METODY_POBRANIA=[{strefa:'Polska',instanceId:3,tytul:'Kurier DPD pobranie',metodaWoo:'flat_rate'},{strefa:'Polska',instanceId:5,tytul:'Przesyłka',metodaWoo:'flat_rate'}];
const sekcja3=(h:string)=>h.slice(h.indexOf('<h2>3.'),h.indexOf('<h2>4.'));
const wiersz=(h:string,tytul:string)=>h.split(/<tr>|<label/).find(w=>w.includes(tytul))??'';
it('PRZ-134 krok 3: kolumna „Za pobraniem”, bramki ze sklepu, cod zaznaczony tylko bez decyzji',async()=>{
 let s=sekcja3(await render(false,{},undefined,{bramki:BRAMKI,metody:METODY_POBRANIA}));
 expect(s).toContain('<th>Za pobraniem</th>');expect(s).toContain('<h3>Płatność przy odbiorze (pobranie)</h3>');
 expect(s).toContain('Zaznacz bramki płatności, przy których kurier ma pobrać pieniądze. Kwota pobrania = wartość zamówienia.');
 expect(s).toMatch(/name="bramki" value="cod" checked/);expect(s).toContain('Za pobraniem (cod)');expect(s).toContain('Przelew bankowy (bacs) — wyłączona w sklepie');
 expect(s).toContain('name="pobranie_decyzja" value="1"');expect(s).toMatch(/name="pobranie_3" value="tak"/);expect(s).not.toMatch(/name="pobranie_\d+" value="tak" checked/);
 expect(wiersz(s,'Kurier DPD pobranie')).toContain('Nazwa sugeruje pobranie');expect(wiersz(s,'Przesyłka (5)')).not.toContain('Nazwa sugeruje pobranie');
 expect(wiersz(s,'Płatność przy odbiorze (platnosc')).toContain('Nazwa sugeruje pobranie');expect(wiersz(s,'Przelew bankowy (bacs)')).not.toContain('Nazwa sugeruje pobranie');
 expect(s).toContain('Bramka z tej listy sama oznacza pobranie');expect(s).toContain('Zmiana dotyczy zamówień pobranych od teraz i tych, które zmienią się w sklepie.');
 expect(s).toContain('zamówienie trafi do OMS z metodą „nieznana” — sprawdzisz je na karcie.');expect(s).toContain('Zapisz mapowanie');
 expect(s).not.toContain('Zapisano: żadne zamówienie');expect(s).not.toContain('name="bramki_tekst"');
 // po zapisie pustej listy: nic nie zaznaczone, zdanie o braku pobrania
 s=sekcja3(await render(false,{},undefined,{bramki:BRAMKI,metody:METODY_POBRANIA,mapowanie:{instancje:{'3':{metoda:'dpd'}},bramkiPobrania:[]}}));
 expect(s).not.toMatch(/ checked/);expect(s).toContain('Zapisano: żadne zamówienie z tego sklepu nie będzie za pobraniem.');
 // zapisane: pobranie przy metodzie, bramka spoza sklepu
 s=sekcja3(await render(false,{},undefined,{bramki:BRAMKI,metody:METODY_POBRANIA,mapowanie:{instancje:{'3':{metoda:'dpd',pobranie:true}},bramkiPobrania:['bacs','stara_bramka']}}));
 expect(s).toMatch(/name="pobranie_3" value="tak" checked/);expect(s).not.toMatch(/value="cod" checked/);expect(s).toMatch(/value="bacs" checked/);
 expect(s).toMatch(/value="stara_bramka" checked/);expect(s).toContain('stara_bramka (stara_bramka) — nie ma jej już w sklepie');
});
it('PRZ-134 krok 3: bez listy bramek pole tekstowe z zapisanymi albo cod',async()=>{
 let s=sekcja3(await render(false,{},undefined,{bramki:null,bladBramek:'Nie udało się odczytać bramek płatności ze sklepu.'}));
 expect(s).toMatch(/name="bramki_tekst"[^>]*value="cod"/);expect(s).toContain('Identyfikatory bramek za pobraniem, oddzielone przecinkami');
 expect(s).toContain('Nie udało się odczytać bramek płatności ze sklepu. Identyfikator znajdziesz w WooCommerce → Ustawienia → Płatności (w adresie strony bramki po <code>section=</code>).');
 expect(s).not.toContain('name="bramki" value=');
 s=sekcja3(await render(false,{},undefined,{bramki:null,mapowanie:{instancje:{},bramkiPobrania:['cod','moja_bramka']}}));expect(s).toMatch(/name="bramki_tekst"[^>]*value="cod, moja_bramka"/);
 s=sekcja3(await render(false,{},undefined,{bramki:null,mapowanie:{instancje:{},bramkiPobrania:[]}}));expect(s).toMatch(/name="bramki_tekst"[^>]*value=""/);
});
// PRZ-134.PT9: karta 5 tylko dla aktywnego sklepu — szkic ma pasek raz (krok 3)
it('PRZ-134: pasek „Uzupełnij pobranie” w krokach 3 i 5 aktywnego sklepu, w szkicu w kroku 3; sklep z pliku pokazuje wiersz „Pobranie”',async()=>{
 const pasek=/<div class="pas-blad" role="alert"><p>Uzupełnij pobranie w kroku 3\. Do czasu zapisu żadne zamówienie z tego sklepu nie dostanie pobrania\.<\/p><\/div>/g;
 let html=await render(false,{},undefined,{bramki:BRAMKI});expect(html.match(pasek)).toHaveLength(1);expect(sekcja3(html)).toMatch(pasek);
 html=await render(false,{autoryzacja:'polaczone',pobieranie:'wlaczone'},undefined,{bramki:BRAMKI,kroki:stanKrokow(MODUL_WOO.konfigurator,{biezacy:'stan',zrobione:['nazwa','klucze','mapowanie','start']})});expect(html.match(pasek)).toHaveLength(2);
 expect(sekcja3(html)).toMatch(pasek);expect(html.slice(html.indexOf('<h2>5.'))).toMatch(pasek);
 html=await render(false,{},undefined,{bramki:BRAMKI,mapowanie:{instancje:{'1':{metoda:'dpd'}},bramkiPobrania:['cod']}});expect(html).not.toContain('Uzupełnij pobranie');
 html=await render(false,{},undefined,{bramki:BRAMKI,mapowanie:{instancje:{}}});expect(html).not.toContain('Uzupełnij pobranie');
 html=await render(true);expect(html).toContain('Pobranie: według metod wysyłki ustawionych na serwerze');expect(html).not.toContain('Uzupełnij pobranie');expect(html).not.toContain('name="bramki');
 html=await render(true,{},undefined,{mapowanie:{instancje:{'1':{metoda:'dpd'}},bramkiPobrania:['cod','cod_pl']}});expect(html).toContain('Pobranie: bramki cod, cod_pl');
});
it('PRZ-134 krok 3: sklep nieosiągalny — zapisana decyzja tylko do odczytu, bez zdania o bramkach',async()=>{
 let s=sekcja3(await render(false,{},undefined,{mapowanieBezSklepu:true,mapowanie:{instancje:{'1':{metoda:'dpd'}},bramkiPobrania:['cod','moja_bramka']}}));
 expect(s).toContain('Pobranie: bramki cod, moja_bramka');expect(s).not.toContain('Nie udało się odczytać bramek');expect(s).not.toContain('name="bramki');expect(s).not.toContain('pobranie_decyzja');
 s=sekcja3(await render(false,{},undefined,{mapowanieBezSklepu:true,mapowanie:{instancje:{'1':{metoda:'dpd'}}}}));
 expect(s).toContain('Pobranie: decyzja jeszcze niezapisana');expect(s).not.toContain('według metod wysyłki ustawionych na serwerze');
});

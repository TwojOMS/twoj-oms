import {expect,it} from 'vitest';
import {zakresDatyStartu,poczatekDniaWarszawa,poprawnaDataStartu} from '../../../src/moduly/kanaly/zakres-importu-allegro.ts';

it('granice wynikają z dnia w Warszawie, także po północy zimą i latem',()=>{
 expect(zakresDatyStartu(new Date('2026-11-03T22:30:00Z'))).toEqual({min:'2025-11-03',max:'2026-11-03'});
 expect(zakresDatyStartu(new Date('2026-11-03T23:30:00Z'))).toEqual({min:'2025-11-04',max:'2026-11-04'});
 expect(zakresDatyStartu(new Date('2026-07-03T22:30:00Z'))).toEqual({min:'2025-07-04',max:'2026-07-04'});
});

it.each([
 ['2026-03-31T10:00:00Z','2025-03-31','2026-03-31'],
 ['2024-02-29T10:00:00Z','2023-02-28','2024-02-29'],
 ['2026-02-28T10:00:00Z','2025-02-28','2026-02-28'],
 ['2026-11-03T23:30:00Z','2025-11-04','2026-11-04'],
])('zakres i walidacja mają wspólne, domknięte granice dla %s',(iso,min,max)=>{
 const teraz=new Date(iso),z=zakresDatyStartu(teraz);
 expect(z).toEqual({min,max});
 const przesun=(dzien:string,dni:number)=>{
  const data=new Date(dzien+'T12:00:00Z');
  data.setUTCDate(data.getUTCDate()+dni);
  return data.toISOString().slice(0,10);
 };
 for(const [dzien,wynik] of [[z.min,true],[z.max,true],[przesun(z.min,-1),false],[przesun(z.max,1),false]] as const){
  expect(poprawnaDataStartu(poczatekDniaWarszawa(dzien)!,teraz),dzien).toBe(wynik);
 }
});

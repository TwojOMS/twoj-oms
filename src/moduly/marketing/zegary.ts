import type {Zegar} from '../../core/kontrakty.ts';
export const ODSTEP_MARKETINGU_MS=3600000;
export function zegarKampanii({czuwaczKampanii,log}:{czuwaczKampanii:any;log:(...s:string[])=>void}):Zegar{
 return {nazwa:'czuwaczKampanii',odstepMs:ODSTEP_MARKETINGU_MS,przebieg:async()=>{
  try{const w=await czuwaczKampanii.przebieg();if(w?.pominiety)log('czuwacz kampanii: poprzedni przebieg JESZCZE TRWA — to tyknięcie przepada.');}
  catch(e){log('czuwacz kampanii:',e instanceof Error?e.message:String(e));}
 }};
}
export function zegarReklam({czuwaczReklam,log}:{czuwaczReklam:any;log:(...s:string[])=>void}):Zegar{
 return {nazwa:'czuwaczReklam',odstepMs:ODSTEP_MARKETINGU_MS,przebieg:async()=>{
  try{await czuwaczReklam.przebieg();}catch(e){log('czuwacz reklam:',e instanceof Error?e.message:String(e));}
 }};
}

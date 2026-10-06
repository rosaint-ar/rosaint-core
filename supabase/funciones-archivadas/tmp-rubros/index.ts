import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// DESACTIVADA. Cumplió su propósito (crear rubros 47-54 el 2026-07-17). Inerte.
Deno.serve(()=>new Response(JSON.stringify({ok:false,error:"función desactivada"}),{status:410,headers:{"Content-Type":"application/json"}}));

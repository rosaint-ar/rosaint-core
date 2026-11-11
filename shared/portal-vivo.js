/* ============ Rosaint Core · Portal en vivo ============
   Cuando un cliente entra al Portal profesional (rosaint.odoo.com) aparece una
   plaquita en la esquina con un sonido suave y, al tocarla, una ventanita muestra
   qué está haciendo en tiempo real (busca, agrega a «Cargar pedido», abre el
   carrito, paga) con un botón para escribirle por WhatsApp.
   También avisa cuando llega un pedido de acceso nuevo (/alta).

   De dónde sale: el bloque «rosaint-eventos» de la cabecera del portal anota cada
   paso en la tabla portal_evento (Supabase); la tabla está en supabase_realtime y
   el Core la escucha (RLS: sólo usuarios del Core). Si el canal no conecta, se
   pregunta cada 20 s. Quién es cada cliente: odoo-metricas modo "portal_vivo".
   Lo ven todos los usuarios del Core. Nunca cuenta al equipo (usuarios internos de
   Odoo) ni las cuentas de prueba de Portal profesional › Clientes (portal_excluidos).
   Una pantalla puede apagarlo con <body data-rosaint-vivo="no">.
   Copiado del portal-vivo de EyG (3/11/2026), adaptado a Rosaint (11/11/2026). */
(function(){
  if(window.RosaintPortalVivo) return;
  const VENTANA_MIN = 15;      // en línea = algo en los últimos 15 minutos
  const NUEVA_VISITA_MIN = 30; // más de 30 minutos sin nada = vuelve a "entrar"
  const ST = { ok:false, excluidos:new Set(), part:{}, vivos:{}, sel:null, abierto:false, mudo:false, ultimoId:0, audio:null };
  const LS = k=>{ try{ return localStorage.getItem(k); }catch(e){ return null; } };
  const LSset = (k,v)=>{ try{ localStorage.setItem(k,v); }catch(e){} };
  const esc = s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const arr = x=>Array.isArray(x)?x:[];
  /* "[GN500] Gel Neutro «Conductor» x 500 ml" → sin el código */
  const prod = s=>String(s||"").replace(/^\[[^\]]*\]\s*/,"").trim();
  const sinMarca = s=>String(s||"").replace(/\s*\([^)]*\)\s*$/,"").trim();
  const iniciales = s=>sinMarca(s).split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join("").toUpperCase()||"R";
  const hace = ms=>{ const m=Math.round((Date.now()-ms)/60000); return m<1?"recién":m===1?"hace 1 min":m<60?`hace ${m} min`:`hace ${Math.floor(m/60)} h`; };
  const hora = ms=>new Date(ms).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false});

  /* ---------- qué está haciendo, en palabras ---------- */
  const PAG = {inicio:["🏠","En el inicio"],cargar_pedido:["📝","En «Cargar pedido»"],catalogo:["🗂️","Recorriendo el catálogo"],
    carrito:["🛒","Abrió el carrito"],compra_datos:["🧾","Completando los datos de compra"],compra_pago:["💳","En el pago"],compra_confirmada:["✅","Confirmó el pedido"],
    mi_cuenta:["👤","En Mi cuenta"],mis_pedidos:["📦","Mirando sus pedidos"],mi_pedido:["📦","Abrió un pedido"],mis_facturas:["🧾","Mirando sus facturas"],
    mis_entregas:["🚚","Mirando sus entregas"],mis_pagos:["💵","Mirando sus pagos"],ayuda:["❓","En Ayuda"],contacto:["☎️","En Contacto"],
    login:["🔑","Iniciando sesión"],clave:["🔑","Cambiando la contraseña"],alta:["🙋","En el pedido de acceso"]};
  /* Pasos que conviene ver aunque la ventana esté cerrada: está por comprar o pide ayuda. */
  const CALIENTE = {compra_datos:1, compra_pago:1, compra_confirmada:1};
  function describir(e){
    const d=e.dato||{}, t=e.tipo;
    if(t==="pagina"){
      if(d.tipo==="resultados") return null;                              // lo cuenta la búsqueda
      if(d.tipo==="producto") return {ic:"🧴", tx:"Mirando", fuerte:prod(d.nombre)||"un producto", clave:"p"+(d.id||d.nombre)};
      if(d.tipo==="categoria") return {ic:"📂", tx:"Categoría", fuerte:d.nombre||"…", clave:"c"+d.id};
      const p=PAG[d.tipo]; if(!p) return null;
      return {ic:p[0], tx:p[1], caliente:!!CALIENTE[d.tipo], fin:d.tipo==="compra_confirmada", clave:"g"+d.tipo};
    }
    if(t==="busqueda"){ if(!d.q) return null;
      const sin=!+d.n;
      return {ic:"🔎", tx:"Buscó", fuerte:"«"+d.q+"»", nota:sin?"sin resultados":`${d.n} resultado${+d.n===1?"":"s"}`, mala:sin, q:String(d.q).toLowerCase(), clave:"b"+String(d.q).toLowerCase()}; }
    if(t==="carrito"){
      const a=d.accion||"agregar", cant=+d.cantidad>1?` × ${+d.cantidad}`:"";
      return {ic:a==="quitar"?"➖":a==="cambiar"?"✏️":"➕", tx:a==="quitar"?"Sacó del pedido":a==="cambiar"?"Cambió la cantidad de":"Agregó al pedido",
              fuerte:(prod(d.producto)||d.codigo||"un producto")+(a==="agregar"?cant:""), caliente:a==="agregar", clave:"k"+a+(d.id||d.producto)+e.ts}; }
    if(t==="alta_paso") return {ic:"🙋", tx:"Pedido de acceso", fuerte:`paso ${d.paso} de 5${d.nombre?" · "+d.nombre:""}`, clave:"a"+d.paso};
    if(t==="alta_enviada") return {ic:"🎉", tx:"Envió el pedido de acceso", caliente:true, clave:"ae"};
    if(t==="login_error") return {ic:"⚠️", tx:"No pudo entrar (usuario o contraseña)", caliente:true, mala:true, clave:"le"+e.ts};
    if(t==="descarga") return {ic:"⬇️", tx:d.doc==="factura"?"Descargó una factura":d.doc==="pedido"?"Descargó un pedido":"Descargó un documento", clave:"d"+e.ts};
    if(t==="whatsapp") return {ic:"💬", tx:"Tocó el botón de WhatsApp", caliente:true, clave:"w"+e.ts};
    return null;
  }

  /* ---------- quién es (se piden a Odoo de a varios) ---------- */
  let pendientes=[], relojPedir=null;
  function quienEs(pid){
    if(ST.part[pid]) return ST.part[pid];
    ST.part[pid]=new Promise(res=>{ pendientes.push({pid,res}); clearTimeout(relojPedir); relojPedir=setTimeout(pedirTanda,150); });
    return ST.part[pid];
  }
  async function pedirTanda(){
    const t=pendientes.splice(0,50); if(!t.length) return;
    let cs=[];
    try{ const r=await window.sb.functions.invoke("odoo-metricas",{body:{modo:"portal_vivo", ids:t.map(x=>x.pid)}}); cs=arr(r.data&&r.data.contactos); }catch(e){}
    for(const x of t){
      const c=cs.find(k=>k.id===x.pid);
      if(!c) delete ST.part[x.pid];       // se vuelve a preguntar la próxima
      x.res(c?{cuenta:c.cuenta, nom:c.nombre||"Cliente", persona:c.persona||"", ciudad:c.ciudad||"", tel:c.tel||""}:null);
    }
    if(pendientes.length) pedirTanda();
  }

  /* ---------- llegada de un movimiento ---------- */
  async function llega(e, silencio){
    if(!e) return;
    if(e.id && e.id<=ST.ultimoId && !silencio) return;
    if(e.id) ST.ultimoId=Math.max(ST.ultimoId,e.id);
    /* pedido de acceso de alguien sin cuenta: sólo la plaquita */
    if(!(e.partner_id>0)){ if(e.tipo==="alta_enviada" && !silencio) avisarAlta(); return; }
    if(ST.excluidos.has(e.partner_id)) return;
    const info=await quienEs(e.partner_id); if(!info || ST.excluidos.has(info.cuenta)) return;
    const ts=Date.parse(e.ts)||Date.now();
    let v=ST.vivos[info.cuenta];
    const nueva=!v || ts-v.ult>NUEVA_VISITA_MIN*60000;
    if(nueva){ v=ST.vivos[info.cuenta]={info, ini:ts, ult:ts, pasos:[]}; }
    v.ult=Math.max(v.ult,ts);
    const d=describir(e);
    if(d){
      d.ts=ts;
      const prev=v.pasos[0];
      /* mientras escribe: "gel", "gel neu", "gel neutro" es una sola búsqueda */
      if(prev && prev.q && d.q && ts-prev.ts<45000 && (d.q.startsWith(prev.q)||prev.q.startsWith(d.q))) v.pasos[0]=d;
      else if(prev && prev.clave===d.clave && ts-prev.ts<5*60000) prev.ts=ts;   // recargó la misma página
      else { v.pasos.unshift(d); if(v.pasos.length>80) v.pasos.length=80; d.recien=!silencio; }
    }
    if(silencio) return;
    if(nueva) avisar(v,"entra");
    else if(d && d.caliente) avisar(v,"caliente",d);
    pintar();
  }

  /* ---------- sonido: dos notas suaves que suben (y tres si está por comprar) ---------- */
  function sonar(fuerte){
    if(ST.mudo) return;
    try{
      const C=ST.audio||(ST.audio=new (window.AudioContext||window.webkitAudioContext)());
      if(C.state==="suspended") C.resume();
      const notas=fuerte?[659.25,880,1174.66]:[783.99,1174.66];
      notas.forEach((f,i)=>{
        const t=C.currentTime+i*0.11, o=C.createOscillator(), o2=C.createOscillator(), g=C.createGain(), g2=C.createGain();
        o.type="sine"; o.frequency.value=f; o2.type="triangle"; o2.frequency.value=f*2; g2.gain.value=0.18;
        o.connect(g); o2.connect(g2); g2.connect(g); g.connect(C.destination);
        g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(0.07,t+0.015); g.gain.exponentialRampToValueAtTime(0.0001,t+0.55);
        o.start(t); o2.start(t); o.stop(t+0.6); o2.stop(t+0.6);
      });
    }catch(e){}
  }
  /* el navegador no deja sonar hasta que la persona toca algo en la página */
  function desbloquearAudio(){ const f=()=>{ try{ const C=ST.audio||(ST.audio=new (window.AudioContext||window.webkitAudioContext)()); C.resume(); }catch(e){} }; ["pointerdown","keydown"].forEach(ev=>document.addEventListener(ev,f,{once:true,passive:true})); }

  /* ---------- la plaquita ---------- */
  function toast(html, hot, label, alTocar, dura){
    const pila=document.getElementById("pv-pila"); if(!pila) return;
    const n=document.createElement("button");
    n.type="button"; n.className="pv-toast"+(hot?" hot":""); n.setAttribute("aria-label",label);
    n.innerHTML=html+`<span class="pv-go" aria-hidden="true">›</span><span class="pv-bar" style="animation-duration:${dura/1000}s"></span>`;
    n.onclick=()=>{ cerrarToast(n); alTocar(); };
    pila.prepend(n);
    while(pila.children.length>3) pila.lastChild.remove();
    requestAnimationFrame(()=>n.classList.add("in"));
    n._t=setTimeout(()=>cerrarToast(n), dura);
    n.onmouseenter=()=>{ clearTimeout(n._t); n.classList.add("hold"); };
    n.onmouseleave=()=>{ n.classList.remove("hold"); n._t=setTimeout(()=>cerrarToast(n),4000); };
  }
  function avisar(v, tipo, d){
    const hot=tipo==="caliente", i=v.info;
    sonar(hot);
    toast(`<span class="pv-av"><i></i>${esc(iniciales(i.nom))}</span>
      <span class="pv-tt"><b>${esc(i.nom)}</b><small>${hot?`${esc(d.ic)} ${esc(d.tx)}${d.fuerte?" · "+esc(d.fuerte):""}`:`entró al portal${i.ciudad?" · "+esc(i.ciudad):""}`}</small></span>`,
      hot, `${i.nom}: ${hot?d.tx:"entró al portal"}. Abrir`, ()=>abrir(i.cuenta), hot?16000:11000);
  }
  function avisarAlta(){
    sonar(true);
    const root=(document.querySelector('script[src*="shared/portal-vivo.js"]')||{}).src||"";
    const url=root.replace(/shared\/portal-vivo\.js.*$/,"comercial/altas-portal.html");
    toast(`<span class="pv-av"><i></i>🙋</span><span class="pv-tt"><b>Pedido de acceso nuevo</b><small>Alguien pidió entrar al portal · ver Altas</small></span>`,
      true, "Llegó un pedido de acceso nuevo al portal. Ver Altas de clientes", ()=>{ if(url) location.href=url; }, 16000);
  }
  function cerrarToast(n){ clearTimeout(n._t); n.classList.remove("in"); n.classList.add("out"); setTimeout(()=>n.remove(),420); }

  /* ---------- el indicador y la ventanita ---------- */
  function enLinea(){ const lim=Date.now()-VENTANA_MIN*60000; return Object.values(ST.vivos).filter(v=>v.ult>=lim).sort((a,b)=>b.ult-a.ult); }
  function recientes(){ const lim=Date.now()-VENTANA_MIN*60000, lim2=Date.now()-90*60000; return Object.values(ST.vivos).filter(v=>v.ult<lim && v.ult>=lim2).sort((a,b)=>b.ult-a.ult); }
  function waLink(info){
    let d=String(info.tel||"").replace(/\D/g,""); if(!d) return "";
    d=d.replace(/^0+/,""); if(!d.startsWith("54")) d="54"+d; if(!d.startsWith("549")) d="549"+d.slice(2);
    const quien=sinMarca(info.persona||info.nom).split(/\s+/)[0]||"";
    const txt=`Hola${quien?" "+quien:""}! Te escribo de Rosaint 👋 ¿Te puedo ayudar con tu pedido?`;
    return `https://api.whatsapp.com/send?phone=${d}&text=${encodeURIComponent(txt)}`;
  }
  function pintar(){
    const dock=document.getElementById("pv-dock"); if(!dock) return;
    const L=enLinea();
    dock.classList.toggle("on", L.length>0 || ST.abierto);
    dock.innerHTML=`<span class="pv-pulso" aria-hidden="true"></span>
      <span class="pv-avs">${L.slice(0,3).map(v=>`<span class="pv-mini">${esc(iniciales(v.info.nom))}</span>`).join("")}</span>
      <span class="pv-dt"><b>${L.length}</b> ${L.length===1?"cliente":"clientes"} en el portal</span>`;
    dock.setAttribute("aria-label",`${L.length} clientes en el portal. Abrir la ventana`);
    if(ST.abierto) pintarVentana();
  }
  function pintarVentana(){
    const w=document.getElementById("pv-win"); if(!w) return;
    const L=enLinea(), R=recientes();
    if(!ST.sel || !ST.vivos[ST.sel]) ST.sel=(L[0]||R[0]||{info:{}}).info.cuenta||null;
    const v=ST.vivos[ST.sel];
    const chip=x=>`<button type="button" class="pv-chip ${x.info.cuenta===ST.sel?"sel":""} ${x.ult<Date.now()-VENTANA_MIN*60000?"off":""}" onclick="RosaintPortalVivo.ver(${x.info.cuenta})">
        <span class="pv-mini">${esc(iniciales(x.info.nom))}</span>${esc(sinMarca(x.info.nom))}</button>`;
    let cuerpo="";
    if(!v) cuerpo=`<div class="pv-vacio"><div class="pv-radar"><i></i><i></i><i></i></div><b>No hay clientes en el portal ahora</b><span>Cuando alguien entre, te aviso con una plaquita y un sonido.</span></div>`;
    else{
      const i=v.info, vivo=v.ult>=Date.now()-VENTANA_MIN*60000, ahora=v.pasos[0], wa=waLink(i);
      cuerpo=`<div class="pv-cli">
          <span class="pv-av big ${vivo?"":"off"}"><i></i>${esc(iniciales(i.nom))}</span>
          <div class="pv-cn"><b>${esc(i.nom)}</b><small>${esc([i.persona,i.ciudad].filter(Boolean).join(" · "))}</small>
            <small class="pv-est ${vivo?"vivo":""}">${vivo?`En el portal · entró ${hace(v.ini)}`:`Se fue ${hace(v.ult)}`}</small></div></div>
        ${ahora?`<div class="pv-ahora ${ahora.caliente?"hot":""}"><span class="pv-ic">${ahora.ic}</span><div><small>${vivo?"Ahora":"Lo último"}</small><b>${esc(ahora.tx)}${ahora.fuerte?`: <em>${esc(ahora.fuerte)}</em>`:""}</b>${ahora.nota?`<small class="${ahora.mala?"mala":""}">${esc(ahora.nota)}</small>`:""}</div></div>`:""}
        <div class="pv-acc">
          ${wa?`<a class="pv-btn wa" href="${wa}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .1-1.2c0-.1-.2-.2-.4-.3Z"/></svg>Escribirle</a>`:`<span class="pv-btn dis">Sin teléfono cargado</span>`}
        </div>
        <div class="pv-rec"><h4>Recorrido</h4>
          <ol>${v.pasos.slice(ahora?1:0,40).map(p=>`<li class="${p.recien?"nuevo":""} ${p.caliente?"hot":""}"><span class="pv-ic">${p.ic}</span><span class="pv-pt">${esc(p.tx)}${p.fuerte?`: <em>${esc(p.fuerte)}</em>`:""}${p.nota?` <small class="${p.mala?"mala":""}">· ${esc(p.nota)}</small>`:""}</span><time>${hora(p.ts)}</time></li>`).join("")||'<li class="pv-nada">Recién llega: todavía no abrió nada más.</li>'}</ol></div>`;
      v.pasos.forEach(p=>p.recien=false);
    }
    w.querySelector(".pv-body").innerHTML=
      (L.length||R.length?`<div class="pv-chips">${L.map(chip).join("")}${R.length?`<span class="pv-sep">Hace un rato</span>${R.map(chip).join("")}`:""}</div>`:"")+cuerpo;
    const m=w.querySelector(".pv-mudo"); m.textContent=ST.mudo?"🔕":"🔔"; m.title=ST.mudo?"Sonido apagado: tocá para encenderlo":"Sonido encendido: tocá para silenciar";
  }
  function abrir(cuenta){ if(cuenta) ST.sel=cuenta; ST.abierto=true; const w=document.getElementById("pv-win"); w.hidden=false; requestAnimationFrame(()=>w.classList.add("in")); pintar(); }
  function cerrar(){ ST.abierto=false; const w=document.getElementById("pv-win"); w.classList.remove("in"); setTimeout(()=>{ if(!ST.abierto) w.hidden=true; },300); pintar(); }

  function montar(){
    const css=document.createElement("style"); css.id="pv-css"; css.textContent=CSS; document.head.appendChild(css);
    const raiz=document.createElement("div"); raiz.id="pv-raiz";
    raiz.innerHTML=`<div id="pv-pila" role="status" aria-live="polite"></div>
      <section id="pv-win" hidden aria-label="Portal en vivo">
        <header><span class="pv-live"><i></i>EN VIVO</span><h3>Portal profesional</h3>
          <button type="button" class="pv-mudo" onclick="RosaintPortalVivo.mudo()"></button>
          <button type="button" class="pv-x" onclick="RosaintPortalVivo.cerrar()" aria-label="Cerrar">×</button></header>
        <div class="pv-body"></div>
      </section>
      <button type="button" id="pv-dock" onclick="RosaintPortalVivo.alternar()"></button>`;
    document.body.appendChild(raiz);
    document.addEventListener("keydown",e=>{ if(e.key==="Escape" && ST.abierto) cerrar(); });
  }

  /* ---------- arranque (lo llama shell.js con la sesión ya abierta) ---------- */
  async function start(){
    if(ST.ok || !window.sb || document.body.getAttribute("data-rosaint-vivo")==="no") return;
    ST.ok=true; ST.mudo=LS("rosaint_vivo_mudo")==="1";
    try{
      const [r, x] = await Promise.all([
        window.sb.functions.invoke("odoo-metricas",{body:{modo:"portal_vivo"}}),
        window.sb.from("portal_excluidos").select("partner_id"),
      ]);
      arr(r.data&&r.data.internos).forEach(id=>ST.excluidos.add(+id));
      arr(x.data).forEach(f=>ST.excluidos.add(+f.partner_id));
    }catch(e){}
    montar(); desbloquearAudio();
    /* lo de los últimos 90 minutos, sin sonido, para saber quién ya está adentro */
    try{
      const desde=new Date(Date.now()-90*60000).toISOString();
      const r=await window.sb.from("portal_evento").select("id,ts,partner_id,tipo,dato").gte("ts",desde).order("id",{ascending:true}).limit(1500);
      await Promise.all(arr(r.data).filter(e=>e.partner_id>0).map(e=>quienEs(e.partner_id)));
      for(const e of arr(r.data)) await llega(e,true);
    }catch(e){}
    pintar();
    escuchar();
    setInterval(()=>pintar(),30000);
  }
  function escuchar(){
    let vivo=false;
    try{
      window.sb.channel("portal-vivo-"+Math.random().toString(36).slice(2,8))
        .on("postgres_changes",{event:"INSERT",schema:"public",table:"portal_evento"},p=>llega(p.new))
        .subscribe(s=>{ if(s==="SUBSCRIBED") vivo=true; if(s==="CHANNEL_ERROR"||s==="TIMED_OUT"||s==="CLOSED") vivo=false; });
    }catch(e){}
    /* respaldo: si el canal en vivo no está, se pregunta cada 20 s lo nuevo */
    setInterval(async()=>{
      if(vivo || document.hidden) return;
      try{ const r=await window.sb.from("portal_evento").select("id,ts,partner_id,tipo,dato").gt("id",ST.ultimoId).order("id",{ascending:true}).limit(200);
        for(const e of arr(r.data)) await llega(e); }catch(e){}
    },20000);
  }

  window.RosaintPortalVivo={ start,
    ver:c=>{ ST.sel=c; pintarVentana(); },
    alternar:()=>ST.abierto?cerrar():abrir(),
    cerrar, mudo:()=>{ ST.mudo=!ST.mudo; LSset("rosaint_vivo_mudo",ST.mudo?"1":"0"); if(!ST.mudo) sonar(false); pintarVentana(); },
    _st:ST, _llega:llega };

  /* Colores de marca: azul #34495E, papel #F7F5F2, ácido #EAF46B (lo que está "caliente"), rojo #F93549 */
  const CSS=`
#pv-raiz{--pv-azul:#34495E;--pv-hondo:#24323F;--pv-papel:#F7F5F2;--pv-acido:#EAF46B;--pv-rojo:#F93549;--pv-niebla:#DDE4E8;--pv-line:#DDE4E8;--pv-gris:#5D6D7C;--pv-gris2:#8A97A3;--pv-ok:#2E8B57;
  position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:10px;font-family:'Source Sans 3',system-ui,sans-serif;pointer-events:none}
#pv-raiz>*{pointer-events:auto}
#pv-pila{display:flex;flex-direction:column;gap:8px;align-items:flex-end}
.pv-toast{position:relative;display:flex;align-items:center;gap:11px;width:300px;max-width:calc(100vw - 36px);padding:11px 14px 13px 11px;border:1px solid var(--pv-line);border-radius:10px;
  background:#fff;color:var(--pv-azul);text-align:left;cursor:pointer;overflow:hidden;font:inherit;
  box-shadow:0 2px 4px rgba(36,50,63,.06),0 14px 40px rgba(36,50,63,.2);transform:translateX(120%) scale(.96);opacity:0;
  transition:transform .55s cubic-bezier(.2,1.3,.4,1),opacity .3s,box-shadow .2s}
.pv-toast.in{transform:none;opacity:1}
.pv-toast.out{transform:translateX(60%) scale(.96);opacity:0;transition:transform .4s ease-in,opacity .35s}
.pv-toast:hover{box-shadow:0 2px 4px rgba(36,50,63,.08),0 18px 46px rgba(36,50,63,.26)}
.pv-toast:focus-visible{outline:3px solid var(--pv-azul);outline-offset:2px}
.pv-toast.hot{border-color:#C9D14A}
.pv-av{position:relative;flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:var(--pv-azul);color:#fff;font-family:'Sora',system-ui,sans-serif;font-weight:700;font-size:14px;letter-spacing:.3px}
.pv-av i{position:absolute;inset:-4px;border-radius:50%;border:2px solid var(--pv-azul);opacity:0;animation:pv-anillo 2s ease-out infinite}
.pv-toast.hot .pv-av{background:var(--pv-acido);color:var(--pv-azul)} .pv-toast.hot .pv-av i{border-color:#C9D14A}
.pv-av.off{background:#B7C2CC} .pv-av.off i{display:none}
.pv-av.big{width:48px;height:48px;font-size:16px}
@keyframes pv-anillo{0%{transform:scale(.85);opacity:.7}100%{transform:scale(1.35);opacity:0}}
.pv-tt{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.pv-tt b{font-family:'Sora',system-ui,sans-serif;font-size:13.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pv-tt small{font-size:12.5px;color:var(--pv-gris);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pv-go{flex:none;font-size:22px;line-height:1;color:var(--pv-azul);transition:transform .2s}
.pv-toast:hover .pv-go{transform:translateX(3px)}
.pv-bar{position:absolute;left:0;bottom:0;height:3px;width:100%;background:var(--pv-azul);transform-origin:left;animation:pv-tiempo 11s linear forwards}
.pv-toast.hot .pv-bar{background:#C9D14A}
.pv-toast.hold .pv-bar{animation-play-state:paused}
@keyframes pv-tiempo{from{transform:scaleX(1)}to{transform:scaleX(0)}}
#pv-dock{display:flex;align-items:center;gap:9px;padding:8px 14px 8px 10px;border:0;border-radius:999px;background:var(--pv-azul);color:#fff;font:inherit;font-size:13.5px;cursor:pointer;
  box-shadow:0 10px 28px rgba(36,50,63,.32);transform:translateY(16px) scale(.9);opacity:0;pointer-events:none;transition:transform .45s cubic-bezier(.2,1.3,.4,1),opacity .3s}
#pv-dock.on{transform:none;opacity:1;pointer-events:auto}
#pv-dock:hover{background:var(--pv-hondo)} #pv-dock:focus-visible{outline:3px solid var(--pv-acido);outline-offset:3px}
.pv-pulso{width:9px;height:9px;border-radius:50%;background:var(--pv-acido);animation:pv-late 1.8s infinite}
@keyframes pv-late{0%{box-shadow:0 0 0 0 rgba(234,244,107,.6)}70%{box-shadow:0 0 0 9px rgba(234,244,107,0)}100%{box-shadow:0 0 0 0 rgba(234,244,107,0)}}
.pv-avs{display:flex} .pv-avs .pv-mini{margin-left:-7px;border:2px solid var(--pv-azul)} .pv-avs .pv-mini:first-child{margin-left:0}
.pv-mini{display:inline-grid;place-items:center;flex:none;width:24px;height:24px;border-radius:50%;background:var(--pv-papel);color:var(--pv-azul);font-size:10px;font-weight:800}
.pv-dt b{font-weight:800}
#pv-win{width:380px;max-width:calc(100vw - 36px);max-height:min(640px,calc(100vh - 110px));display:flex;flex-direction:column;background:#fff;border:1px solid var(--pv-line);border-radius:12px;overflow:hidden;
  box-shadow:0 4px 8px rgba(36,50,63,.06),0 24px 60px rgba(36,50,63,.24);transform-origin:bottom right;transform:translateY(14px) scale(.94);opacity:0;transition:transform .4s cubic-bezier(.2,1.2,.4,1),opacity .25s}
#pv-win.in{transform:none;opacity:1}
/* Cerrada NO se dibuja: el display:flex le gana al atributo hidden y la ventanita quedaba
   invisible encima de todo, comiéndose los toques de la esquina (lección de EyG, 3/11/2026). */
#pv-win[hidden]{display:none}
#pv-win:not(.in){pointer-events:none}
#pv-win header{display:flex;align-items:center;gap:10px;padding:13px 12px 13px 16px;background:var(--pv-azul);color:#fff}
#pv-win h3{flex:1;margin:0;font-family:'Sora',system-ui,sans-serif;font-size:14.5px;font-weight:700;letter-spacing:.2px;color:#fff}
.pv-live{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:800;letter-spacing:1.4px;background:rgba(255,255,255,.14);border-radius:999px;padding:4px 9px}
.pv-live i{width:7px;height:7px;border-radius:50%;background:var(--pv-acido);animation:pv-late 1.8s infinite}
.pv-mudo,.pv-x{border:0;background:rgba(255,255,255,.14);color:#fff;width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:15px;line-height:1;font-family:inherit}
.pv-x{font-size:20px} .pv-mudo:hover,.pv-x:hover{background:rgba(255,255,255,.26)}
.pv-body{overflow:auto;padding:12px 14px 14px;overscroll-behavior:contain;color:var(--pv-azul)}
.pv-chips{display:flex;gap:6px;overflow-x:auto;padding-bottom:10px;margin-bottom:4px;border-bottom:1px solid var(--pv-line);scrollbar-width:thin}
.pv-chip{display:inline-flex;align-items:center;gap:6px;flex:none;border:1px solid var(--pv-line);background:#fff;border-radius:999px;padding:3px 10px 3px 3px;font:inherit;font-size:12.5px;font-weight:700;color:var(--pv-azul);cursor:pointer;white-space:nowrap}
.pv-chip.sel{border-color:var(--pv-azul);background:var(--pv-papel)} .pv-chip.off{color:var(--pv-gris2)} .pv-chip.off .pv-mini{background:#EEF1F3;color:var(--pv-gris2)}
.pv-sep{flex:none;align-self:center;font-size:10.5px;color:var(--pv-gris2);font-weight:700;text-transform:uppercase;letter-spacing:.6px;padding:0 2px 0 6px}
.pv-cli{display:flex;align-items:center;gap:12px;padding:10px 2px 12px}
.pv-cn{min-width:0;display:flex;flex-direction:column;gap:1px}
.pv-cn b{font-family:'Sora',system-ui,sans-serif;font-size:15.5px;font-weight:700;line-height:1.25}
.pv-cn small{font-size:12.5px;color:var(--pv-gris)}
.pv-est{color:var(--pv-gris2)!important} .pv-est.vivo{color:var(--pv-ok)!important;font-weight:700}
.pv-ahora{display:flex;gap:11px;align-items:flex-start;padding:12px 13px;border-radius:10px;background:var(--pv-papel);border:1px solid var(--pv-line);animation:pv-entra .45s cubic-bezier(.2,1.2,.4,1)}
.pv-ahora.hot{background:#F8FBD2;border-color:#DDE58A}
.pv-ahora small{display:block;font-size:10.5px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:var(--pv-gris);margin-bottom:2px}
.pv-ahora b{display:block;font-size:14px;font-weight:600;line-height:1.35} .pv-ahora em{font-style:normal;font-weight:800}
.pv-ahora small.mala,.pv-rec small.mala{color:#C42536;text-transform:none;letter-spacing:0;font-weight:700}
.pv-ic{flex:none;width:28px;height:28px;display:grid;place-items:center;border-radius:8px;background:#fff;font-size:15px}
.pv-acc{display:flex;gap:8px;margin:12px 0 4px}
.pv-btn{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 10px;border-radius:8px;border:1px solid var(--pv-line);background:#fff;color:var(--pv-azul);font-size:13.5px;font-weight:700;text-decoration:none!important;transition:background .15s,transform .15s}
.pv-btn:hover{background:var(--pv-papel);transform:translateY(-1px)}
.pv-btn.wa{background:#1FA855;border-color:#1FA855;color:#fff} .pv-btn.wa:hover{background:#178F47}
.pv-btn svg{width:16px;height:16px;fill:currentColor}
.pv-btn.dis{color:var(--pv-gris2);font-weight:600;cursor:default} .pv-btn.dis:hover{background:#fff;transform:none}
.pv-rec h4{margin:14px 0 6px;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:var(--pv-gris2)}
.pv-rec ol{list-style:none;margin:0;padding:0;position:relative}
.pv-rec ol:before{content:"";position:absolute;left:13px;top:6px;bottom:6px;width:2px;background:var(--pv-line);border-radius:2px}
.pv-rec li{position:relative;display:flex;align-items:center;gap:10px;padding:5px 0;font-size:13.5px;color:var(--pv-azul)}
.pv-rec li .pv-ic{background:var(--pv-papel);border:2px solid #fff;z-index:1;font-size:13px}
.pv-rec li.hot .pv-ic{background:#F8FBD2}
.pv-rec li.nuevo{animation:pv-entra .5s cubic-bezier(.2,1.2,.4,1)}
.pv-pt{flex:1;min-width:0;line-height:1.35} .pv-pt em{font-style:normal;font-weight:700} .pv-pt small{color:var(--pv-gris2)}
.pv-rec time{flex:none;font-size:11.5px;color:var(--pv-gris2);font-variant-numeric:tabular-nums}
.pv-nada{color:var(--pv-gris2)!important;font-size:12.5px!important;padding-left:36px!important}
@keyframes pv-entra{from{transform:translateY(-6px);opacity:0}to{transform:none;opacity:1}}
.pv-vacio{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:22px 10px 18px;color:var(--pv-gris)}
.pv-vacio b{color:var(--pv-azul);font-size:14px} .pv-vacio span{font-size:13px;max-width:260px}
.pv-radar{position:relative;width:54px;height:54px;margin-bottom:8px}
.pv-radar i{position:absolute;inset:0;border-radius:50%;border:2px solid var(--pv-azul);opacity:0;animation:pv-anillo 2.4s ease-out infinite}
.pv-radar i:nth-child(2){animation-delay:.8s} .pv-radar i:nth-child(3){animation-delay:1.6s}
.pv-radar:after{content:"";position:absolute;left:50%;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:var(--pv-azul)}
@media (max-width:600px){#pv-raiz{right:10px;bottom:10px}}
@media (prefers-reduced-motion:reduce){#pv-raiz *{animation:none!important;transition:none!important}}
@media print{#pv-raiz{display:none}}`;
})();

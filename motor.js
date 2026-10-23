// ══════════════════════════════════════════════════════════════════════
// motor.js — Motor de cálculo único de DT Models
// Lo usan nuevo_modelo.html (asistente) y modelo_financiero.html (visor).
// Cualquier cambio en la lógica financiera se hace AQUÍ, una sola vez.
//
// calcEngine(get): `get(id)` devuelve el valor (texto) de un campo del asistente
// por su id (c-monto, pl-ing-3, s-mb-0, _deuda…) o undefined si no existe.
// No toca el DOM: es una función pura de sus entradas.
// ══════════════════════════════════════════════════════════════════════

// Lee un número; usa el valor por defecto SOLO si el campo está vacío o no es número.
function numOr(get, id, def){
  const raw = get(id)
  if(raw === undefined || raw === null || String(raw).trim() === '') return def
  const v = parseFloat(raw)
  return isNaN(v) ? def : v
}

// ── Tabla mensual del crédito solicitado (abono constante a capital tras la gracia) ──
function buildMonthlyTable(monto, tasa_na, plazo, gracia){
  const tM = tasa_na/12
  const amort = Math.max(plazo - gracia, 0)
  const cuotaM = amort > 0 ? monto / amort : 0
  const rows = []
  let saldo = monto
  for(let m=1; m<=plazo; m++){
    const intM = saldo * tM
    const capM = m <= gracia ? 0 : Math.min(cuotaM, saldo)
    const cuota = intM + capM
    const saldoFin = Math.max(0, saldo - capM)
    rows.push({mes:m, saldoIni:saldo, interes:intM, capital:capM, cuota, saldoFin})
    saldo = saldoFin
    if(saldo <= 0.01) break
  }
  return rows
}

// Cronograma mensual de un crédito existente, agregado en años del modelo
// tipo 'cuota' = cuota fija (francés) · 'abono' = abono constante a capital
function scheduleDeuda(row, nYears){
  const intereses = Array(nYears).fill(0), capital = Array(nYears).fill(0)
  let saldo = parseFloat(row.saldo) || 0
  const r = (parseFloat(row.tasa) || 0) / 100 / 12
  const m = parseInt(row.plazo) || 0
  if(saldo <= 0 || m <= 0) return { intereses, capital }
  const cuotaFija = r > 0 ? saldo * r / (1 - Math.pow(1 + r, -m)) : saldo / m
  const abono = saldo / m
  for(let k = 0; k < m && k < nYears * 12; k++){
    const y = Math.floor(k / 12)
    const intM = saldo * r
    let capM = row.tipo === 'abono' ? abono : cuotaFija - intM
    if(k === m - 1) capM = saldo            // último mes cancela el saldo
    capM = Math.min(Math.max(capM, 0), saldo)
    intereses[y] += intM; capital[y] += capM
    saldo -= capM
  }
  return { intereses, capital }
}

// Suma de una lista de créditos existentes por año
function scheduleDeudaRows(rows, nYears){
  const intereses = Array(nYears).fill(0), capital = Array(nYears).fill(0)
  let saldoIni = 0
  ;(rows||[]).forEach(row => {
    saldoIni += parseFloat(row.saldo) || 0
    const s = scheduleDeuda(row, nYears)
    for(let i = 0; i < nYears; i++){ intereses[i] += s.intereses[i]; capital[i] += s.capital[i] }
  })
  return { intereses, capital, saldoIni }
}

// ── Referencia histórica: márgenes y crecimiento reales del P&L (años 1–3) ──
function getHistorico(get){
  const g = id => parseFloat(get(id))||0
  const ing = [1,2,3].map(y=>g(`pl-ing-${y}`))
  const y3 = { ing: ing[2], cv: g('pl-cv-3'), go: g('pl-go-3') }
  if(y3.ing <= 0) return null
  const mb    = (y3.ing - y3.cv) / y3.ing
  const opex  = y3.go / y3.ing
  // Crecimiento anual compuesto del histórico (año 1 → año 3)
  const cagr  = ing[0] > 0 ? Math.pow(ing[2]/ing[0], 1/2) - 1 : null
  return { mb, opex, ebitda: mb - opex, cagr }
}

// ── UMBRALES POR SECTOR (práctica de bancos y fondos de deuda) ──
// dscr: DSCR mínimo de aprobación · lev: Deuda financiera/EBITDA máxima · mEb: margen EBITDA típico [bajo, alto]
const SECTOR_UMBRALES = {
  'Agroindustrial':         { dscr:1.30, lev:3.0, mEb:[0.10,0.22] },
  'Ganadero / Pecuario':    { dscr:1.30, lev:3.0, mEb:[0.08,0.20] },
  'Manufacturero':          { dscr:1.25, lev:3.0, mEb:[0.08,0.15] },
  'Comercial':              { dscr:1.20, lev:2.5, mEb:[0.04,0.10] },
  'Servicios':              { dscr:1.25, lev:3.0, mEb:[0.10,0.20] },
  'Construcción':           { dscr:1.30, lev:3.0, mEb:[0.06,0.14] },
  'Energía':                { dscr:1.35, lev:3.5, mEb:[0.20,0.45] },
  'Tecnología':             { dscr:1.50, lev:2.0, mEb:[0.15,0.40] },
  'Logística / Transporte': { dscr:1.25, lev:3.0, mEb:[0.08,0.18] },
  'Turismo':                { dscr:1.35, lev:3.0, mEb:[0.10,0.25] },
  'Salud':                  { dscr:1.30, lev:3.0, mEb:[0.10,0.20] },
  'Otro':                   { dscr:1.30, lev:3.0, mEb:[0.08,0.20] },
}

// ── MOTOR ──
function calcEngine(get){
  const n = parseInt(get('s-horizonte'))||10
  const monto    = parseFloat(get('c-monto'))||0
  const tasa_na  = numOr(get, 'c-tasa', 14)/100
  const plazo    = parseInt(get('c-plazo'))||60
  const gracia   = parseInt(get('c-gracia'))||0
  const isr      = numOr(get, 'c-isr', 33)/100
  // PPE: valor de la tabla Capex. Si no hay tabla, la depreciación usa la histórica del último año
  // (antes suponía que el crédito compraba activos: PPE = monto ÷ 10 años).
  const ppe      = parseFloat(get('s-ppe'))||0
  const depHist  = parseFloat(get('pl-dep-3'))||0
  const ppeVida  = parseInt(get('s-ppe-vida'))||10
  const inicioIng= 1 // field removed — single disbursement assumed

  // Base revenue from last historical year — raw value, no multiplier
  const baseIng = parseFloat(get('pl-ing-3'))||0
  const baseIng2 = baseIng > 0 ? baseIng : 0

  // Build projections
  const ingresos=[], costos=[], opex=[], ebitda=[], depreciacion=[], otrosIng=[], gfVig=[]
  let ingActual = baseIng2
  // Supuesto del año i: usa el valor de ese año si existe (el visor permite hasta 10 años);
  // si no, el del año 5 (el asistente captura 5 años).
  const sup = (k, i, def) => {
    const own = get(`${k}-${i}`)
    return numOr(get, (own!==undefined && String(own).trim()!=='') ? `${k}-${i}` : `${k}-${Math.min(i,4)}`, def)
  }
  for(let i=0;i<n;i++){
    const gIng  = sup('s-ing',  i, 10)/100
    const gMB   = sup('s-mb',   i, 40)/100
    const gOpex = sup('s-opex', i, 20)/100
    // Ingreso absoluto del año (calculadora del visor) o crecimiento sobre el año anterior
    const ingAbs = parseFloat(get(`p-ing-${i}`))||0
    ingActual = ingAbs > 0 ? ingAbs : ingActual*(1+gIng)
    // Ramp-up: if inicio > 1 month, first year partial
    const ramp = inicioIng <= 1 ? 1 : (i===0 ? 0 : i===1 ? 0.5 : 1)
    const ing = ingActual * ramp
    const cv  = ing * (1 - gMB)
    const op  = ing * gOpex
    // Use capex table total dep if available, else fallback to ppe/vida
    const capexDepTotal = parseFloat(get('s-ppe-dep-total')) || 0
    const depAbs = get(`p-dep-${i}`)
    const dep = (depAbs!==undefined && String(depAbs).trim()!=='') ? (parseFloat(depAbs)||0)
              : capexDepTotal > 0 ? capexDepTotal : (ppe > 0 && ppeVida > 0 ? ppe / ppeVida : depHist)
    otrosIng.push(parseFloat(get(`p-oi-${i}`))||0)      // otros ingresos no operacionales (visor)
    gfVig.push(parseFloat(get(`p-gfvig-${i}`))||0)      // intereses de deuda vigente sin tabla (visor)
    ingresos.push(ing)
    costos.push(cv)
    opex.push(op)
    depreciacion.push(dep)
    ebitda.push(ing - cv - op)
  }

  // Debt schedule — crédito solicitado, mes a mes (abono constante a capital tras la gracia),
  // agregado en años del modelo. Es el mismo cronograma de la Tabla de Amortización Mensual,
  // así que la gracia en meses (6, 18…) cae en el año correcto.
  const amort = plazo - gracia
  const tM = tasa_na/12
  const interesesNuevo = Array(n).fill(0), capitalNuevo = Array(n).fill(0)
  buildMonthlyTable(monto, tasa_na, plazo, gracia).forEach(r=>{
    const y = Math.floor((r.mes-1)/12)
    if(y < n){ interesesNuevo[y] += r.interes; capitalNuevo[y] += r.capital }
  })

  // ── DEUDA CONSOLIDADA = crédito solicitado + deuda financiera existente ──
  // A partir de aquí `intereses`, `capital` y `servDeuda` son CONSOLIDADOS:
  // alimentan UAI/impuestos, DSCR, ICR, estrés, flujo de caja y balance.
  let deudaRows = []
  try{ deudaRows = JSON.parse(get('_deuda') || '[]') || [] }catch(e){ deudaRows = [] }
  const ex = scheduleDeudaRows(deudaRows, n)
  // Intereses de deuda vigente ingresados como valor anual (visor): se suman a los de la tabla
  ex.intereses = ex.intereses.map((v,i)=>v+gfVig[i])
  const intereses = interesesNuevo.map((v,i)=>v+ex.intereses[i])
  const capital   = capitalNuevo.map((v,i)=>v+ex.capital[i])
  const servDeuda      = intereses.map((v,i)=>v+capital[i])
  const servDeudaNuevo = interesesNuevo.map((v,i)=>v+capitalNuevo[i])
  const servDeudaExist = ex.intereses.map((v,i)=>v+ex.capital[i])
  const deudaInicial   = monto + ex.saldoIni
  // Saldo de deuda financiera total al cierre de cada año
  const saldoDeuda = []
  { let sdt = deudaInicial; for(let i=0;i<n;i++){ sdt = Math.max(0, sdt - capital[i]); saldoDeuda.push(sdt) } }
  const ebit = ebitda.map((e,i)=>e-depreciacion[i])
  const uai  = ebit.map((e,i)=>e+otrosIng[i]-intereses[i])
  const uan  = uai.map(u=>u>0?u*(1-isr):u)
  // CFADS = EBITDA − ISR pagado − Capex mantenimiento − ΔKT (definición bancaria completa)
  const isr_pago_wiz = uai.map(u => u > 0 ? u * isr : 0)
  const capexMant = parseFloat(get('s-capex-mant'))||0
  const dkt       = parseFloat(get('s-dkt'))||0
  const cfads = ebitda.map((e, i) => e - isr_pago_wiz[i] - capexMant - dkt)

  // ── ESTADO DE FLUJO DE CAJA PROYECTADO ──
  // Flujo Operativo = Utilidad Neta + Depreciación + ISR no pagado
  const efc_op = uan.map((u, i) => u + depreciacion[i] + (isr_pago_wiz[i]>0 ? 0 : -isr_pago_wiz[i]))
  // Flujo de Inversión = Capex total (mantenimiento + crecimiento vía PPE)
  const ppeTot    = parseFloat(get('s-ppe'))||0
  const capexCruc = ppeTot > 0 && ppeVida > 0 ? ppeTot / Math.min(ppeVida, n) : 0
  const efc_inv = uan.map((_, i) => -(capexMant + (i === 0 ? capexCruc : 0)))
  // Flujo de Financiación = Nuevo crédito (año 0) − Servicio deuda
  const efc_fin = servDeuda.map((sd, i) => (i === 0 ? monto : 0) - sd)
  // Flujo Neto y Caja Acumulada
  const efc_neto = uan.map((_, i) => efc_op[i] + efc_inv[i] + efc_fin[i])
  let caja = 0
  const efc_acum = efc_neto.map(v => { caja += v; return caja })
  const efc = { op: efc_op, inv: efc_inv, fin: efc_fin, neto: efc_neto, acum: efc_acum }

  // Ratios
  const dscr = cfads.map((c,i)=>servDeuda[i]>0?+(c/servDeuda[i]).toFixed(3):null)
  const icr  = ebitda.map((e,i)=>intereses[i]>0?+(e/intereses[i]).toFixed(3):null)
  const mEbitda = ebitda.map((e,i)=>ingresos[i]>0?+(e/ingresos[i]).toFixed(3):0)
  // Cobertura EBITDA / Servicio de la deuda consolidado (antes de impuestos, capex y ΔKT)
  const cobEbitda = ebitda.map((e,i)=>servDeuda[i]>0?+(e/servDeuda[i]).toFixed(3):null)
  // Deuda financiera total al cierre / EBITDA del año
  const deudaEbitda = saldoDeuda.map((d,i)=>ebitda[i]>0?+(d/ebitda[i]).toFixed(3):null)

  // Balance
  let pat = parseFloat(get('b-pat'))||0
  const activos=[], pasivos=[], patrimonio=[]
  let sd = deudaInicial
  for(let i=0;i<n;i++){
    sd=Math.max(0,sd-capital[i]); pat+=uan[i]
    pasivos.push(sd); patrimonio.push(Math.max(pat,0))
    activos.push(Math.max(pat,0)+sd)
  }
  const dPat = pasivos.map((p,i)=>patrimonio[i]>0?+(p/patrimonio[i]).toFixed(3):null)

  // Vida de la deuda: años con servicio de deuda consolidado (todo el plazo, no solo 6 años)
  const lastDebtYear = servDeuda.reduce((last,v,i)=>v>0?i:last, -1)

  // DSCR mínimo consolidado en toda la vida de la deuda (el score se calcula más abajo, después del estrés)
  const dscrVals = dscr.filter(v=>v!==null)
  const dscrMin  = dscrVals.length ? Math.min(...dscrVals) : 0

  // ── MONTO MÁXIMO ──
  // El servicio del crédito nuevo es lineal en el monto (misma tasa, plazo, gracia y abono constante):
  // servicio_i(M) = M × sdU_i, intereses_i(M) = M × intU_i. Un monto mayor también paga más
  // intereses, que reducen el impuesto (escudo fiscal) y suben el CFADS. El monto máximo es el
  // mayor M que mantiene el DSCR consolidado ≥ 1.30x en TODOS los años del crédito:
  //   CFADS_i + t·intU_i·(M − monto) ≥ 1.3 × (servicio existente_i + M × sdU_i)
  const cfadsVida = cfads.filter((_,i)=>servDeuda[i]>0)
  const cfadsMin = cfadsVida.length ? Math.min(...cfadsVida) : 0
  let montoMax = 0
  if(monto > 0){
    let mMax = Infinity
    servDeudaNuevo.forEach((sdN,i)=>{
      if(sdN <= 0) return
      const sdU  = sdN / monto, intU = interesesNuevo[i] / monto
      const tEff = uai[i] > 0 ? isr : 0
      const num  = cfads[i] - 1.3*servDeudaExist[i] - tEff*intU*monto
      const den  = 1.3*sdU - tEff*intU
      mMax = Math.min(mMax, num <= 0 || den <= 0 ? 0 : num/den)
    })
    montoMax = isFinite(mMax) ? mMax : 0
  }

  // ── STRESS — misma lógica de caja que el caso base ──
  // · Costo de ventas variable: se recalcula sobre los ingresos estresados con el margen bruto
  //   base menos el choque (pp).
  // · OPEX se trata como fijo en el corto plazo: no baja con los ingresos y sube el % del choque.
  // · Tasa: +bps sobre el saldo promedio de TODA la deuda (supuesto conservador: tasa variable).
  // · Se mide sobre CFADS estresado (EBITDA − impuesto − capex mant. − ΔKT), igual que el DSCR base.
  const saldoProm = saldoDeuda.map((d,i)=>((i===0?deudaInicial:saldoDeuda[i-1]) + d)/2)
  function cfadsStress(i, {sI=0, sMBpp=0, sBps=0, sOp=0, costoExtra=0}={}){
    const ingS  = ingresos[i]*(1+sI)
    const mb    = ingresos[i]>0 ? (ingresos[i]-costos[i])/ingresos[i] : 0
    const costS = ingS*(1-(mb - sMBpp)) + costoExtra
    const ebS   = ingS - costS - opex[i]*(1+sOp)
    const intS  = intereses[i] + saldoProm[i]*sBps
    const uaiS  = ebS - depreciacion[i] - intS
    const cfS   = ebS - (uaiS>0?uaiS*isr:0) - capexMant - dkt
    return { cfS, sdS: intS + capital[i] }
  }
  function stressDscr(sI,sMBpp,sBps,sOp){
    return ingresos.map((_,i)=>{
      if(servDeuda[i]<=0) return null
      const {cfS, sdS} = cfadsStress(i,{sI,sMBpp,sBps,sOp})
      return +(cfS/sdS).toFixed(3)
    })
  }

  // ── LLCR (Loan Life Coverage Ratio) ──
  // LLCR = VPN(CFADS desde el año i hasta el último año con deuda) / saldo de deuda al inicio del año i
  const wacc = tasa_na  // usar tasa del crédito como tasa descuento
  const llcr = cfads.map((_, i) => {
    // Saldo de deuda consolidada al inicio del año i
    const pagado = capital.slice(0,i).reduce((a,b)=>a+b,0)
    const saldoRestante = Math.max(0, deudaInicial - pagado)
    if(saldoRestante <= 0 || i > lastDebtYear) return null
    let npv = 0
    for(let j=i; j<=lastDebtYear; j++){
      npv += cfads[j] / Math.pow(1+wacc, j-i+1)
    }
    return +(npv/saldoRestante).toFixed(3)
  })

  // ── PUNTO DE EQUILIBRIO FINANCIERO ──
  // % de caída de ingresos que lleva el DSCR consolidado a 1.0x (con la misma lógica de costos
  // del estrés). Negativo = los ingresos tendrían que SUBIR ese % para llegar a 1.0x.
  const breakeven = ingresos.map((ing, i) => {
    if(servDeuda[i]<=0 || ing<=0) return null
    const dscrAt = x => { const s=cfadsStress(i,{sI:-x}); return s.cfS/s.sdS }
    let lo = -2, hi = 1                    // de +200% a −100% de ingresos
    if(dscrAt(lo) < 1) return -200         // ni triplicando ingresos alcanza 1.0x
    if(dscrAt(hi) >= 1) return 100
    for(let k=0;k<60;k++){ const mid=(lo+hi)/2; if(dscrAt(mid)>=1) lo=mid; else hi=mid }
    return +(lo*100).toFixed(1)
  })

  // ── STRESS TRM (+20%, +40% devaluación) ──
  // Asume que 30% del costo de ventas es en USD (típico logística/manufactura)
  const pctCostoUSD = 0.30
  function stressTRM(devalPct){
    return ingresos.map((_,i) => {
      if(servDeuda[i]<=0) return null
      const {cfS, sdS} = cfadsStress(i,{costoExtra: costos[i]*pctCostoUSD*devalPct})
      return +(cfS/sdS).toFixed(3)
    })
  }

  const stressMod = stressDscr(-0.10,0.05,0.02,0.10)

  // ══ SCORE CREDITICIO (100 pts) — criterios de bancos y fondos de deuda ══
  const sector = get('f-sector') || 'Otro'
  const U = SECTOR_UMBRALES[sector] || SECTOR_UMBRALES['Otro']
  const enVida  = (arr) => arr.filter((v,i)=>v!==null && servDeuda[i]>0)
  const minOf   = (arr) => arr.length ? Math.min(...arr) : null
  const maxOf   = (arr) => arr.length ? Math.max(...arr) : null
  const levMax  = maxOf(enVida(deudaEbitda))
  const icrMin  = minOf(enVida(icr))
  const strMin  = minOf(enVida(stressMod))
  const bAC = parseFloat(get('b-ac'))||0
  const bPC = parseFloat(get('b-pc'))||0
  const rc  = bPC > 0 ? bAC / bPC : null
  const patHist  = parseFloat(get('b-pat'))||0
  const tipoGar  = get('c-garantia') || ''
  const valGar   = parseFloat(get('c-val-garantia'))||0
  const sinGarantiaReal = /sin garant|aval/i.test(tipoGar)   // los avales no son garantía real
  const cobGar   = monto > 0 && !sinGarantiaReal ? valGar / monto : 0
  const mEbVida  = enVida(mEbitda)
  const mEbProm  = mEbVida.length ? mEbVida.reduce((a,b)=>a+b,0)/mEbVida.length : (mEbitda[0]||0)
  const x = v => v===null ? '—' : v.toFixed(2)+'x'
  const pc = v => (v*100).toFixed(1)+'%'

  const scoreDetail = [
    { criterio:'DSCR consolidado mínimo', valor:x(dscrMin), umbral:`≥ ${U.dscr.toFixed(2)}x (sector)`, max:30,
      pts: dscrMin>=U.dscr+0.25?30 : dscrMin>=U.dscr?22 : dscrMin>=1.0?10 : 0 },
    { criterio:'Deuda financiera / EBITDA máx.', valor:x(levMax), umbral:`≤ ${U.lev.toFixed(1)}x (sector)`, max:20,
      pts: levMax===null?20 : levMax<=U.lev*0.67?20 : levMax<=U.lev?14 : levMax<=U.lev+1.5?6 : 0 },
    { criterio:'DSCR en estrés moderado', valor:x(strMin), umbral:'≥ 1.10x', max:15,
      pts: strMin===null?15 : strMin>=1.10?15 : strMin>=1.0?8 : 0 },
    { criterio:'Cobertura de intereses (EBITDA/intereses)', valor:x(icrMin), umbral:'≥ 3.0x', max:10,
      pts: icrMin===null?10 : icrMin>=3?10 : icrMin>=2?7 : icrMin>=1.5?3 : 0 },
    { criterio:'Liquidez — razón corriente', valor:rc===null?'Sin dato':x(rc), umbral:'≥ 1.20x', max:10,
      pts: rc===null?5 : rc>=1.5?10 : rc>=1.2?7 : rc>=1.0?4 : 0 },
    { criterio:'Cobertura de garantía (valor/monto)', valor:sinGarantiaReal?'Sin garantía real':x(cobGar), umbral:'≥ 1.25x', max:10,
      pts: cobGar>=1.5?10 : cobGar>=1.25?7 : cobGar>=1.0?4 : 0 },
    { criterio:'Margen EBITDA promedio', valor:pc(mEbProm), umbral:`≥ ${pc(U.mEb[0])} (sector)`, max:5,
      pts: mEbProm>=U.mEb[0]?5 : mEbProm>0?2 : 0 },
  ]
  let score = Math.min(100, scoreDetail.reduce((a,c)=>a+c.pts,0))

  // Reglas de rechazo / tope (política de crédito estándar)
  const knockouts = []
  if(dscrMin < 1.0) knockouts.push('DSCR consolidado menor a 1.0x: la caja operativa no cubre la deuda')
  if(patHist < 0)   knockouts.push('Patrimonio histórico negativo')
  const topeCondicionado = dscrMin < U.dscr || (levMax!==null && levMax > U.lev + 1.5)
  let verdict = score>=75?'✅ APROBABLE':score>=55?'⚠️ CONDICIONADO':'❌ NO VIABLE'
  if(knockouts.length){ verdict='❌ NO VIABLE'; score=Math.min(score,54) }
  else if(topeCondicionado && score>=75){ verdict='⚠️ CONDICIONADO'; score=74 }

  // ══ ALERTAS DEL ANALISTA — supuestos que se alejan del histórico ══
  const alertas = [...knockouts]
  if(!knockouts.length && topeCondicionado) alertas.push(`DSCR o apalancamiento fuera del umbral del sector (${sector}): veredicto limitado a CONDICIONADO`)
  const H = getHistorico(get)
  if(H){
    const mEbMaxProj = Math.max(...mEbitda.slice(0,5))
    if(mEbMaxProj - H.ebitda > 0.03)
      alertas.push(`Margen EBITDA proyectado (hasta ${pc(mEbMaxProj)}) supera el histórico (${pc(H.ebitda)}) en más de 3 pp — sustentar la mejora o usar márgenes históricos`)
    const gProj = ingresos[4]>0 && baseIng2>0 ? Math.pow(ingresos[4]/baseIng2, 1/5)-1 : null
    if(gProj!==null && H.cagr!==null && gProj - H.cagr > 0.05)
      alertas.push(`Crecimiento proyectado de ingresos (${pc(gProj)} anual) supera el histórico (${pc(H.cagr)}) en más de 5 pp`)
  }
  if(mEbProm > U.mEb[1]) alertas.push(`Margen EBITDA promedio (${pc(mEbProm)}) por encima del rango típico del sector (${pc(U.mEb[0])}–${pc(U.mEb[1])})`)
  if(dkt===0 && capexMant===0) alertas.push('Capex de mantenimiento y ΔKT en cero: el CFADS puede estar sobrestimado')
  if(rc===null) alertas.push('Sin activo/pasivo corriente: la liquidez no se pudo evaluar')

  // Años de proyección: desde el año del primer desembolso (o el año actual)
  const anioIni = parseInt(String(get('c-fecha')||'').slice(0,4)) || new Date().getFullYear()
  const years = Array.from({length:n},(_,i)=>String(anioIni+i))
  const ub = ingresos.map((v,i)=>v-costos[i])

  return {
    years, n,
    scoreDetail, alertas, sector, umbrales: U,
    ingresos, costos, opex, ebitda, depreciacion,
    intereses, capital, servDeuda, cfads,
    interesesNuevo, capitalNuevo, servDeudaNuevo, servDeudaExist, saldoDeuda,
    deudaExistente: ex.saldoIni,
    dscr, icr, mEbitda, dPat, cobEbitda, deudaEbitda,
    activos, pasivos, patrimonio, uan,
    llcr, breakeven,
    score, verdict, dscrMin,
    efc,
    montoMax, cfadsMin,
    deficit: montoMax - monto,
    params: {monto, tasa_na, tasa: tasa_na, plazo, gracia, isr, moneda: get('f-moneda')||'COP'},
    moneda: get('f-moneda')||'COP',
    // ── Alias con los nombres que usa el visor (modelo_financiero.html) ──
    cv: costos, ga: opex, dep: depreciacion, ub, ebit, uai, oi: otrosIng,
    gfVig: ex.intereses,          // intereses de la deuda existente (tabla + valor anual)
    intNew: interesesNuevo,       // intereses del crédito solicitado
    capPago: capital, saldoFin: saldoDeuda, isr_pago: isr_pago_wiz,
    mEb: mEbitda,
    mBr: ub.map((v,i)=>ingresos[i]>0?v/ingresos[i]:0),
    mNe: uan.map((u,i)=>ingresos[i]>0?u/ingresos[i]:0),
    roe: uan.map((u,i)=>patrimonio[i]>0?+(u/patrimonio[i]).toFixed(3):null),
    roa: uan.map((u,i)=>activos[i]>0?+(u/activos[i]).toFixed(3):null),
    stress: {
      base:     dscr,
      moderate: stressMod,
      severe:   stressDscr(-0.20,0.10,0.04,0.20),
      trm20:    stressTRM(0.20),
      trm40:    stressTRM(0.40),
    }
  }
}

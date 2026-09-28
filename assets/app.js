// === RECYCLEVISION ACTIVE LEARNING V5 ===
window.rvShowObjectNames = true;
window.rvCurrentDetection = null;

const video = document.querySelector("#camera"),
  overlay = document.querySelector("#overlay"),
  capture = document.querySelector("#capture");
const ctx = overlay.getContext("2d"),
  captureCtx = capture.getContext("2d");
let running = false,
  busy = false,
  lastRun = 0,
  frames = 0,
  lastFps = performance.now();
let analysisInterval = Number(localStorage.getItem("rv_interval") || 650),
  showBoxes = localStorage.getItem("rv_boxes") !== "false",
  lastMetricTotal = 0;
let detectionSound = localStorage.getItem("rv_detection_sound") !== "false", audioContext = null;
const $ = (id) => document.getElementById(id);
const $$ = (selector) => document.querySelectorAll(selector);
const wasteNames={"plastic bottle":"Botella plástica","plastic container":"Envase plástico","plastic bag":"Bolsa plástica","cardboard box":"Caja de cartón","paper":"Papel","crumpled paper":"Papel arrugado","glass bottle":"Botella de vidrio","glass jar":"Frasco de vidrio","aluminum can":"Lata de aluminio","metal can":"Lata de acero","banana peel":"Cáscara de banana","food waste":"Residuo orgánico","food wrapper":"Envoltorio","styrofoam":"Telgopor","dirty napkin":"Servilleta contaminada","battery":"Pila o batería","small electronic":"Electrónico pequeño"};
const warmNames={"Glass":"Vidrio","PET":"Plástico PET","HDPE":"Plástico HDPE","Mixed Plastics":"Plásticos mixtos","Corrugated Containers":"Cartón corrugado","Mixed Paper (general)":"Papel mixto","Aluminum Cans":"Latas de aluminio","Steel Cans":"Latas de acero","Food Waste":"Residuos orgánicos","Portable Electronic Devices":"Dispositivos electrónicos"};
async function apiFetch(url, options = {}, allowPrompt = true) {
  const headers = new Headers(options.headers || {});
  const accessKey = sessionStorage.getItem("rv_access_key");
  if (accessKey) headers.set("X-RecycleVision-Key", accessKey);
  const response = await fetch(url, { ...options, headers });
  if (response.status !== 401 || !allowPrompt) return response;
  sessionStorage.removeItem("rv_access_key");
  const entered = window.prompt("Ingresá la clave de acceso de RecycleVision");
  if (!entered) return response;
  sessionStorage.setItem("rv_access_key", entered.trim());
  return apiFetch(url, options, false);
}
async function start() {
  const startBtn = $("startBtn");
  try {
    startBtn.disabled = true;
    startBtn.textContent = "ABRIENDO CÁMARA...";
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") await audioContext.resume();

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Este navegador no permite acceso a cámara en esta página.");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "environment",
      },
      audio: false,
    });

    video.srcObject = stream;
    await video.play();
    $("cameraStart").style.display = "none";
    $("fpsLabel").textContent = "Cámara activa · cargando motor IA...";

    const runtimeReady = window.__RV_RUNTIME_READY__
      ? await window.__RV_RUNTIME_READY__
      : Boolean(window.__RECYCLEVISION_CLOUD__);

    if (!runtimeReady) {
      running = false;
      $("fpsLabel").textContent = "ERROR · MOTOR IA NO CARGADO";
      const detail = window.__RV_RUNTIME_ERROR__ || "No se pudo iniciar el motor RecycleVision.";
      alert("La cámara abrió, pero el motor IA no pudo cargarse. " + detail);
      return;
    }

    $("fpsLabel").textContent = "Cámara activa · RecycleVision listo";
    running = true;
    requestAnimationFrame(loop);
  } catch (e) {
    console.error("RecycleVision camera start failed", e);
    alert(e?.message || "No se pudo abrir la cámara. Revisá el permiso del navegador.");
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = "Iniciar cámara";
  }
}
function loop(now) {
  if (!running) return;
  resizeOverlay();
  frames++;
  if (now - lastFps > 1000) {
    $("fpsLabel").textContent = `Cámara activa · ${frames} FPS`;
    frames = 0;
    lastFps = now;
  }
  if (!busy && now - lastRun > analysisInterval) {
    lastRun = now;
    analyze();
  }
  requestAnimationFrame(loop);
}
function resizeOverlay() {
  if (overlay.width !== video.videoWidth) {
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
  }
}
async function analyze() {
  if (!video.videoWidth) return;
  busy = true;
  capture.width = 640;
  capture.height = Math.round((640 * video.videoHeight) / video.videoWidth);
  captureCtx.drawImage(video, 0, 0, capture.width, capture.height);
  try {
    const response = await apiFetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: capture.toDataURL("image/jpeg", 0.72) }),
    });
    if (!response.ok) throw new Error((await response.json()).detail);
    const data = await response.json();
    draw(data.detections, data.frame);
    renderDecision(data.detections);
    renderMetrics(data.metrics);
  } catch (e) {
    $("fpsLabel").textContent = "IA: " + e.message.slice(0, 48);
  } finally {
    busy = false;
  }
}
function draw(items, frame) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!showBoxes) return;

  const sx = overlay.width / frame.width;
  const sy = overlay.height / frame.height;

  // Estética tipo Motor de IA / YOLO:
  // caja fina, sin relleno, sin glow y etiqueta compacta.
  ctx.textBaseline = "top";
  ctx.lineJoin = "miter";
  ctx.lineCap = "butt";

  items.forEach((item) => {
    const [x1, y1, x2, y2] = item.box;
    const bx = x1 * sx;
    const by = y1 * sy;
    const bw = (x2 - x1) * sx;
    const bh = (y2 - y1) * sy;

    ctx.save();

    // Bounding box fino estilo YOLO.
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 2.8;
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.strokeRect(bx, by, bw, bh);

    // Label compacto.
    const isElectronic = ["Electronic", "RAEE_Special"].includes(item.internal_label);
    const material = isElectronic ? "DISPOSITIVO ELECTRÓNICO" : (item.material || item.label || "OBJETO").toUpperCase();
    const objectName = (!window.rvShowObjectNames || isElectronic) ? "" : (item.object_name || "").toUpperCase();
    const label = objectName
      ? `${objectName} · ${material} ${Math.round(item.confidence * 100)}%`
      : `${material} ${Math.round(item.confidence * 100)}%`;
    const fontSize = Math.max(15, Math.min(17, Math.round(overlay.width / 78)));
    ctx.font = `600 ${fontSize}px Arial, Helvetica, sans-serif`;

    const padX = 5;
    const padY = 3;
    const textWidth = ctx.measureText(label).width;
    const labelW = Math.ceil(textWidth + padX * 2);
    const labelH = fontSize + padY * 2;

    // Arriba de la caja si hay espacio; si no, dentro de la caja.
    const labelY = by >= labelH ? by - labelH : by;

    ctx.fillStyle = item.color;
    ctx.fillRect(bx, labelY, labelW, labelH);

    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, bx + padX, labelY + padY);

    ctx.restore();
  });
}
function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const n = parseInt(value.length === 3 ? value.split("").map(x => x + x).join("") : value, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
function renderDecision(items) {
  if (!items.length) return;
  const item = [...items].sort((a, b) => b.confidence - a.confidence)[0];
  window.rvCurrentDetection = item;
  $("waiting").classList.add("hidden");
  $("decision").classList.remove("hidden");
  $("materialPill").textContent = wasteNames[item.label] || item.material;
  $("materialName").textContent = item.material;
  $("confidence").textContent = Math.round(item.confidence * 100) + "%";
  $("containerName").textContent = item.container;
  $("containerColor").textContent = item.container_color;
  $("containerSwatch").style.background = item.color;
  $("dropoffName").textContent = item.dropoff;
  $("recommendation").textContent = item.message;
  $("decisionCard").style.setProperty("--bin", item.color);
  $("smartBin").style.setProperty("--bin", item.color);
  $("decisionCard").classList.remove("decision-flash");
  void $("decisionCard").offsetWidth;
  $("decisionCard").classList.add("decision-flash");
}
function renderMetrics(m) {
  $("total").textContent = m.total;
  $("rate").textContent = m.per_minute;
  $("recovery").textContent = m.recovery_rate;
  const entries = Object.entries(m.materials).sort((a, b) => b[1] - a[1]);
  $("bars").innerHTML = entries.length
    ? entries
        .map(([k, v]) => `<span class="bar">${k}<b>${v}</b></span>`)
        .join("")
    : "<small>Los datos aparecerán en vivo</small>";
  renderIntelligence(m);
}
const materialColors = {"Plástico":"#f5c542","Plástico flexible":"#ffc857","Cartón":"#2f80ed","Papel":"#56a6ff","Vidrio":"#24a148","Metal":"#aeb8c4","Orgánico":"#9b7653","No reciclable":"#7e8794","No identificado":"#9b51e0"};
function animateNumber(el, target, suffix = "", decimals = null) {
  const start = Number(el.dataset.value || 0), begin = performance.now(), duration = 450;
  const tick = now => { const p = Math.min(1, (now - begin) / duration); const value = start + (target - start) * (1 - Math.pow(1 - p, 3)); const precision=decimals===null?(Number.isInteger(target)?0:1):decimals; el.textContent = value.toFixed(precision) + suffix; if (p < 1) requestAnimationFrame(tick); else el.dataset.value = target; };
  requestAnimationFrame(tick);
}
function renderIntelligence(m) {
  animateNumber($("dashTotal"), m.total || 0);
  animateNumber($("recyclable"), m.recyclable || 0);
  animateNumber($("avgConfidence"), m.avg_confidence || 0);
  animateNumber($("variety"), m.material_variety || 0);
  $("uptime").textContent = `${m.uptime_minutes || 0} min`;
  $("recoverableCopy").textContent = `${m.recovery_rate || 0}% del flujo observado`;
  $("topMaterial").textContent = `Principal: ${m.top_material || "Sin datos"}`;
  $("dashRate").textContent = `${m.per_minute || 0}/min`;
  $("eventCount").textContent = `${m.total || 0} EVENTOS`;
  renderComposition(m.materials || {}, m.total || 0);
  renderContainers(m.containers || {}, m.total || 0);
  renderFlow(m.timeline || []);
  renderEvents(m.recent || []);
  if ((m.total || 0) > lastMetricTotal) { document.body.classList.add("new-event"); setTimeout(() => document.body.classList.remove("new-event"), 500); if (document.querySelector('.view-tab.active')?.dataset.view === 'intelligenceView') playDetectionBeep(); }
  lastMetricTotal = m.total || 0;
}
function playDetectionBeep(){if(!detectionSound||!running)return;try{audioContext=audioContext||new(window.AudioContext||window.webkitAudioContext)();const now=audioContext.currentTime,osc=audioContext.createOscillator(),gain=audioContext.createGain();osc.type='sine';osc.frequency.setValueAtTime(880,now);osc.frequency.exponentialRampToValueAtTime(1180,now+.075);gain.gain.setValueAtTime(.0001,now);gain.gain.exponentialRampToValueAtTime(.12,now+.012);gain.gain.exponentialRampToValueAtTime(.0001,now+.14);osc.connect(gain);gain.connect(audioContext.destination);osc.start(now);osc.stop(now+.15);}catch(error){console.debug('Audio no disponible',error);}}
function renderSoundToggle(){const button=$("soundToggle");button.classList.toggle("active",detectionSound);button.querySelector("span").textContent=detectionSound?"♪":"×";button.querySelector("b").textContent=detectionSound?"Sonido activo":"Silenciado";}
$("soundToggle").addEventListener("click",async()=>{detectionSound=!detectionSound;localStorage.setItem("rv_detection_sound",String(detectionSound));if(detectionSound){audioContext=audioContext||new(window.AudioContext||window.webkitAudioContext)();if(audioContext.state==='suspended')await audioContext.resume();playDetectionBeep();}renderSoundToggle();});renderSoundToggle();
function renderComposition(materials, total) {
  const entries = Object.entries(materials).sort((a,b) => b[1]-a[1]);
  $("compositionChart").innerHTML = entries.length ? entries.map(([name,count]) => { const pct = Math.round(count / total * 100); const color = materialColors[name] || "#69ed9a"; return `<div class="composition-row"><div><i style="background:${color}"></i><span>${name}</span><b>${count}</b></div><div class="track"><span style="--w:${pct}%;--c:${color}"></span></div><small>${pct}%</small></div>`; }).join("") : '<div class="empty-chart">Esperando detecciones</div>';
}
function renderContainers(containers, total) {
  const entries = Object.entries(containers).sort((a,b)=>b[1]-a[1]);
  $("containerChart").innerHTML = entries.length ? entries.map(([name,count],i) => `<div class="container-row"><i style="--c:${["#f5c542","#2f80ed","#24a148","#9b7653","#7e8794"][i%5]}"></i><span>${name}</span><b>${Math.round(count/total*100)}%</b></div>`).join("") : '<div class="empty-chart">Sin clasificaciones</div>';
}
function renderFlow(values) {
  const data = values.length ? values : [0,0,0,0,0,0]; const max = Math.max(...data, 1); const pts = data.map((v,i)=>`${(i/(Math.max(data.length-1,1))*600).toFixed(1)},${(165-v/max*130).toFixed(1)}`).join(" ");
  document.querySelector(".flow-line").setAttribute("points", pts); document.querySelector(".flow-area").setAttribute("d", `M ${pts.replaceAll(" ", " L ")} L 600 180 L 0 180 Z`);
}
function renderEvents(events) {
  $("eventsFeed").innerHTML = events.length ? events.slice(0,6).map(e => `<div class="event-row"><i style="--c:${e.color}"></i><div><b>${e.material}</b><small>${e.container}</small></div><strong>${Math.round(e.confidence*100)}%</strong><span>${new Date(e.at).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span></div>`).join("") : '<div class="empty-chart">Mostrá un residuo para iniciar</div>';
}
$$(".view-tab").forEach(tab => tab.addEventListener("click", () => { $$(".view-tab").forEach(x=>x.classList.remove("active")); $$(".app-view").forEach(x=>x.classList.remove("active")); tab.classList.add("active"); $(tab.dataset.view).classList.add("active"); document.body.classList.toggle("carbon-mode",tab.dataset.view==="carbonView"); $("operationMetrics").classList.toggle("view-hidden", tab.dataset.view !== "operationView"); if (tab.dataset.view === "historyView") loadHistory(currentHistoryDays); if (tab.dataset.view === "carbonView") loadCarbon(currentCarbonDays); }));
let currentHistoryDays = 7;
async function loadHistory(days) {
  try {
    const response = await apiFetch(`/api/history?days=${days}`);
    if (!response.ok) throw new Error("No se pudo leer el histórico");
    renderHistory(await response.json());
  } catch (error) { $("historyRange").textContent = error.message; }
}
function renderHistory(h) {
  animateNumber($("historyTotal"), h.total || 0);
  animateNumber($("historyRecovery"), h.recovery_rate || 0);
  animateNumber($("historyConfidence"), h.avg_confidence || 0);
  $("historyTop").textContent = h.top_material || "Sin datos";
  $("historyRecovered").textContent = `${h.recyclable || 0} objetos recuperables`;
  $("historyPeak").textContent = h.peak?.total ? `Pico: ${formatDate(h.peak.date)} · ${h.peak.total} objetos` : "Esperando actividad";
  $("historyRange").textContent = `ÚLTIMOS ${h.period_days} DÍAS`;
  const trend = $("historyTrend");
  trend.className = "trend";
  if (h.change_percent === null) { trend.classList.add("neutral"); trend.textContent = "Sin período anterior"; }
  else { const up = h.change_percent >= 0; trend.classList.add(up ? "up" : "down"); trend.textContent = `${up ? "↑" : "↓"} ${Math.abs(h.change_percent)}% vs. período anterior`; }
  $("ringRate").textContent = `${h.recovery_rate || 0}%`;
  $("ringRecoverable").textContent = h.recyclable || 0;
  $("ringReject").textContent = h.reject || 0;
  $("impactRing").style.setProperty("--rate", `${h.recovery_rate || 0}%`);
  renderHistoryBars(h.daily || []);
  renderHistoryComposition(h.materials || {}, h.total || 0);
  renderHistoryContainers(h.containers || {}, h.total || 0);
}
function formatDate(date) { return new Date(`${date}T12:00:00`).toLocaleDateString("es-AR", {day:"2-digit",month:"short"}); }
function renderHistoryBars(daily) {
  const max = Math.max(...daily.map(x=>x.total), 1); const stride = Math.max(1, Math.ceil(daily.length / 15));
  $("historyBars").innerHTML = daily.map((item,index) => `<div class="history-bar" title="${formatDate(item.date)} · ${item.total}"><b style="--h:${Math.max(item.total/max*100, item.total ? 6 : 1)}%"><i>${item.total || ""}</i></b><span>${index % stride === 0 || index === daily.length-1 ? formatDate(item.date) : ""}</span></div>`).join("");
}
function renderHistoryComposition(materials,total) {
  const entries = Object.entries(materials).sort((a,b)=>b[1]-a[1]);
  $("historyComposition").innerHTML = entries.length ? entries.map(([name,count]) => { const pct=Math.round(count/total*100), color=materialColors[name]||"#69ed9a"; return `<div class="composition-row"><div><i style="background:${color}"></i><span>${name}</span><b>${count}</b></div><div class="track"><span style="--w:${pct}%;--c:${color}"></span></div><small>${pct}%</small></div>`; }).join("") : '<div class="empty-chart">Sin datos históricos</div>';
}
function renderHistoryContainers(containers,total) {
  const entries=Object.entries(containers).sort((a,b)=>b[1]-a[1]);
  $("historyContainers").innerHTML=entries.length ? entries.map(([name,count],i)=>`<div class="container-row"><i style="--c:${["#f5c542","#2f80ed","#24a148","#9b7653","#7e8794"][i%5]}"></i><span>${name}</span><b>${Math.round(count/total*100)}%</b></div>`).join("") : '<div class="empty-chart">Sin datos históricos</div>';
}
$$('#periodFilter button').forEach(button => button.addEventListener('click', () => { $$('#periodFilter button').forEach(x=>x.classList.remove('active')); button.classList.add('active'); currentHistoryDays=Number(button.dataset.days); loadHistory(currentHistoryDays); }));
let currentCarbonDays=30, carbonCatalog=null;
async function ensureCarbonCatalog(){ if(carbonCatalog)return carbonCatalog; const response=await apiFetch('/api/carbon/catalog'); carbonCatalog=await response.json(); const select=$("carbonLabel"); select.innerHTML=Object.entries(carbonCatalog.profiles).filter(([,p])=>Object.values(p.factors).filter(v=>v!==null).length>1).map(([label,p])=>`<option value="${label}">${wasteNames[label]||label} · ${warmNames[p.warm_material]||p.warm_material}</option>`).join(''); updateCarbonAlternatives(); return carbonCatalog; }
async function loadCarbon(days){ try{await ensureCarbonCatalog();const response=await apiFetch(`/api/carbon/history?days=${days}`);renderCarbon(await response.json());}catch(error){$("carbonRange").textContent=error.message;} }
function renderCarbon(c){ animateNumber($("carbonTotal"),c.avoided_kgco2e||0,"",3);animateNumber($("carbonMass"),c.estimated_mass_kg||0,"",3);animateNumber($("carbonObjects"),c.modeled_objects||0);$("carbonRange").textContent=`Rango estimado: ${Number(c.range_min_kgco2e||0).toFixed(3)}–${Number(c.range_max_kgco2e||0).toFixed(3)} kg CO₂e`;$("carbonCoverage").textContent=`${c.unmodeled_objects||0} sin factor aplicable`;$("carbonDisclosure").textContent=c.disclosure;const entries=Object.entries(c.by_material||{});const max=Math.max(...entries.map(x=>x[1]),.001);$("carbonMaterialChart").innerHTML=entries.length?entries.map(([name,value],i)=>`<div class="carbon-material-row"><div><i>${String(i+1).padStart(2,'0')}</i><span>${warmNames[name]||name}</span><b>${value.toFixed(3)} kg</b></div><div><span style="--w:${value/max*100}%"></span></div></div>`).join(''):'<div class="empty-chart">Las detecciones aparecerán aquí</div>';renderClimateVisuals(c,entries);}
function renderClimateVisuals(c,entries){const daily=c.daily||[],raw=daily.map(x=>Number(x.kgco2e)||0),values=raw.length===1?[0,raw[0]]:(raw.length?raw:[0,0]);let cumulative=0;const series=values.map(v=>cumulative+=v),max=Math.max(...series,.001),points=series.map((v,i)=>`${i/Math.max(series.length-1,1)*700},${210-v/max*170}`).join(' ');$("climateLine").setAttribute("points",points);$("climateAreaPath").setAttribute("d",`M ${points.replaceAll(' ',' L ')} L 700 220 L 0 220 Z`);$("climatePeak").textContent=`Pico diario: ${Math.max(...raw,0).toFixed(3)} kg`;$("climateFrom").textContent=daily.length?formatDate(daily[0].date):'Sin datos';const colors=['#70e6ff','#69ed9a','#f5c542','#9b7cff','#ff8b8b','#56a6ff'],total=Math.max(entries.reduce((sum,[,value])=>sum+Math.max(value,0),0),.001);let cursor=0;const stops=entries.map(([,value],i)=>{const start=cursor;cursor+=Math.max(value,0)/total*100;return `${colors[i%colors.length]} ${start}% ${cursor}%`;});$("climateDonut").style.background=stops.length?`conic-gradient(${stops.join(',')})`:'conic-gradient(rgba(255,255,255,.06) 0 100%)';$("donutTotal").textContent=Number(c.avoided_kgco2e||0).toFixed(1);$("climateLegend").innerHTML=entries.slice(0,5).map(([name,value],i)=>`<span><i style="--c:${colors[i%colors.length]}"></i>${warmNames[name]||name}<b>${(value/total*100).toFixed(0)}%</b></span>`).join('')||'<small>Esperando detecciones</small>';const scenario=c.scenario_comparison||{},baseline=Number(scenario.baseline_kgco2e)||0,alternative=Number(scenario.alternative_kgco2e)||0,scale=Math.max(Math.abs(baseline),Math.abs(alternative),.001);$("baselineValue").textContent=`${baseline.toFixed(2)} kg`;$("alternativeValue").textContent=`${alternative.toFixed(2)} kg`;$("baselineBar").style.width=`${Math.abs(baseline)/scale*100}%`;$("alternativeBar").style.width=`${Math.abs(alternative)/scale*100}%`;animateNumber($("scenarioSaving"),c.avoided_kgco2e||0,"",2);animateNumber($("projectionValue"),(c.average_per_object_kgco2e||0)*1000,"",1);}
function updateCarbonAlternatives(){if(!carbonCatalog)return;const profile=carbonCatalog.profiles[$("carbonLabel").value];const baseline=$("carbonBaseline").value;const available=Object.entries(profile.factors).filter(([key,value])=>value!==null&&key!==baseline);$("carbonAlternative").innerHTML=available.map(([key])=>`<option value="${key}">${carbonCatalog.pathways[key]}</option>`).join('');}
$("carbonLabel").addEventListener('change',updateCarbonAlternatives);$("carbonBaseline").addEventListener('change',updateCarbonAlternatives);
$("carbonForm").addEventListener('submit',async event=>{event.preventDefault();const response=await apiFetch('/api/carbon/calculate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:$("carbonLabel").value,mass_kg:Number($("carbonWeight").value),baseline:$("carbonBaseline").value,alternative:$("carbonAlternative").value})});const payload=await response.json();if(!response.ok){alert(payload.detail);return;}$("carbonResult").classList.remove('hidden');$("manualCarbon").textContent=payload.avoided_kgco2e.toFixed(3);$("manualNarrative").textContent=`${payload.mass_kg} kg de ${wasteNames[payload.label]}: ${payload.baseline_name} → ${payload.alternative_name}. Factor ${warmNames[payload.warm_material]||payload.warm_material} · ${payload.source.version}.`;});
$$('#carbonPeriod button').forEach(button=>button.addEventListener('click',()=>{$$('#carbonPeriod button').forEach(x=>x.classList.remove('active'));button.classList.add('active');currentCarbonDays=Number(button.dataset.days);loadCarbon(currentCarbonDays);}));
let wizardStep=0;
function showWizardStep(step){wizardStep=Math.max(0,Math.min(3,step));$$('.wizard-step').forEach((panel,index)=>panel.classList.toggle('active',index===wizardStep));$$('#wizardProgress i').forEach((dot,index)=>dot.classList.toggle('active',index<=wizardStep));if(wizardStep===3){const current=$('carbonBaseline').selectedOptions[0]?.textContent||'';const alternative=$('carbonAlternative').selectedOptions[0]?.textContent||'';$('wizardReview').textContent=`${wasteNames[$('carbonLabel').value]||'Residuo'} · ${$('carbonWeight').value} kg · ${current} → ${alternative}.`;}}
$$('.wizard-next').forEach(button=>button.addEventListener('click',()=>showWizardStep(wizardStep+1)));
$$('.wizard-back').forEach(button=>button.addEventListener('click',()=>showWizardStep(wizardStep-1)));
const consultantPanel=$('consultantPanel');
function setConsultant(open){consultantPanel.classList.toggle('open',open);consultantPanel.setAttribute('aria-hidden',String(!open));if(open)$('consultantInput').focus();}
$('consultantFab').addEventListener('click',()=>setConsultant(!consultantPanel.classList.contains('open')));$('closeConsultant').addEventListener('click',()=>setConsultant(false));
function addConsultantMessage(text,type='bot',source=''){const article=document.createElement('article');article.className=`${type}-message`;article.textContent=text;if(source){const small=document.createElement('small');small.textContent=source;article.appendChild(small);}$('consultantMessages').appendChild(article);$('consultantMessages').scrollTop=$('consultantMessages').scrollHeight;}
async function askConsultant(question){const clean=question.trim();if(!clean)return;addConsultantMessage(clean,'user');$('consultantInput').value='';const loading=document.createElement('article');loading.className='bot-message consultant-thinking';loading.textContent='Analizando la consulta…';$('consultantMessages').appendChild(loading);try{const response=await apiFetch('/api/consultant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:clean})});const payload=await response.json();loading.remove();addConsultantMessage(payload.answer||payload.detail,'bot',payload.source);}catch(error){loading.remove();addConsultantMessage('No pude procesar la consulta. Verificá que RecycleVision siga ejecutándose.','bot');}}
$('consultantForm').addEventListener('submit',event=>{event.preventDefault();askConsultant($('consultantInput').value);});$$('.consultant-chips button').forEach(button=>button.addEventListener('click',()=>askConsultant(button.textContent)));
const carbonExplainer=$('carbonExplainer'),carbonModalBackdrop=$('carbonModalBackdrop');
function setCarbonExplainer(open){carbonExplainer.classList.toggle('open',open);carbonModalBackdrop.classList.toggle('open',open);carbonExplainer.setAttribute('aria-hidden',String(!open));carbonModalBackdrop.setAttribute('aria-hidden',String(!open));document.body.classList.toggle('modal-open',open);if(open)$('closeCarbonExplainer').focus();}
['explainCarbonBtn','explainCarbonInline'].forEach(id=>$(id).addEventListener('click',()=>setCarbonExplainer(true)));
['closeCarbonExplainer','understoodCarbonExplainer'].forEach(id=>$(id).addEventListener('click',()=>setCarbonExplainer(false)));
carbonModalBackdrop.addEventListener('click',()=>setCarbonExplainer(false));
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&carbonExplainer.classList.contains('open'))setCarbonExplainer(false);});
$("startBtn").addEventListener("click", start);
$("fullBtn").addEventListener("click", () =>
  document.fullscreenElement
    ? document.exitFullscreen()
    : document.documentElement.requestFullscreen(),
);
$("resetBtn").addEventListener("click", async () => {
  await apiFetch("/api/reset", { method: "POST" });
  renderMetrics({ total: 0, per_minute: 0, recovery_rate: 0, materials: {} });
  $("decision").classList.add("hidden");
  $("waiting").classList.remove("hidden");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
});

const drawer = $("advancedDrawer"),
  backdrop = $("drawerBackdrop");
function setDrawer(open) {
  drawer.classList.toggle("open", open);
  backdrop.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  if (open) loadConfig();
}
function bindRange(input, value, format) {
  $(input).addEventListener(
    "input",
    (e) => ($(value).textContent = format(e.target.value)),
  );
}
bindRange("confidenceInput", "confidenceValue", (v) => v + "%");
bindRange("intervalInput", "intervalValue", (v) => v + " ms");
bindRange("ttlInput", "ttlValue", (v) => v + " s");
bindRange("iouInput", "iouValue", (v) => v + "%");
async function loadConfig() {
  try {
    const c = await (await apiFetch("/api/config")).json();
    $("confidenceInput").value = Math.round(c.confidence * 100);
    $("confidenceValue").textContent = Math.round(c.confidence * 100) + "%";
    $("intervalInput").value = analysisInterval;
    $("intervalValue").textContent = analysisInterval + " ms";
    $("imageSizeInput").value = c.image_size;
    $("maxDetectionsInput").value = c.max_detections;
    $("ttlInput").value = c.tracker_ttl;
    $("ttlValue").textContent = c.tracker_ttl + " s";
    $("iouInput").value = Math.round(c.tracker_iou * 100);
    $("iouValue").textContent = Math.round(c.tracker_iou * 100) + "%";
    $("showBoxesInput").checked = showBoxes;
    $("modelName").textContent = c.model;
    $("configStatus").textContent = "Configuración sincronizada";
  } catch (e) {
    $("configStatus").textContent = "No se pudo leer la configuración";
  }
}
$("advancedForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    confidence: Number($("confidenceInput").value) / 100,
    image_size: Number($("imageSizeInput").value),
    max_detections: Number($("maxDetectionsInput").value),
    tracker_ttl: Number($("ttlInput").value),
    tracker_iou: Number($("iouInput").value) / 100,
  };
  $("configStatus").textContent = "Aplicando...";
  const response = await apiFetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    $("configStatus").textContent = "Error al aplicar";
    return;
  }
  analysisInterval = Number($("intervalInput").value);
  showBoxes = $("showBoxesInput").checked;
  localStorage.setItem("rv_interval", analysisInterval);
  localStorage.setItem("rv_boxes", showBoxes);
  $("configStatus").textContent = "Cambios aplicados en vivo";
  setTimeout(() => setDrawer(false), 550);
});
$("defaultsBtn").addEventListener("click", () => {
  $("confidenceInput").value = 22;
  $("confidenceValue").textContent = "22%";
  $("intervalInput").value = 650;
  $("intervalValue").textContent = "650 ms";
  $("imageSizeInput").value = 640;
  $("maxDetectionsInput").value = 10;
  $("ttlInput").value = 2.5;
  $("ttlValue").textContent = "2.5 s";
  $("iouInput").value = 25;
  $("iouValue").textContent = "25%";
  $("showBoxesInput").checked = true;
});
$("advancedBtn").addEventListener("click", () => setDrawer(true));
$("closeAdvanced").addEventListener("click", () => setDrawer(false));
backdrop.addEventListener("click", () => setDrawer(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setDrawer(false);
});


// === RECYCLEVISION ACTIVE LEARNING UI V5 ===
(function () {
  const OPTIONS = [
    ["Plastic", "PLÁSTICO"],
    ["Metal", "METAL"],
    ["Glass", "VIDRIO"],
    ["Paper_Cardboard", "PAPEL / CARTÓN"],
    ["Organic", "ORGÁNICO"],
    ["Electronic", "DISPOSITIVO ELECTRÓNICO"],
    ["Unknown", "DESCONOCIDO"],
  ];

  function snapshotFrame() {
    const video = document.querySelector("video");
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const canvas = document.createElement("canvas");
    const maxWidth = 960;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const c = canvas.getContext("2d");
    c.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  function compactPrediction(item) {
    if (!item) return {};
    return {
      label: item.label || null,
      internal_label: item.internal_label || null,
      material: item.material || null,
      object_name: item.object_name || null,
      confidence: item.confidence ?? null,
      box: item.box || null,
      source: item.source || null,
    };
  }

  function toast(message, kind = "ok") {
    const el = document.getElementById("rvLearningToast");
    if (!el) return;
    el.textContent = message;
    el.dataset.kind = kind;
    el.classList.add("show");
    clearTimeout(window.__rvToastTimer);
    window.__rvToastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  async function refreshStats() {
    try {
      const res = await fetch("/api/learning/stats");
      if (!res.ok) return;
      const data = await res.json();
      const counter = document.getElementById("rvLearningCount");
      if (counter) counter.textContent = String(data.total_samples || 0);
    } catch (_) {}
  }

  async function sendFeedback(correctedLabel, correctedMaterial, isCorrect) {
    const item = window.rvCurrentDetection;
    if (!item) {
      toast("Primero mostrale un objeto a RecycleVision", "warn");
      return;
    }

    const payload = {
      corrected_label: correctedLabel,
      corrected_material: correctedMaterial,
      is_correct: Boolean(isCorrect),
      prediction: compactPrediction(item),
      image_data: snapshotFrame(),
      source: "recyclevision-demo-v5",
    };

    try {
      const res = await fetch("/api/learning/feedback", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const counter = document.getElementById("rvLearningCount");
      if (counter) counter.textContent = String(data.total_samples || 0);
      toast(isCorrect ? "Caso validado y guardado" : `Aprendido: ${correctedMaterial}`, "ok");
      document.getElementById("rvCorrectionGrid")?.classList.remove("open");
    } catch (err) {
      console.error(err);
      toast("No pude guardar el aprendizaje", "error");
    }
  }

  function initLearningUI() {
    if (document.getElementById("rvLearningPanel")) return;

    const video = document.querySelector("video");
    if (!video || !video.parentElement) {
      setTimeout(initLearningUI, 400);
      return;
    }

    const host = video.parentElement;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";

    const panel = document.createElement("div");
    panel.id = "rvLearningPanel";
    panel.innerHTML = `
      <div class="rv-learn-head">
        <div>
          <span>RECYCLEVISION LEARNING</span>
          <strong>Aprendizaje continuo</strong>
        </div>
        <div class="rv-learn-counter">
          <b id="rvLearningCount">0</b>
          <small>CASOS</small>
        </div>
      </div>
      <div class="rv-learn-actions">
        <button type="button" id="rvObjectToggle" class="rv-mini-btn active">OBJETO · ON</button>
        <button type="button" id="rvCorrectBtn" class="rv-mini-btn rv-positive">✓ CORRECTO</button>
        <button type="button" id="rvFixBtn" class="rv-mini-btn">✎ CORREGIR</button>
      </div>
      <div id="rvCorrectionGrid" class="rv-correction-grid">
        <span>¿Qué material / corriente es?</span>
        <div class="rv-chip-grid"></div>
      </div>
      <div class="rv-learning-note">Tus correcciones alimentan el próximo entrenamiento.</div>
      <div id="rvLearningToast" class="rv-learning-toast"></div>
    `;
    host.appendChild(panel);

    const toggle = panel.querySelector("#rvObjectToggle");
    toggle.addEventListener("click", () => {
      window.rvShowObjectNames = !window.rvShowObjectNames;
      toggle.classList.toggle("active", window.rvShowObjectNames);
      toggle.textContent = window.rvShowObjectNames ? "OBJETO · ON" : "OBJETO · OFF";
    });

    panel.querySelector("#rvCorrectBtn").addEventListener("click", () => {
      const item = window.rvCurrentDetection;
      if (!item) return toast("No hay detección para validar", "warn");
      const key = item.internal_label || "Unknown";
      const option = OPTIONS.find(([value]) => value === key);
      const display = option ? option[1] : (item.material || "DESCONOCIDO");
      sendFeedback(key, display, true);
    });

    const correctionGrid = panel.querySelector("#rvCorrectionGrid");
    panel.querySelector("#rvFixBtn").addEventListener("click", () => {
      correctionGrid.classList.toggle("open");
    });

    const chipHost = panel.querySelector(".rv-chip-grid");
    OPTIONS.forEach(([value, label]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rv-material-chip";
      btn.textContent = label;
      btn.addEventListener("click", () => sendFeedback(value, label, false));
      chipHost.appendChild(btn);
    });

    refreshStats();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLearningUI);
  } else {
    initLearningUI();
  }
})();


// === RECYCLEVISION V6.1 ADAPTIVE SESSION ===
(function () {
  const ELECTRONIC_OBJECTS = new Set([
    "CELULAR", "CELL PHONE", "NOTEBOOK", "LAPTOP", "TECLADO", "KEYBOARD",
    "MOUSE", "CONTROL REMOTO", "REMOTE", "TELEVISOR", "TV", "MICROONDAS",
    "HORNO", "TOSTADORA", "HELADERA", "SECADOR"
  ]);

  const MATERIAL_META = {
    Plastic: { material: "PLÁSTICO", label: "PLÁSTICO" },
    Metal: { material: "METAL", label: "METAL" },
    Glass: { material: "VIDRIO", label: "VIDRIO" },
    Paper_Cardboard: { material: "PAPEL / CARTÓN", label: "PAPEL / CARTÓN" },
    Organic: { material: "ORGÁNICO", label: "ORGÁNICO" },
    Electronic: { material: "DISPOSITIVO ELECTRÓNICO", label: "DISPOSITIVO ELECTRÓNICO" },
    Unknown: { material: "DESCONOCIDO", label: "DESCONOCIDO" },
  };

  window.rvShowObjectNames = localStorage.getItem("rvShowObjectNames") !== "0";
  window.rvAdaptiveMemories = window.rvAdaptiveMemories || [];
  window.rvLastVisualState = window.rvLastVisualState || null;

  function boxIoU(a, b) {
    if (!a || !b || a.length !== 4 || b.length !== 4) return 0;
    const [ax1, ay1, ax2, ay2] = a.map(Number);
    const [bx1, by1, bx2, by2] = b.map(Number);
    const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
    const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
    const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    const aa = Math.max(1, (ax2 - ax1) * (ay2 - ay1));
    const ab = Math.max(1, (bx2 - bx1) * (by2 - by1));
    return inter / (aa + ab - inter + 1e-9);
  }

  function centerScore(a, b) {
    if (!a || !b || a.length !== 4 || b.length !== 4) return 0;
    const [ax1, ay1, ax2, ay2] = a.map(Number);
    const [bx1, by1, bx2, by2] = b.map(Number);
    const acx = (ax1 + ax2) / 2, acy = (ay1 + ay2) / 2;
    const bcx = (bx1 + bx2) / 2, bcy = (by1 + by2) / 2;
    const scale = Math.max(
      40,
      ((ax2 - ax1) + (bx2 - bx1) + (ay2 - ay1) + (by2 - by1)) / 4
    );
    const d = Math.hypot(acx - bcx, acy - bcy);
    return Math.max(0, 1 - d / scale);
  }

  function isElectronic(item) {
    const internal = String(item?.internal_label || "");
    const material = String(item?.material || item?.label || "");
    const object = String(item?.object_name || "").toUpperCase();
    return (
      internal === "Electronic" ||
      internal === "RAEE_Special" ||
      /electr|raee/i.test(material) ||
      ELECTRONIC_OBJECTS.has(object)
    );
  }

  function normalizeItem(item) {
    const out = { ...item };

    if (isElectronic(out)) {
      out.internal_label = "Electronic";
      out.material = "DISPOSITIVO ELECTRÓNICO";
      out.label = "DISPOSITIVO ELECTRÓNICO";
      out.object_name = null;
    } else if (!window.rvShowObjectNames) {
      out.object_name = null;
    }

    return out;
  }

  function findMemory(item) {
    const now = Date.now();
    window.rvAdaptiveMemories =
      window.rvAdaptiveMemories.filter((m) => m.expiresAt > now);

    let best = null;
    let bestScore = 0;

    for (const memory of window.rvAdaptiveMemories) {
      const iou = boxIoU(item.box, memory.box);
      const center = centerScore(item.box, memory.box);

      const currentObject = String(item.object_name || "").toUpperCase();
      const sameObject =
        currentObject &&
        memory.objectName &&
        currentObject === memory.objectName;

      const currentInternal = String(item.internal_label || "");
      const sameOriginalClass =
        currentInternal &&
        memory.originalLabel &&
        currentInternal === memory.originalLabel;

      if (iou < 0.06 && center < 0.54) continue;
      if (!sameObject && !sameOriginalClass && center < 0.72) continue;

      let score = iou * 0.62 + center * 0.28;
      if (sameObject) score += 0.34;
      if (sameOriginalClass) score += 0.18;

      if (score > bestScore) {
        best = memory;
        bestScore = score;
      }
    }

    return best;
  }

  window.rvApplyAdaptiveCorrections = function (items) {
    if (!Array.isArray(items)) return items || [];

    return items.map((raw) => {
      let item = { ...raw };
      const memory = findMemory(item);

      if (memory) {
        const meta = MATERIAL_META[memory.correctedLabel] || {
          material: memory.correctedMaterial,
          label: memory.correctedMaterial,
        };

        item.internal_label = memory.correctedLabel;
        item.material = meta.material;
        item.label = meta.label;
        item.adaptive_correction = true;
        item.source = `${item.source || "vision"}+adaptive`;

        if (memory.correctedLabel === "Electronic") {
          item.object_name = null;
        }

        memory.box = Array.isArray(item.box) ? [...item.box] : memory.box;
        memory.expiresAt = Date.now() + 30000;
      }

      return normalizeItem(item);
    });
  };

  window.rvRegisterAdaptiveCorrection = function (
    item,
    correctedLabel,
    correctedMaterial
  ) {
    if (!item || !Array.isArray(item.box)) return;

    const memory = {
      correctedLabel,
      correctedMaterial,
      originalLabel: String(item.internal_label || item.label || ""),
      objectName: String(item.object_name || "").toUpperCase(),
      box: [...item.box],
      expiresAt: Date.now() + 30000,
    };

    window.rvAdaptiveMemories = window.rvAdaptiveMemories.filter((existing) => {
      const close = boxIoU(existing.box, memory.box) >= 0.20 ||
                    centerScore(existing.box, memory.box) >= 0.78;
      return !close;
    });

    window.rvAdaptiveMemories.push(memory);
  };

  if (typeof draw === "function" && !window.__rvDrawWrappedV61) {
    const baseDraw = draw;
    draw = function (items, frame) {
      const corrected = window.rvApplyAdaptiveCorrections(items);
      window.rvLastVisualState = { items, frame };
      return baseDraw(corrected, frame);
    };
    window.__rvDrawWrappedV61 = true;
  }

  if (typeof renderDecision === "function" && !window.__rvDecisionWrappedV61) {
    const baseDecision = renderDecision;
    renderDecision = function (items) {
      const corrected = window.rvApplyAdaptiveCorrections(items);
      return baseDecision(corrected);
    };
    window.__rvDecisionWrappedV61 = true;
  }

  function syncToggleButton() {
    const toggle = document.getElementById("rvObjectToggle");
    if (!toggle) return;
    toggle.classList.toggle("active", window.rvShowObjectNames);
    toggle.textContent = window.rvShowObjectNames
      ? "OBJETO · ON"
      : "OBJETO · OFF";
  }

  document.addEventListener("click", (event) => {
    const toggle = event.target.closest?.("#rvObjectToggle");
    if (!toggle) return;

    setTimeout(() => {
      localStorage.setItem(
        "rvShowObjectNames",
        window.rvShowObjectNames ? "1" : "0"
      );
      syncToggleButton();

      if (window.rvLastVisualState && typeof draw === "function") {
        draw(
          window.rvLastVisualState.items,
          window.rvLastVisualState.frame
        );
      }
    }, 0);
  });

  document.addEventListener("click", (event) => {
    const chip = event.target.closest?.(".rv-material-chip");
    if (!chip || !window.rvCurrentDetection) return;

    const text = String(chip.textContent || "").trim().toUpperCase();
    const map = {
      "PLÁSTICO": "Plastic",
      "METAL": "Metal",
      "VIDRIO": "Glass",
      "PAPEL / CARTÓN": "Paper_Cardboard",
      "ORGÁNICO": "Organic",
      "DISPOSITIVO ELECTRÓNICO": "Electronic",
      "DESCONOCIDO": "Unknown",
    };

    const correctedLabel = map[text];
    if (!correctedLabel) return;

    window.rvRegisterAdaptiveCorrection(
      window.rvCurrentDetection,
      correctedLabel,
      text
    );

    const current = window.rvCurrentDetection;
    current.internal_label = correctedLabel;
    current.material = text;
    current.label = text;
    current.adaptive_correction = true;
    if (correctedLabel === "Electronic") current.object_name = null;

    if (window.rvLastVisualState && typeof draw === "function") {
      draw(
        window.rvLastVisualState.items,
        window.rvLastVisualState.frame
      );
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncToggleButton);
  } else {
    syncToggleButton();
  }
})();


// === RECYCLEVISION V6.2 PRO CORRECTION LAYER ===
(function () {
  const META = {
    Plastic: {
      label: "PLÁSTICO",
      material: "Plástico",
      category: "Plásticos y metales",
      color: "#f5c542",
      bin_color: "Amarillo",
      container: "Amarillo",
      destination: "Contenedor amarillo o estación de reciclables secos",
      recyclable: true,
      instruction: "Vaciar, limpiar y compactar cuando sea posible."
    },
    Metal: {
      label: "METAL",
      material: "Metal",
      category: "Plásticos y metales",
      color: "#f5c542",
      bin_color: "Amarillo",
      container: "Amarillo",
      destination: "Contenedor amarillo o estación de reciclables secos",
      recyclable: true,
      instruction: "Vaciar y entregar limpio cuando sea posible."
    },
    Glass: {
      label: "VIDRIO",
      material: "Vidrio",
      category: "Vidrio",
      color: "#24a148",
      bin_color: "Verde",
      container: "Verde",
      destination: "Campana verde o Punto Verde para vidrio",
      recyclable: true,
      instruction: "Vaciar y manipular con cuidado."
    },
    Paper_Cardboard: {
      label: "PAPEL / CARTÓN",
      material: "Papel / cartón",
      category: "Papel y cartón",
      color: "#2f80ed",
      bin_color: "Azul",
      container: "Azul",
      destination: "Contenedor azul o estación de papel y cartón",
      recyclable: true,
      instruction: "Mantener limpio y seco; plegar el cartón."
    },
    Organic: {
      label: "ORGÁNICO",
      material: "Orgánico",
      category: "Residuos orgánicos",
      color: "#8d6e42",
      bin_color: "Marrón",
      container: "Marrón",
      destination: "Contenedor marrón o compostera",
      recyclable: true,
      instruction: "Separar de envases y reciclables secos."
    },
    Electronic: {
      label: "DISPOSITIVO ELECTRÓNICO",
      material: "Dispositivo electrónico",
      category: "Residuo electrónico",
      color: "#e53935",
      bin_color: "Especial",
      container: "Especial",
      destination: "Punto de recepción de residuos electrónicos",
      recyclable: false,
      instruction: "No mezclar con residuos comunes. Requiere gestión diferenciada."
    },
    Unknown: {
      label: "DESCONOCIDO",
      material: "Desconocido",
      category: "Material no determinado",
      color: "#8c9a91",
      bin_color: "Sin definir",
      container: "Sin definir",
      destination: "Revisar el objeto antes de descartarlo",
      recyclable: false,
      instruction: "La evidencia visual no alcanza para determinar el material."
    },
    Special: {
      label: "RESIDUO ESPECIAL",
      material: "Residuo especial",
      category: "Gestión diferenciada",
      color: "#9b51e0",
      bin_color: "Especial",
      container: "Especial",
      destination: "Punto Verde o centro habilitado según el residuo",
      recyclable: false,
      instruction: "Requiere revisión y gestión diferenciada."
    }
  };

  function isConfirmedElectronic(item) {
    const internal = String(item?.internal_label || "");
    const source = String(item?.source || "");
    const objectName = String(item?.object_name || "").toUpperCase();
    const knownElectronic = new Set([
      "CELULAR", "CELL PHONE", "NOTEBOOK", "LAPTOP", "TECLADO", "KEYBOARD",
      "MOUSE", "CONTROL REMOTO", "REMOTE", "TELEVISOR", "TV", "MICROONDAS",
      "HORNO", "TOSTADORA", "HELADERA", "SECADOR"
    ]);

    return internal === "Electronic" ||
      (source.startsWith("coco") && knownElectronic.has(objectName));
  }

  function applyMeta(item, key, correctedMaterial = null) {
    const meta = META[key] || META.Unknown;
    item.internal_label = key === "Special" ? "RAEE_Special" : key;
    item.label = meta.label;
    item.material = correctedMaterial || meta.material;
    item.category = meta.category;
    item.color = meta.color;
    item.bin_color = meta.bin_color;
    item.container = meta.container;
    item.destination = meta.destination;
    item.recyclable = meta.recyclable;
    item.instruction = meta.instruction;

    // Aliases que usan distintas vistas del demo.
    item.bin = meta.bin_color;
    item.container_color = meta.bin_color;
    item.where = meta.destination;
    item.recommendation = meta.instruction;

    if (key === "Electronic" || key === "Special") {
      item.object_name = null;
    }

    return item;
  }

  window.rvApplyMaterialMeta = applyMeta;

  // Envolver la capa adaptativa existente y completar color/negocio.
  const previousAdaptive = window.rvApplyAdaptiveCorrections;
  window.rvApplyAdaptiveCorrections = function (items) {
    const base = typeof previousAdaptive === "function"
      ? previousAdaptive(items)
      : (Array.isArray(items) ? items.map((x) => ({...x})) : []);

    return base.map((item) => {
      if (item.adaptive_correction && META[item.internal_label]) {
        return applyMeta(item, item.internal_label);
      }

      // RAEE_Special sin confirmación de COCO no debe decir RAEE.
      if (item.internal_label === "RAEE_Special" && !isConfirmedElectronic(item)) {
        return applyMeta(item, "Special");
      }

      if (isConfirmedElectronic(item)) {
        return applyMeta(item, "Electronic");
      }

      return item;
    });
  };
// === RECYCLEVISION ACTIVE LEARNING V5 ===
window.__RV_APP_BOOTED__ = true;
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

    $("fpsLabel").textContent = "Cámara activa · descargando modelo RecycleVision...";
    try {
      await window.__RECYCLEVISION_CLOUD__.ensureModel();
    } catch (modelError) {
      running = false;
      $("fpsLabel").textContent = "IA: " + String(modelError?.message || modelError).slice(0, 70);
      alert(String(modelError?.message || modelError));
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
    const msg = String(e?.message || e || "Error de inferencia");
    $("fpsLabel").textContent = "IA: " + (/Failed to fetch/i.test(msg) ? "no se pudo acceder al modelo" : msg.slice(0, 64));
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

  // Panel arrastrable por el encabezado.
  function makePanelDraggable() {
    const panel = document.getElementById("rvLearningPanel");
    if (!panel || panel.dataset.draggable === "1") return;

    const handle = panel.querySelector(".rv-learn-head");
    if (!handle) return;

    panel.dataset.draggable = "1";
    handle.style.cursor = "move";
    handle.style.userSelect = "none";
    handle.title = "Arrastrar para mover · doble clic para restaurar";

    const saved = localStorage.getItem("rvLearningPanelPosition");
    if (saved) {
      try {
        const pos = JSON.parse(saved);
        if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
          panel.style.left = `${pos.left}px`;
          panel.style.top = `${pos.top}px`;
          panel.style.right = "auto";
          panel.style.bottom = "auto";
        }
      } catch (_) {}
    }

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      const rect = panel.getBoundingClientRect();
      dragging = true;
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;

      const width = panel.offsetWidth;
      const height = panel.offsetHeight;

      const left = Math.max(
        8,
        Math.min(window.innerWidth - width - 8, event.clientX - offsetX)
      );
      const top = Math.max(
        8,
        Math.min(window.innerHeight - height - 8, event.clientY - offsetY)
      );

      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });

    function stopDrag() {
      if (!dragging) return;
      dragging = false;
      const rect = panel.getBoundingClientRect();
      localStorage.setItem(
        "rvLearningPanelPosition",
        JSON.stringify({left: rect.left, top: rect.top})
      );
    }

    handle.addEventListener("pointerup", stopDrag);
    handle.addEventListener("pointercancel", stopDrag);

    handle.addEventListener("dblclick", () => {
      localStorage.removeItem("rvLearningPanelPosition");
      panel.style.left = "";
      panel.style.top = "";
      panel.style.right = "";
      panel.style.bottom = "";
    });
  }

  // Cuando el usuario corrige, cambiar TODO el paquete de decisión,
  // no solamente el texto.
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
      "DESCONOCIDO": "Unknown"
    };

    const key = map[text];
    if (!key) return;

    applyMeta(window.rvCurrentDetection, key);
    window.rvCurrentDetection.adaptive_correction = true;

    if (typeof window.rvRegisterAdaptiveCorrection === "function") {
      window.rvRegisterAdaptiveCorrection(
        window.rvCurrentDetection,
        key,
        META[key].material
      );
    }

    // Actualización inmediata: box + tarjeta "Decisión de la IA".
    if (window.rvLastVisualState && typeof draw === "function") {
      draw(window.rvLastVisualState.items, window.rvLastVisualState.frame);
    }
    if (typeof renderDecision === "function") {
      renderDecision([window.rvCurrentDetection]);
    }

    window.dispatchEvent(new CustomEvent("rv:material-corrected", {
      detail: {
        label: key,
        material: META[key].material
      }
    }));
  });

  // Miniestadística dentro del panel de aprendizaje.
  async function refreshCorrectionStats() {
    try {
      const res = await fetch("/api/learning/stats-v2");
      if (!res.ok) return;
      const stats = await res.json();

      const panel = document.getElementById("rvLearningPanel");
      if (!panel) return;

      let el = document.getElementById("rvCorrectionStats");
      if (!el) {
        el = document.createElement("div");
        el.id = "rvCorrectionStats";
        el.className = "rv-correction-stats";
        panel.appendChild(el);
      }

      const by = stats.by_label || {};
      const pieces = [];
      if (by.Plastic) pieces.push(`P ${by.Plastic}`);
      if (by.Metal) pieces.push(`M ${by.Metal}`);
      if (by.Glass) pieces.push(`V ${by.Glass}`);
      if (by.Paper_Cardboard) pieces.push(`C ${by.Paper_Cardboard}`);
      if (by.Organic) pieces.push(`O ${by.Organic}`);

      el.textContent =
        `CORRECCIONES ${stats.corrected || 0}` +
        (pieces.length ? ` · ${pieces.join(" · ")}` : "");
    } catch (_) {}
  }

  window.addEventListener("rv:material-corrected", () => {
    setTimeout(refreshCorrectionStats, 450);
  });

  const boot = () => {
    makePanelDraggable();
    refreshCorrectionStats();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(boot, 300));
  } else {
    setTimeout(boot, 300);
  }
})();


// === RECYCLEVISION V6.3 REALTIME INTELLIGENCE CORRECTIONS ===
(function () {
  const STORAGE_KEY = "rvRealtimeMetricCorrectionsV63";

  const MATERIAL_INFO = {
    Plastic: {
      material: "Plástico",
      container: "Amarillo",
      color: "#f5c542",
      recyclable: true,
    },
    Metal: {
      material: "Metal",
      container: "Amarillo",
      color: "#f5c542",
      recyclable: true,
    },
    Glass: {
      material: "Vidrio",
      container: "Verde",
      color: "#24a148",
      recyclable: true,
    },
    Paper_Cardboard: {
      material: "Papel / cartón",
      container: "Azul",
      color: "#2f80ed",
      recyclable: true,
    },
    Organic: {
      material: "Orgánico",
      container: "Marrón",
      color: "#8d6e42",
      recyclable: true,
    },
    Electronic: {
      material: "Dispositivo electrónico",
      container: "Especial",
      color: "#e53935",
      recyclable: false,
    },
    Unknown: {
      material: "Desconocido",
      container: "Sin definir",
      color: "#8c9a91",
      recyclable: false,
    },
  };

  function safeParse(value, fallback) {
    try {
      const parsed = JSON.parse(value);
      return parsed ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  window.rvRealtimeMetricCorrections =
    safeParse(sessionStorage.getItem(STORAGE_KEY), []);

  function saveLedger() {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(window.rvRealtimeMetricCorrections)
    );
  }

  function cloneMetrics(metrics) {
    if (typeof structuredClone === "function") {
      try { return structuredClone(metrics); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(metrics || {}));
  }

  function normalizeMaterialName(value) {
    const raw = String(value || "").trim();
    const upper = raw.toUpperCase();

    const aliases = {
      "DESCONOCIDO": "Desconocido",
      "NO IDENTIFICADO": "Desconocido",
      "RESIDUO ESPECIAL": "Residuo especial",
      "RAEE / RESIDUO ESPECIAL": "Residuo especial",
      "PLÁSTICO": "Plástico",
      "PLASTICO": "Plástico",
      "METAL": "Metal",
      "VIDRIO": "Vidrio",
      "PAPEL / CARTÓN": "Papel / cartón",
      "PAPEL / CARTON": "Papel / cartón",
      "ORGÁNICO": "Orgánico",
      "ORGANICO": "Orgánico",
      "DISPOSITIVO ELECTRÓNICO": "Dispositivo electrónico",
      "DISPOSITIVO ELECTRONICO": "Dispositivo electrónico",
    };

    return aliases[upper] || raw || "Desconocido";
  }

  function adjustCounter(object, key, delta) {
    if (!key || !delta) return;
    object[key] = Math.max(0, Number(object[key] || 0) + delta);
    if (object[key] <= 0) delete object[key];
  }

  function topMaterial(materials) {
    const entries = Object.entries(materials || {})
      .filter(([, count]) => Number(count) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    return entries.length ? entries[0][0] : "Sin datos";
  }

  function replaceRecentEvent(recent, correction, usedIndexes) {
    if (!Array.isArray(recent) || !recent.length) return;

    const from = correction.fromMaterial;
    let index = -1;

    for (let i = 0; i < recent.length; i += 1) {
      if (usedIndexes.has(i)) continue;
      if (normalizeMaterialName(recent[i]?.material) === from) {
        index = i;
        break;
      }
    }

    if (index < 0) return;

    const event = recent[index];
    event.material = correction.toMaterial;
    event.container = correction.toContainer;
    event.color = correction.toColor;
    event.corrected = true;
    usedIndexes.add(index);
  }

  window.rvApplyRealtimeMetricCorrections = function (metrics) {
    const m = cloneMetrics(metrics || {});
    m.materials = {...(m.materials || {})};
    m.containers = {...(m.containers || {})};
    m.recent = Array.isArray(m.recent)
      ? m.recent.map((item) => ({...item}))
      : [];

    const usedRecent = new Set();
    let recyclableDelta = 0;

    for (const correction of window.rvRealtimeMetricCorrections) {
      if (
        !correction ||
        !correction.fromMaterial ||
        !correction.toMaterial ||
        correction.fromMaterial === correction.toMaterial
      ) continue;

      adjustCounter(m.materials, correction.fromMaterial, -1);
      adjustCounter(m.materials, correction.toMaterial, +1);

      if (
        correction.fromContainer &&
        correction.toContainer &&
        correction.fromContainer !== correction.toContainer
      ) {
        adjustCounter(m.containers, correction.fromContainer, -1);
        adjustCounter(m.containers, correction.toContainer, +1);
      }

      recyclableDelta +=
        (correction.toRecyclable ? 1 : 0) -
        (correction.fromRecyclable ? 1 : 0);

      replaceRecentEvent(m.recent, correction, usedRecent);
    }

    if (Number.isFinite(Number(m.recyclable))) {
      m.recyclable = Math.max(
        0,
        Math.min(
          Number(m.total || 0),
          Number(m.recyclable || 0) + recyclableDelta
        )
      );
    }

    if (Number(m.total || 0) > 0 && Number.isFinite(Number(m.recyclable))) {
      m.recovery_rate = Math.round(
        (Number(m.recyclable) / Number(m.total)) * 100
      );
    }

    m.material_variety = Object.values(m.materials)
      .filter((count) => Number(count) > 0).length;
    m.top_material = topMaterial(m.materials);

    return m;
  };

  // Captura el estado ANTES de que V6.1/V6.2 modifiquen la detección.
  document.addEventListener("click", (event) => {
    const chip = event.target.closest?.(".rv-material-chip");
    if (!chip || !window.rvCurrentDetection) return;

    const item = window.rvCurrentDetection;
    window.__rvMetricCorrectionBefore = {
      material: normalizeMaterialName(item.material || item.label),
      container: String(item.container || item.container_color || "Sin definir"),
      recyclable: Boolean(item.recyclable),
      internal_label: String(item.internal_label || ""),
      confidence: Number(item.confidence || 0),
      box: Array.isArray(item.box) ? [...item.box] : null,
    };
  }, true);

  // V6.2 ya emite este evento después de aplicar la corrección visual.
  window.addEventListener("rv:material-corrected", (event) => {
    const before = window.__rvMetricCorrectionBefore;
    const item = window.rvCurrentDetection;
    const correctedLabel = event.detail?.label;

    if (!before || !item || !correctedLabel) return;

    const info = MATERIAL_INFO[correctedLabel] || {
      material: normalizeMaterialName(event.detail?.material),
      container: String(item.container || "Sin definir"),
      color: String(item.color || "#8c9a91"),
      recyclable: Boolean(item.recyclable),
    };

    const fromMaterial = normalizeMaterialName(before.material);
    const toMaterial = normalizeMaterialName(info.material);

    // Si ya estaba contabilizado con esa misma clase, no crear un delta falso.
    if (fromMaterial === toMaterial) {
      window.__rvMetricCorrectionBefore = null;
      return;
    }

    const correction = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: Date.now(),
      fromMaterial,
      toMaterial,
      fromContainer: before.container,
      toContainer: info.container,
      fromRecyclable: before.recyclable,
      toRecyclable: Boolean(info.recyclable),
      toColor: info.color,
      confidence: before.confidence,
    };

    window.rvRealtimeMetricCorrections.push(correction);
    saveLedger();
    window.__rvMetricCorrectionBefore = null;

    // Si conservamos el último paquete de métricas del servidor,
    // redibujamos Intelligence inmediatamente.
    if (
      window.rvLastServerMetrics &&
      typeof renderMetrics === "function"
    ) {
      renderMetrics(window.rvLastServerMetrics);
    }
  });

  // Envolver renderMetrics. El backend sigue siendo la fuente base;
  // la capa de correcciones sustituye clases en la sesión actual.
  if (typeof renderMetrics === "function" && !window.__rvMetricsWrappedV63) {
    const baseRenderMetricsV63 = renderMetrics;

    renderMetrics = function (metrics) {
      window.rvLastServerMetrics = cloneMetrics(metrics || {});
      const corrected = window.rvApplyRealtimeMetricCorrections(metrics || {});
      return baseRenderMetricsV63(corrected);
    };

    window.__rvMetricsWrappedV63 = true;
  }

  // Colores adicionales para las categorías nuevas/corregidas.
  if (typeof materialColors === "object" && materialColors) {
    Object.assign(materialColors, {
      "Plástico": "#f5c542",
      "Metal": "#f5c542",
      "Vidrio": "#24a148",
      "Papel / cartón": "#2f80ed",
      "Orgánico": "#8d6e42",
      "Desconocido": "#8c9a91",
      "Residuo especial": "#9b51e0",
      "Dispositivo electrónico": "#e53935",
    });
  }

  // Reset del demo = limpiar también sustituciones estadísticas de sesión.
  const resetButton = document.getElementById("resetBtn");
  if (resetButton) {
    resetButton.addEventListener("click", () => {
      window.rvRealtimeMetricCorrections = [];
      sessionStorage.removeItem(STORAGE_KEY);
      window.rvLastServerMetrics = null;
    });
  }

  window.rvCorrectionLedgerStats = function () {
    return {
      corrections: window.rvRealtimeMetricCorrections.length,
      ledger: [...window.rvRealtimeMetricCorrections],
    };
  };
})();


// === RECYCLEVISION TEACHING STUDIO V6.4 ===
(function () {
  const OPTIONS = [
    ["Plastic", "PLÁSTICO"],
    ["Metal", "METAL"],
    ["Glass", "VIDRIO"],
    ["Paper_Cardboard", "PAPEL / CARTÓN"],
    ["Organic", "ORGÁNICO"],
    ["Electronic", "DISPOSITIVO ELECTRÓNICO"],
  ];

  let modal = null;
  let canvas = null;
  let ctxTeach = null;
  let sourceCanvas = null;
  let sourceCtx = null;
  let sourceReady = false;
  let box = null;
  let drawing = false;
  let startPoint = null;

  function $(id) {
    return document.getElementById(id);
  }

  function toastTeaching(message, kind = "ok") {
    const el = $("rvTeachingToast");
    if (!el) return;
    el.textContent = message;
    el.dataset.kind = kind;
    el.classList.add("show");
    clearTimeout(window.__rvTeachingToast);
    window.__rvTeachingToast = setTimeout(() => {
      el.classList.remove("show");
    }, 2200);
  }

  function createModal() {
    if ($("rvTeachingModal")) return;

    modal = document.createElement("div");
    modal.id = "rvTeachingModal";
    modal.className = "rv-teaching-modal";
    modal.setAttribute("aria-hidden", "true");

    modal.innerHTML = `
      <section class="rv-teaching-shell">
        <header class="rv-teaching-header">
          <div>
            <span>RECYCLEVISION TEACHING STUDIO</span>
            <h2>Enseñar un nuevo ejemplo</h2>
            <p>Congelá la cámara o subí una imagen, marcá el objeto y asigná su material.</p>
          </div>
          <button type="button" id="rvTeachingClose" class="rv-teaching-close">×</button>
        </header>

        <div class="rv-teaching-toolbar">
          <button type="button" id="rvTeachingCamera">◉ CONGELAR CÁMARA</button>
          <label class="rv-upload-btn">
            ↑ SUBIR IMAGEN
            <input id="rvTeachingUpload" type="file" accept="image/*" hidden>
          </label>
          <button type="button" id="rvTeachingClear">↺ BORRAR MARCA</button>
          <button type="button" id="rvTeachingExport">⇩ EXPORTAR DATASET</button>
          <div class="rv-teaching-count">
            <b id="rvTeachingCount">0</b>
            <span>EJEMPLOS</span>
          </div>
        </div>

        <div class="rv-teaching-workspace">
          <div class="rv-teaching-canvas-wrap">
            <canvas id="rvTeachingCanvas"></canvas>
            <div id="rvTeachingEmpty" class="rv-teaching-empty">
              <strong>1</strong>
              <span>Congelá la cámara o subí una imagen.</span>
            </div>
          </div>

          <aside class="rv-teaching-sidebar">
            <div class="rv-teaching-step">
              <i>01</i>
              <div>
                <b>Elegí la imagen</b>
                <span>Cámara en vivo o archivo local.</span>
              </div>
            </div>

            <div class="rv-teaching-step">
              <i>02</i>
              <div>
                <b>Dibujá el rectángulo</b>
                <span>Arrastrá sobre el objeto completo.</span>
              </div>
            </div>

            <div class="rv-teaching-step">
              <i>03</i>
              <div>
                <b>Asigná el material</b>
                <span>La etiqueta se transforma a formato YOLO automáticamente.</span>
              </div>
            </div>

            <label class="rv-teaching-label">
              MATERIAL / CORRIENTE
              <select id="rvTeachingLabel">
                ${OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}
              </select>
            </label>

            <label class="rv-teaching-label">
              NOTA OPCIONAL
              <input id="rvTeachingNote" type="text" maxlength="500"
                     placeholder="Ej: caja corrugada marrón de envío">
            </label>

            <div class="rv-teaching-box-info">
              <span>BOUNDING BOX</span>
              <b id="rvTeachingBoxStatus">Sin marcar</b>
            </div>

            <button type="button" id="rvTeachingSave" class="rv-teaching-save">
              + GUARDAR EJEMPLO DE ENTRENAMIENTO
            </button>

            <small>
              Esto agrega conocimiento al dataset. Los pesos del modelo se actualizan
              luego mediante entrenamiento controlado.
            </small>
          </aside>
        </div>

        <div id="rvTeachingToast" class="rv-teaching-toast"></div>
      </section>
    `;

    document.body.appendChild(modal);

    canvas = $("rvTeachingCanvas");
    ctxTeach = canvas.getContext("2d");

    sourceCanvas = document.createElement("canvas");
    sourceCtx = sourceCanvas.getContext("2d");

    $("rvTeachingClose").addEventListener("click", closeTeaching);
    $("rvTeachingCamera").addEventListener("click", freezeCamera);
    $("rvTeachingClear").addEventListener("click", clearBox);
    $("rvTeachingExport").addEventListener("click", () => {
      window.open("/api/teaching/export", "_blank");
    });

    $("rvTeachingUpload").addEventListener("change", handleUpload);
    $("rvTeachingSave").addEventListener("click", saveSample);

    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerUp);

    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeTeaching();
    });

    refreshStats();
  }

  function openTeaching() {
    createModal();
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    refreshStats();
  }

  function closeTeaching() {
    if (!modal) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }

  function installTeachingButton() {
    if ($("rvTeachingBtn")) return;

    const panel = $("rvLearningPanel");
    if (!panel) {
      setTimeout(installTeachingButton, 400);
      return;
    }

    const actions = panel.querySelector(".rv-learn-actions");
    if (!actions) {
      setTimeout(installTeachingButton, 400);
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.id = "rvTeachingBtn";
    button.className = "rv-mini-btn rv-teaching-trigger";
    button.textContent = "＋ ENSEÑAR IA";
    button.addEventListener("click", openTeaching);
    actions.appendChild(button);

    const note = panel.querySelector(".rv-learning-note");
    if (note) {
      note.textContent =
        "Correcciones + ejemplos enseñados alimentan el próximo entrenamiento.";
    }
  }

  function fitImage(width, height) {
    const maxW = 1280;
    const maxH = 760;
    const scale = Math.min(1, maxW / width, maxH / height);

    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    canvas.width = w;
    canvas.height = h;
    sourceCanvas.width = w;
    sourceCanvas.height = h;

    return {w, h};
  }

  function freezeCamera() {
    const video = document.querySelector("video");

    if (!video || !video.videoWidth || !video.videoHeight) {
      return toastTeaching("La cámara todavía no está lista", "warn");
    }

    const {w, h} = fitImage(video.videoWidth, video.videoHeight);
    sourceCtx.clearRect(0, 0, w, h);
    sourceCtx.drawImage(video, 0, 0, w, h);

    sourceReady = true;
    box = null;
    $("rvTeachingEmpty").classList.add("hidden");
    $("rvTeachingBoxStatus").textContent = "Sin marcar";
    redraw();
    toastTeaching("Frame congelado. Ahora marcá el objeto.");
  }

  function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const image = new Image();
    image.onload = () => {
      const {w, h} = fitImage(image.naturalWidth, image.naturalHeight);
      sourceCtx.clearRect(0, 0, w, h);
      sourceCtx.drawImage(image, 0, 0, w, h);

      sourceReady = true;
      box = null;
      $("rvTeachingEmpty").classList.add("hidden");
      $("rvTeachingBoxStatus").textContent = "Sin marcar";
      redraw();
      URL.revokeObjectURL(image.src);
      toastTeaching("Imagen cargada. Marcá el objeto.");
    };
    image.src = URL.createObjectURL(file);
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;

    return {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * sx)),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * sy)),
    };
  }

  function pointerDown(event) {
    if (!sourceReady) {
      toastTeaching("Primero elegí una imagen", "warn");
      return;
    }

    drawing = true;
    startPoint = canvasPoint(event);
    box = {
      x1: startPoint.x,
      y1: startPoint.y,
      x2: startPoint.x,
      y2: startPoint.y,
    };

    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function pointerMove(event) {
    if (!drawing || !box) return;
    const point = canvasPoint(event);
    box.x2 = point.x;
    box.y2 = point.y;
    redraw();
  }

  function pointerUp(event) {
    if (!drawing) return;
    drawing = false;

    if (box) {
      const x1 = Math.min(box.x1, box.x2);
      const y1 = Math.min(box.y1, box.y2);
      const x2 = Math.max(box.x1, box.x2);
      const y2 = Math.max(box.y1, box.y2);

      box = {x1, y1, x2, y2};

      const w = Math.round(x2 - x1);
      const h = Math.round(y2 - y1);

      if (w < 8 || h < 8) {
        box = null;
        $("rvTeachingBoxStatus").textContent = "Sin marcar";
        toastTeaching("Marcá un rectángulo más grande", "warn");
      } else {
        $("rvTeachingBoxStatus").textContent = `${w} × ${h}px`;
      }
    }

    redraw();
  }

  function clearBox() {
    box = null;
    $("rvTeachingBoxStatus").textContent = "Sin marcar";
    redraw();
  }

  function redraw() {
    if (!sourceReady) return;

    ctxTeach.clearRect(0, 0, canvas.width, canvas.height);
    ctxTeach.drawImage(sourceCanvas, 0, 0);

    if (!box) return;

    const x = Math.min(box.x1, box.x2);
    const y = Math.min(box.y1, box.y2);
    const w = Math.abs(box.x2 - box.x1);
    const h = Math.abs(box.y2 - box.y1);

    ctxTeach.save();
    ctxTeach.strokeStyle = "#69ed9a";
    ctxTeach.lineWidth = 3;
    ctxTeach.setLineDash([]);
    ctxTeach.strokeRect(x, y, w, h);

    ctxTeach.fillStyle = "rgba(105,237,154,.10)";
    ctxTeach.fillRect(x, y, w, h);

    const label = $("rvTeachingLabel")?.selectedOptions?.[0]?.textContent || "OBJETO";
    ctxTeach.font = "700 14px Arial, Helvetica, sans-serif";

    const tw = ctxTeach.measureText(label).width + 12;
    const labelY = y >= 23 ? y - 23 : y;

    ctxTeach.fillStyle = "#69ed9a";
    ctxTeach.fillRect(x, labelY, tw, 23);
    ctxTeach.fillStyle = "#06100b";
    ctxTeach.fillText(label, x + 6, labelY + 16);
    ctxTeach.restore();
  }

  async function saveSample() {
    if (!sourceReady) {
      return toastTeaching("Primero elegí una imagen", "warn");
    }

    if (!box) {
      return toastTeaching("Dibujá un rectángulo sobre el objeto", "warn");
    }

    const label = $("rvTeachingLabel").value;
    const note = $("rvTeachingNote").value.trim();

    const payload = {
      label,
      image_data: sourceCanvas.toDataURL("image/jpeg", 0.9),
      image_width: sourceCanvas.width,
      image_height: sourceCanvas.height,
      box,
      source: "recyclevision-teaching-studio-v64",
      note: note || null,
    };

    const button = $("rvTeachingSave");
    button.disabled = true;
    button.textContent = "GUARDANDO...";

    try {
      const res = await fetch("/api/teaching/sample", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.detail || `HTTP ${res.status}`);
      }

      $("rvTeachingCount").textContent = String(data.total_samples || 0);
      toastTeaching(
        `Ejemplo aprendido: ${data.visible_label}`,
        "ok"
      );

      box = null;
      $("rvTeachingBoxStatus").textContent = "Sin marcar";
      $("rvTeachingNote").value = "";
      redraw();
    } catch (error) {
      console.error(error);
      toastTeaching(error.message || "No pude guardar el ejemplo", "error");
    } finally {
      button.disabled = false;
      button.textContent = "+ GUARDAR EJEMPLO DE ENTRENAMIENTO";
    }
  }

  async function refreshStats() {
    try {
      const res = await fetch("/api/teaching/stats");
      if (!res.ok) return;
      const data = await res.json();
      if ($("rvTeachingCount")) {
        $("rvTeachingCount").textContent = String(data.total_samples || 0);
      }
    } catch (_) {}
  }

  document.addEventListener("change", (event) => {
    if (event.target?.id === "rvTeachingLabel") redraw();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal?.classList.contains("open")) {
      closeTeaching();
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      createModal();
      installTeachingButton();
    });
  } else {
    createModal();
    installTeachingButton();
  }
})();


// === RECYCLEVISION V6.5 FLOATING LEARNING PANEL ===
(function () {
  const PANEL_ID = "rvLearningPanel";
  const RESTORE_ID = "rvLearningRestore";
  const POS_KEY = "rvLearningPanelPositionV65";
  const STATE_KEY = "rvLearningPanelStateV65";

  function getPanel() {
    return document.getElementById(PANEL_ID);
  }

  function readState() {
    try {
      return JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
    } catch (_) {
      return {};
    }
  }

  function saveState(state) {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  }

  function readPosition() {
    try {
      return JSON.parse(localStorage.getItem(POS_KEY) || "null");
    } catch (_) {
      return null;
    }
  }

  function savePosition(panel) {
    const rect = panel.getBoundingClientRect();
    localStorage.setItem(
      POS_KEY,
      JSON.stringify({
        left: Math.round(rect.left),
        top: Math.round(rect.top),
      })
    );
  }

  function clampPosition(panel, left, top) {
    const pad = 8;
    const maxLeft = Math.max(pad, window.innerWidth - panel.offsetWidth - pad);
    const maxTop = Math.max(pad, window.innerHeight - panel.offsetHeight - pad);

    return {
      left: Math.max(pad, Math.min(maxLeft, left)),
      top: Math.max(pad, Math.min(maxTop, top)),
    };
  }

  function applySavedPosition(panel) {
    const pos = readPosition();

    panel.style.position = "fixed";
    panel.style.right = "auto";
    panel.style.bottom = "auto";

    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      const next = clampPosition(panel, pos.left, pos.top);
      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
      return;
    }

    // Posición inicial: arriba a la derecha, pero completamente movible.
    panel.style.left = `${Math.max(20, window.innerWidth - panel.offsetWidth - 390)}px`;
    panel.style.top = "22px";
  }

  function ensureRestoreButton() {
    let restore = document.getElementById(RESTORE_ID);

    if (!restore) {
      restore = document.createElement("button");
      restore.id = RESTORE_ID;
      restore.type = "button";
      restore.className = "rv-learning-restore";
      restore.innerHTML = `
        <span>AI</span>
        <b>Learning</b>
        <small>abrir</small>
      `;
      document.body.appendChild(restore);
    }

    restore.addEventListener("click", () => {
      const panel = getPanel();
      if (!panel) return;

      panel.classList.remove("rv-panel-closed");
      restore.classList.remove("show");

      const state = readState();
      state.closed = false;
      saveState(state);

      setTimeout(() => applySavedPosition(panel), 0);
    });

    return restore;
  }

  function addWindowControls(panel) {
    const head = panel.querySelector(".rv-learn-head");
    if (!head || head.querySelector(".rv-window-controls")) return;

    const controls = document.createElement("div");
    controls.className = "rv-window-controls";
    controls.innerHTML = `
      <button type="button"
              class="rv-window-btn"
              id="rvLearningMinimize"
              title="Minimizar"
              aria-label="Minimizar">−</button>
      <button type="button"
              class="rv-window-btn rv-window-close"
              id="rvLearningClose"
              title="Cerrar"
              aria-label="Cerrar">×</button>
    `;

    head.appendChild(controls);

    controls.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });

    panel.querySelector("#rvLearningMinimize").addEventListener("click", (event) => {
      event.stopPropagation();

      const minimized = !panel.classList.contains("rv-panel-minimized");
      panel.classList.toggle("rv-panel-minimized", minimized);

      const state = readState();
      state.minimized = minimized;
      saveState(state);

      event.currentTarget.textContent = minimized ? "+" : "−";
      event.currentTarget.title = minimized ? "Restaurar" : "Minimizar";

      setTimeout(() => {
        const rect = panel.getBoundingClientRect();
        const next = clampPosition(panel, rect.left, rect.top);
        panel.style.left = `${next.left}px`;
        panel.style.top = `${next.top}px`;
        savePosition(panel);
      }, 0);
    });

    panel.querySelector("#rvLearningClose").addEventListener("click", (event) => {
      event.stopPropagation();

      panel.classList.add("rv-panel-closed");
      ensureRestoreButton().classList.add("show");

      const state = readState();
      state.closed = true;
      saveState(state);
    });
  }

  function makeFullyDraggable(panel) {
    const head = panel.querySelector(".rv-learn-head");
    if (!head || panel.dataset.dragV65 === "1") return;

    panel.dataset.dragV65 = "1";

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    head.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;

      const rect = panel.getBoundingClientRect();

      dragging = true;
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;

      panel.classList.add("rv-panel-dragging");
      head.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    head.addEventListener("pointermove", (event) => {
      if (!dragging) return;

      const next = clampPosition(
        panel,
        event.clientX - offsetX,
        event.clientY - offsetY
      );

      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });

    function finish() {
      if (!dragging) return;

      dragging = false;
      panel.classList.remove("rv-panel-dragging");
      savePosition(panel);
    }

    head.addEventListener("pointerup", finish);
    head.addEventListener("pointercancel", finish);

    // Doble click en el encabezado = volver a posición inicial.
    head.addEventListener("dblclick", (event) => {
      if (event.target.closest("button")) return;

      localStorage.removeItem(POS_KEY);
      applySavedPosition(panel);
      savePosition(panel);
    });
  }

  function restoreState(panel) {
    const state = readState();
    const restore = ensureRestoreButton();

    if (state.minimized) {
      panel.classList.add("rv-panel-minimized");

      const btn = panel.querySelector("#rvLearningMinimize");
      if (btn) {
        btn.textContent = "+";
        btn.title = "Restaurar";
      }
    }

    if (state.closed) {
      panel.classList.add("rv-panel-closed");
      restore.classList.add("show");
    } else {
      restore.classList.remove("show");
    }
  }

  function init() {
    const panel = getPanel();

    if (!panel) {
      setTimeout(init, 350);
      return;
    }

    if (panel.dataset.v65Ready === "1") return;
    panel.dataset.v65Ready = "1";

    addWindowControls(panel);
    makeFullyDraggable(panel);
    restoreState(panel);

    requestAnimationFrame(() => {
      applySavedPosition(panel);
    });

    window.addEventListener("resize", () => {
      if (panel.classList.contains("rv-panel-closed")) return;

      const rect = panel.getBoundingClientRect();
      const next = clampPosition(panel, rect.left, rect.top);

      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
      savePosition(panel);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();


// === RECYCLEVISION MODEL LEARNING CONTROL V6.6 ===
(function () {
  let modal = null;
  let pollTimer = null;

  function $(id) { return document.getElementById(id); }

  function ensureModal() {
    if ($("rvTrainingModal")) {
      modal = $("rvTrainingModal");
      return;
    }

    modal = document.createElement("div");
    modal.id = "rvTrainingModal";
    modal.className = "rv-training-modal";
    modal.innerHTML = `
      <section class="rv-training-shell">
        <header class="rv-training-header">
          <div>
            <span>RECYCLEVISION MODEL LEARNING</span>
            <h2>Model Learning Control Center</h2>
            <p>Ver → corregir → enseñar → entrenar → validar → promover.</p>
          </div>
          <button id="rvTrainingClose" type="button">×</button>
        </header>

        <div class="rv-training-grid">
          <section class="rv-training-card rv-training-main">
            <div class="rv-training-card-head">
              <div>
                <span>DATASET NUEVO</span>
                <strong id="rvTrainSamples">0 ejemplos</strong>
              </div>
              <div id="rvTrainReadiness" class="rv-readiness">SIN DATOS</div>
            </div>

            <div class="rv-dataset-progress">
              <div class="rv-progress-track">
                <div id="rvDatasetBar" class="rv-progress-fill"></div>
              </div>
              <div class="rv-progress-caption">
                <span id="rvDatasetCaption">0 / 20 recomendados</span>
                <span id="rvDatasetPercent">0%</span>
              </div>
            </div>

            <div id="rvTrainByLabel" class="rv-train-class-grid"></div>

            <div class="rv-train-config">
              <label>EPOCHS<input id="rvTrainEpochs" type="number" min="3" max="50" value="12"></label>
              <label>BATCH<input id="rvTrainBatch" type="number" min="1" max="64" value="16"></label>
              <label>RESOLUCIÓN
                <select id="rvTrainSize">
                  <option value="512">512</option>
                  <option value="640" selected>640</option>
                </select>
              </label>
            </div>

            <button id="rvCreateTraining" class="rv-train-primary" type="button">
              ⚡ ENTRENAR NUEVA VERSIÓN
            </button>

            <p class="rv-train-safety">
              El modelo activo nunca se reemplaza automáticamente. Cada training genera un candidato aislado.
            </p>
          </section>

          <section class="rv-training-card">
            <div class="rv-training-card-head">
              <div><span>COMPUTE</span><strong>Motor de entrenamiento</strong></div>
            </div>
            <div class="rv-compute-row"><span>Aceleración local</span><b id="rvCudaStatus">—</b></div>
            <div class="rv-compute-row"><span>Motor de IA</span><b id="rvMotor de IAStatus">—</b></div>
            <div class="rv-compute-row"><span>Procesamiento recomendado</span><b>GPU REMOTA</b></div>
            <div class="rv-compute-note">
              En la Acer el sistema prioriza inferencia. El paquete se prepara sin frenar la cámara.
            </div>
          </section>

          <section class="rv-training-card rv-training-status-card">
            <div class="rv-training-card-head">
              <div><span>PIPELINE</span><strong id="rvJobVersion">Sin entrenamiento activo</strong></div>
              <div id="rvJobStatus" class="rv-job-status">IDLE</div>
            </div>

            <div class="rv-job-stage">
              <div class="rv-stage-line"><span>Preparar dataset</span><b id="rvStageDataset">—</b></div>
              <div class="rv-stage-line"><span>Entrenamiento del modelo</span><b id="rvStageTraining">—</b></div>
              <div class="rv-stage-line"><span>Validación</span><b id="rvStageValidation">—</b></div>
              <div class="rv-stage-line"><span>Candidato</span><b id="rvStageCandidate">—</b></div>
            </div>

            <div class="rv-job-progress-wrap">
              <div class="rv-progress-track"><div id="rvJobProgress" class="rv-progress-fill"></div></div>
              <span id="rvJobMessage">Esperando nuevo job.</span>
            </div>

            <a id="rvDownloadTrainingPackage" class="rv-download-training" href="#" target="_blank" hidden>
              ⇩ DESCARGAR PAQUETE DE ENTRENAMIENTO
            </a>
          </section>

          <section class="rv-training-card">
            <div class="rv-training-card-head">
              <div><span>VERSIONADO</span><strong>Candidatos recientes</strong></div>
            </div>
            <div id="rvTrainingJobs" class="rv-training-jobs">
              <div class="rv-empty-training">Todavía no hay candidatos.</div>
            </div>
          </section>
        </div>

        <div id="rvTrainingToast" class="rv-training-toast"></div>
      </section>
    `;

    document.body.appendChild(modal);
    $("rvTrainingClose").addEventListener("click", close);
    $("rvCreateTraining").addEventListener("click", createTraining);
    modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
  }

  function installButton() {
    if ($("rvLiveTrainBtn")) return;
    const panel = $("rvLearningPanel");
    if (!panel) return setTimeout(installButton, 350);
    const actions = panel.querySelector(".rv-learn-actions");
    if (!actions) return setTimeout(installButton, 350);

    const btn = document.createElement("button");
    btn.id = "rvLiveTrainBtn";
    btn.type = "button";
    btn.className = "rv-mini-btn rv-live-train-btn";
    btn.textContent = "⚡ LIVE TRAINING";
    btn.addEventListener("click", open);
    actions.appendChild(btn);
  }

  function open() {
    ensureModal();
    modal.classList.add("open");
    refresh();
    clearInterval(pollTimer);
    pollTimer = setInterval(refresh, 1600);
  }

  function close() {
    modal?.classList.remove("open");
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function toast(message, kind = "ok") {
    const el = $("rvTrainingToast");
    if (!el) return;
    el.textContent = message;
    el.dataset.kind = kind;
    el.classList.add("show");
    clearTimeout(window.__rvTrainToast);
    window.__rvTrainToast = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function statusLabel(status) {
    const map = {
      PREPARING: "PREPARANDO",
      READY_FOR_GPU: "LISTO PARA ENTRENAR",
      TRAINING_LOCAL: "ENTRENANDO",
      CANDIDATE_READY: "CANDIDATO LISTO",
      TRAINING_FINISHED: "FINALIZADO",
      FAILED: "ERROR",
    };
    return map[status] || status || "IDLE";
  }

  function renderClasses(by) {
    const labels = [
      ["Plastic", "PLÁSTICO"], ["Metal", "METAL"], ["Glass", "VIDRIO"],
      ["Paper_Cardboard", "PAPEL/CARTÓN"], ["Organic", "ORGÁNICO"], ["Electronic", "ELECTRÓNICO"],
    ];
    $("rvTrainByLabel").innerHTML = labels.map(([key, name]) => `
      <div><span>${name}</span><b>${Number(by?.[key] || 0)}</b></div>
    `).join("");
  }

  function renderJob(job) {
    if (!job) {
      $("rvJobVersion").textContent = "Sin entrenamiento activo";
      $("rvJobStatus").textContent = "IDLE";
      $("rvJobProgress").style.width = "0%";
      $("rvJobMessage").textContent = "Esperando nuevo job.";
      $("rvStageDataset").textContent = "—";
      $("rvStageTraining").textContent = "—";
      $("rvStageValidation").textContent = "—";
      $("rvStageCandidate").textContent = "—";
      $("rvDownloadTrainingPackage").hidden = true;
      return;
    }

    $("rvJobVersion").textContent = job.candidate_version || "Candidate";
    $("rvJobStatus").textContent = statusLabel(job.status);
    $("rvJobStatus").dataset.status = job.status || "";
    $("rvJobProgress").style.width = `${Math.max(0, Math.min(100, Number(job.progress || 0)))}%`;
    $("rvJobMessage").textContent = job.message || "";

    const packageReady = Boolean(job.package_path);
    const training = job.status === "TRAINING_LOCAL";
    const candidate = job.status === "CANDIDATE_READY";

    $("rvStageDataset").textContent = packageReady ? "✓ LISTO" : "…";
    $("rvStageTraining").textContent =
      candidate ? "✓" :
      training ? "EN CURSO" :
      job.status === "READY_FOR_GPU" ? "ENTRENAMIENTO PENDIENTE" : "—";
    $("rvStageValidation").textContent = candidate ? "PENDIENTE BENCHMARK" : "—";
    $("rvStageCandidate").textContent = candidate ? "✓ DISPONIBLE" : "—";

    const link = $("rvDownloadTrainingPackage");
    if (packageReady) {
      link.hidden = false;
      link.href = `/api/training/package/${encodeURIComponent(job.id)}`;
    } else {
      link.hidden = true;
    }
  }

  function renderJobs(jobs) {
    if (!Array.isArray(jobs) || !jobs.length) {
      $("rvTrainingJobs").innerHTML = '<div class="rv-empty-training">Todavía no hay candidatos.</div>';
      return;
    }

    $("rvTrainingJobs").innerHTML = jobs.slice(0, 6).map((job) => `
      <div class="rv-job-row">
        <div><b>${job.candidate_version || "candidate"}</b><span>${job.samples || 0} ejemplos · ${job.epochs || "—"} epochs</span></div>
        <strong data-status="${job.status || ""}">${statusLabel(job.status)}</strong>
      </div>
    `).join("");
  }

  async function refresh() {
    try {
      const res = await fetch("/api/training/status", {cache: "no-store"});
      if (!res.ok) return;
      const data = await res.json();

      const samples = Number(data.teaching_samples || 0);
      const recommended = Number(data.recommended_minimum || 20);
      const percent = Math.min(100, Math.round((samples / recommended) * 100));

      $("rvTrainSamples").textContent = `${samples} ejemplo${samples === 1 ? "" : "s"}`;
      $("rvDatasetCaption").textContent = `${samples} / ${recommended} recomendados`;
      $("rvDatasetPercent").textContent = `${percent}%`;
      $("rvDatasetBar").style.width = `${percent}%`;

      const readiness = $("rvTrainReadiness");
      if (samples >= recommended) {
        readiness.textContent = "RECOMENDADO";
        readiness.dataset.level = "good";
      } else if (data.ready_for_training) {
        readiness.textContent = "EXPERIMENTAL";
        readiness.dataset.level = "warn";
      } else {
        readiness.textContent = "FALTAN DATOS";
        readiness.dataset.level = "bad";
      }

      $("rvCudaStatus").textContent = data.cuda_available ? "CUDA DISPONIBLE" : "NO / CPU";
      $("rvMotor de IAStatus").textContent = data.ultralytics_available ? "DISPONIBLE" : "NO DISPONIBLE";

      renderClasses(data.by_label || {});
      renderJob(data.active_job || data.jobs?.[0] || null);
      renderJobs(data.jobs || []);
    } catch (error) {
      console.error("Estado de entrenamiento:", error);
    }
  }

  async function createTraining() {
    const button = $("rvCreateTraining");
    button.disabled = true;
    button.textContent = "PREPARANDO CANDIDATO...";

    try {
      const payload = {
        epochs: Number($("rvTrainEpochs").value || 12),
        batch: Number($("rvTrainBatch").value || 16),
        imgsz: Number($("rvTrainSize").value || 640),
        auto_start_local: false,
      };

      const res = await fetch("/api/training/create", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

      toast(`${data.candidate_version}: paquete de entrenamiento listo`);
      renderJob(data);
      await refresh();
    } catch (error) {
      toast(error.message || "No pude crear job de entrenamiento", "error");
    } finally {
      button.disabled = false;
      button.textContent = "⚡ ENTRENAR NUEVA VERSIÓN";
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      ensureModal();
      installButton();
    });
  } else {
    ensureModal();
    installButton();
  }
})();


// === RECYCLEVISION CONSULTANT AI V6.6.2 ===
(function () {
  function activeViewName() {
    const tab = document.querySelector(".view-tab.active");
    return tab?.dataset?.view || "operationView";
  }

  async function learningContext() {
    const out = {};
    try {
      const res = await fetch("/api/learning/stats-v2", {cache: "no-store"});
      if (res.ok) out.learning = await res.json();
    } catch (_) {}

    try {
      const res = await fetch("/api/training/status", {cache: "no-store"});
      if (res.ok) {
        const data = await res.json();
        out.training = {
          teaching_samples: data.teaching_samples || 0,
          ready_for_training: Boolean(data.ready_for_training),
          last_candidate: data.last_candidate || null,
        };
      }
    } catch (_) {}

    return out;
  }

  function compactDetection(item) {
    if (!item) return {};
    return {
      material: item.material || null,
      object_name: item.object_name || null,
      confidence: item.confidence ?? null,
      container: item.container || item.container_color || null,
      recyclable: item.recyclable ?? null,
      adaptive_correction: Boolean(item.adaptive_correction),
    };
  }

  async function buildContext() {
    const extra = await learningContext();

    return {
      view: activeViewName(),
      metrics: window.rvLastServerMetrics || {},
      detection: compactDetection(window.rvCurrentDetection),
      learning: extra.learning || {},
      training: extra.training || {},
    };
  }

  function ensureAIBadge() {
    const panel = document.getElementById("consultantPanel");
    if (!panel || document.getElementById("rvConsultantAIStatus")) return;

    const header =
      panel.querySelector("header") ||
      panel.querySelector(".consultant-header") ||
      panel.firstElementChild;

    if (!header) return;

    const badge = document.createElement("span");
    badge.id = "rvConsultantAIStatus";
    badge.className = "rv-consultant-ai-status";
    badge.textContent = "IA · VERIFICANDO";
    header.appendChild(badge);

    refreshAIStatus();
  }

  async function refreshAIStatus() {
    const badge = document.getElementById("rvConsultantAIStatus");
    if (!badge) return;

    try {
      const res = await fetch("/api/consultant-ai/status", {cache: "no-store"});
      const data = await res.json();

      if (data.configured) {
        badge.textContent = "IA · ONLINE";
        badge.dataset.mode = "ai";
      } else {
        badge.textContent = "IA · MODO LOCAL";
        badge.dataset.mode = "fallback";
      }
    } catch (_) {
      badge.textContent = "IA · MODO LOCAL";
      badge.dataset.mode = "fallback";
    }
  }

  // Reemplaza askConsultant conservando todo el diseño existente.
  window.askConsultantAI = async function (question) {
    const clean = String(question || "").trim();
    if (!clean) return;

    addConsultantMessage(clean, "user");
    const input = document.getElementById("consultantInput");
    if (input) input.value = "";

    const messages = document.getElementById("consultantMessages");
    const loading = document.createElement("article");
    loading.className = "bot-message consultant-thinking";
    loading.textContent = "RecycleVision IA está analizando…";
    messages?.appendChild(loading);

    try {
      const context = await buildContext();

      let response = await apiFetch("/api/consultant-ai", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({question: clean, context}),
      });

      // Si IA externa no está configurada o falla, mantener el consultor
      // anterior para que la demo nunca quede inutilizada.
      if (!response.ok) {
        response = await apiFetch("/api/consultant", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({question: clean}),
        });
      }

      const payload = await response.json();
      loading.remove();

      addConsultantMessage(
        payload.answer || payload.detail || "No pude responder esa consulta.",
        "bot",
        payload.source || "RECYCLEVISION IA"
      );
    } catch (error) {
      loading.remove();
      addConsultantMessage(
        "No pude procesar la consulta en este momento.",
        "bot",
        "RECYCLEVISION IA"
      );
    }
  };

  // Neutralizar los listeners existentes sin reescribir la UI:
  // clonamos form/chips para eliminar handlers previos y registrar IA.
  function wireConsultantAI() {
    ensureAIBadge();

    const form = document.getElementById("consultantForm");
    const input = document.getElementById("consultantInput");

    if (form && form.dataset.aiWired !== "1") {
      form.dataset.aiWired = "1";

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.askConsultantAI(input?.value || "");
      }, true);
    }

    document.querySelectorAll(".consultant-chips button").forEach((button) => {
      if (button.dataset.aiWired === "1") return;
      button.dataset.aiWired = "1";

      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.askConsultantAI(button.textContent || "");
      }, true);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(wireConsultantAI, 200));
  } else {
    setTimeout(wireConsultantAI, 200);
  }

  setInterval(refreshAIStatus, 15000);
})();


// === RECYCLEVISION AI SETTINGS V6.6.3 ===
(function () {
  let modal = null;

  function $(id) {
    return document.getElementById(id);
  }

  function ensureModal() {
    if ($("rvAISettingsModal")) {
      modal = $("rvAISettingsModal");
      return;
    }

    modal = document.createElement("div");
    modal.id = "rvAISettingsModal";
    modal.className = "rv-ai-settings-modal";
    modal.innerHTML = `
      <section class="rv-ai-settings-shell">
        <header>
          <div>
            <span>RECYCLEVISION IA</span>
            <h3>Configuración del consultor</h3>
            <p>
              La clave queda cifrada en este equipo y nunca se devuelve al navegador.
            </p>
          </div>
          <button id="rvAISettingsClose" type="button">×</button>
        </header>

        <form id="rvAISettingsForm">
          <label>
            URL DEL MOTOR DE IA
            <input
              id="rvAIEndpoint"
              type="url"
              autocomplete="off"
              placeholder="https://..."
              required
            >
          </label>

          <label>
            MODELO
            <input
              id="rvAIModel"
              type="text"
              autocomplete="off"
              placeholder="Nombre del modelo"
              required
            >
          </label>

          <label>
            API KEY
            <div class="rv-secret-field">
              <input
                id="rvAIKey"
                type="password"
                autocomplete="new-password"
                placeholder="••••••••••••••••"
              >
              <button id="rvAIRevealKey" type="button">VER</button>
            </div>
            <small id="rvAIKeyState">No configurada</small>
          </label>

          <label>
            TIMEOUT
            <div class="rv-ai-timeout">
              <input id="rvAITimeout" type="number" min="5" max="60" value="18">
              <span>segundos</span>
            </div>
          </label>

          <div class="rv-ai-security-note">
            <b>ALMACENAMIENTO SEGURO LOCAL</b>
            <span>
              La credencial se cifra con la protección de Windows asociada al usuario
              actual. No se guarda en localStorage, JavaScript ni repositorio.
            </span>
          </div>

          <div class="rv-ai-settings-actions">
            <button id="rvAISave" class="primary" type="submit">
              GUARDAR CONFIGURACIÓN
            </button>
            <button id="rvAITest" type="button">
              PROBAR CONEXIÓN
            </button>
            <button id="rvAIDeleteKey" class="danger" type="button">
              ELIMINAR CLAVE
            </button>
          </div>
        </form>

        <div id="rvAISettingsStatus" class="rv-ai-settings-status"></div>
      </section>
    `;

    document.body.appendChild(modal);

    $("rvAISettingsClose").addEventListener("click", close);
    $("rvAISettingsForm").addEventListener("submit", save);
    $("rvAITest").addEventListener("click", testConnection);
    $("rvAIDeleteKey").addEventListener("click", deleteKey);

    $("rvAIRevealKey").addEventListener("click", () => {
      const input = $("rvAIKey");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      $("rvAIRevealKey").textContent = show ? "OCULTAR" : "VER";
    });

    modal.addEventListener("click", (event) => {
      if (event.target === modal) close();
    });
  }

  function ensureSettingsButton() {
    const panel = $("consultantPanel");
    if (!panel || $("rvAISettingsBtn")) return;

    const header =
      panel.querySelector("header") ||
      panel.querySelector(".consultant-header") ||
      panel.firstElementChild;

    if (!header) return;

    const button = document.createElement("button");
    button.id = "rvAISettingsBtn";
    button.type = "button";
    button.className = "rv-ai-settings-btn";
    button.title = "Configurar RecycleVision IA";
    button.textContent = "⚙ IA";
    button.addEventListener("click", open);

    header.appendChild(button);
  }

  async function open() {
    ensureModal();
    modal.classList.add("open");
    await load();
  }

  function close() {
    modal?.classList.remove("open");
    const keyInput = $("rvAIKey");
    if (keyInput) keyInput.value = "";
  }

  function status(message, kind = "") {
    const el = $("rvAISettingsStatus");
    if (!el) return;
    el.textContent = message;
    el.dataset.kind = kind;
  }

  async function load() {
    status("Leyendo configuración…");

    try {
      const res = await fetch("/api/settings/ai", {cache: "no-store"});
      const data = await res.json();

      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

      $("rvAIEndpoint").value = data.endpoint || "";
      $("rvAIModel").value = data.model || "";
      $("rvAIKey").value = "";
      $("rvAIKeyState").textContent = data.has_key
        ? "✓ Clave privada guardada"
        : "No configurada";

      $("rvAIKeyState").dataset.configured = data.has_key ? "1" : "0";
      status(
        data.configured
          ? "RecycleVision IA está configurado."
          : "Completá los datos para habilitar IA.",
        data.configured ? "ok" : ""
      );
    } catch (error) {
      status(error.message || "No pude leer la configuración.", "error");
    }
  }

  async function save(event) {
    event?.preventDefault();

    const endpoint = $("rvAIEndpoint").value.trim();
    const model = $("rvAIModel").value.trim();
    const apiKey = $("rvAIKey").value.trim();
    const timeout = Number($("rvAITimeout").value || 18);

    if (!endpoint || !model) {
      return status("Completá URL y modelo.", "error");
    }

    const button = $("rvAISave");
    button.disabled = true;
    button.textContent = "GUARDANDO…";

    try {
      const payload = {
        endpoint,
        model,
        timeout,
      };

      if (apiKey) {
        payload.api_key = apiKey;
      }

      const res = await fetch("/api/settings/ai", {
        method: "PUT",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

      $("rvAIKey").value = "";
      $("rvAIKeyState").textContent = data.has_key
        ? "✓ Clave privada guardada"
        : "No configurada";
      $("rvAIKeyState").dataset.configured = data.has_key ? "1" : "0";

      status(
        data.configured
          ? "Configuración guardada. RecycleVision IA está listo."
          : "Configuración guardada; falta una clave privada.",
        data.configured ? "ok" : ""
      );

      if (typeof refreshAIStatus === "function") {
        refreshAIStatus();
      }
    } catch (error) {
      status(error.message || "No pude guardar la configuración.", "error");
    } finally {
      button.disabled = false;
      button.textContent = "GUARDAR CONFIGURACIÓN";
    }
  }

  async function testConnection() {
    status("Probando conexión…");

    // Guardar primero los cambios actuales.
    const endpoint = $("rvAIEndpoint").value.trim();
    const model = $("rvAIModel").value.trim();
    const apiKey = $("rvAIKey").value.trim();
    const timeout = Number($("rvAITimeout").value || 18);

    try {
      const payload = {endpoint, model, timeout};
      if (apiKey) payload.api_key = apiKey;

      let res = await fetch("/api/settings/ai", {
        method: "PUT",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
      });

      let data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

      $("rvAIKey").value = "";

      res = await fetch("/api/consultant-ai", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          question: "Respondé solamente: conexión correcta",
          context: {},
        }),
      });

      data = await res.json();

      if (!res.ok) {
        throw new Error(data.detail || "El motor de IA no respondió.");
      }

      status("✓ Conexión correcta. RecycleVision IA está online.", "ok");
      await load();
    } catch (error) {
      status(error.message || "No se pudo conectar.", "error");
    }
  }

  async function deleteKey() {
    if (!window.confirm("¿Eliminar la API key guardada en este equipo?")) return;

    try {
      const res = await fetch("/api/settings/ai/key", {method: "DELETE"});
      const data = await res.json();

      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

      $("rvAIKey").value = "";
      $("rvAIKeyState").textContent = "No configurada";
      $("rvAIKeyState").dataset.configured = "0";
      status("Clave eliminada.", "ok");
    } catch (error) {
      status(error.message || "No pude eliminar la clave.", "error");
    }
  }

  function init() {
    ensureModal();

    if (!$("consultantPanel")) {
      setTimeout(init, 300);
      return;
    }

    ensureSettingsButton();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
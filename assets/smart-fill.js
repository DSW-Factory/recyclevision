// RecycleVision Smart Fill v2
// Dataset lab + polygon segmentation + YOLO-Seg export.
(() => {
  const $ = id => document.getElementById(id);
  const DB_NAME = "recyclevision_smartfill";
  const STORE = "samples";
  const DIAMETER_M = 1.0;

  let currentBlob = null;
  let currentName = null;
  let currentBitmap = null;
  let currentSourceType = null;
  let videoObjectUrl = null;
  let queue = [];
  let queueIndex = -1;

  let polygon = [];
  let polygonClosed = false;
  let drawingPolygon = false;

  function dbOpen(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,1);
      req.onupgradeneeded=()=>{
        const db=req.result;
        if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE,{keyPath:"id"});
      };
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
  }

  async function dbGetAll(){
    const db=await dbOpen();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,"readonly");
      const req=tx.objectStore(STORE).getAll();
      req.onsuccess=()=>resolve(req.result||[]);
      req.onerror=()=>reject(req.error);
    });
  }

  async function dbPut(row){
    const db=await dbOpen();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,"readwrite");
      tx.objectStore(STORE).put(row);
      tx.oncomplete=resolve;
      tx.onerror=()=>reject(tx.error);
    });
  }

  function fillBin(level){
    if(level < 10) return 0;
    if(level < 35) return 25;
    if(level < 60) return 50;
    if(level < 80) return 70;
    if(level < 95) return 85;
    return 100;
  }

  async function refreshDatasetStats(){
    try{
      const rows=await dbGetAll();
      $("sfSampleCount").textContent=`${rows.length} MUESTRA${rows.length===1?"":"S"}`;

      const covered=new Set(rows.map(r=>fillBin(Number(r.level_percent||0))));
      const bins=[0,25,50,70,85,100];
      bins.forEach(bin=>{
        const el=document.querySelector(`#sfCoverageBins [data-bin="${bin}"]`);
        if(el) el.classList.toggle("covered",covered.has(bin));
      });
      $("sfCoverageText").textContent=`${covered.size}/6 estados`;
    }catch(error){
      console.warn("Smart Fill stats",error);
    }
  }

  function volumeLiters(level){
    const h=Number($("sfHeight").value||0);
    if(!h) return null;
    const area=Math.PI*Math.pow(DIAMETER_M/2,2);
    return area*h*(level/100)*1000;
  }

  function render(){
    const level=Number($("sfLevel").value||0);
    $("sfLevelValue").textContent=level;
    $("sfLevelKpi").textContent=level;
    $("sfLevelOverlay").style.height=level+"%";
    $("sfLevelOverlay").querySelector("span").textContent=level+"%";

    const h=Number($("sfHeight").value||0);
    $("sfHeightDisplay").textContent=h ? h.toFixed(2)+" m" : "—";
    const v=volumeLiters(level);
    $("sfVolumeKpi").textContent=v==null ? "—" : Math.round(v)+" L";

    const box=$("sfResult");
    if(level>=90){
      box.dataset.state="collect";
      $("sfState").textContent="RECOLECCIÓN RECOMENDADA";
      $("sfStateCopy").textContent="El contenedor alcanzó el umbral operativo de retiro.";
    }else if(level>=80){
      box.dataset.state="near";
      $("sfState").textContent="PRÓXIMO A RECOLECCIÓN";
      $("sfStateCopy").textContent="Conviene planificar el retiro.";
    }else{
      box.dataset.state="normal";
      $("sfState").textContent="NORMAL";
      $("sfStateCopy").textContent="Contenedor con capacidad disponible.";
    }
    updateSaveState();
  }

  async function blobToBitmap(blob){
    if("createImageBitmap" in window){
      return await createImageBitmap(blob);
    }
    return await new Promise((resolve,reject)=>{
      const img=new Image();
      const url=URL.createObjectURL(blob);
      img.onload=()=>{URL.revokeObjectURL(url);resolve(img);};
      img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error("No se pudo abrir la imagen"));};
      img.src=url;
    });
  }

  function resetPolygon(){
    polygon=[];
    polygonClosed=false;
    drawingPolygon=false;
    updatePolygonUi();
    redrawCanvas();
  }

  function updatePolygonUi(){
    const status=$("sfPolygonStatus");
    const level=Number($("sfLevel")?.value||0);
    if(level===0 && !polygonClosed){
      status.textContent="Negativo válido · contenedor vacío";
      status.dataset.state="ok";
    }else if(polygonClosed){
      status.textContent=`Máscara lista · ${polygon.length} puntos`;
      status.dataset.state="ok";
    }else if(drawingPolygon){
      status.textContent=`Marcando · ${polygon.length} puntos`;
      status.dataset.state="drawing";
    }else{
      status.textContent="Sin máscara";
      status.dataset.state="idle";
    }
    $("sfUndoPoint").disabled=polygon.length===0 || polygonClosed;
    $("sfClosePolygon").disabled=polygon.length<3 || polygonClosed;
    $("sfClearPolygon").disabled=polygon.length===0;
    $("sfDrawPolygon").classList.toggle("active",drawingPolygon);
    updateSaveState();
  }

  function redrawCanvas(){
    const c=$("sfCanvas");
    if(!c || !c.width || !c.height || !currentBitmap) return;
    const ctx=c.getContext("2d");
    ctx.clearRect(0,0,c.width,c.height);
    ctx.drawImage(currentBitmap,0,0,c.width,c.height);

    if(polygon.length){
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(polygon[0].x,polygon[0].y);
      for(let i=1;i<polygon.length;i++) ctx.lineTo(polygon[i].x,polygon[i].y);
      if(polygonClosed) ctx.closePath();

      ctx.lineWidth=Math.max(3,c.width/400);
      ctx.strokeStyle="#69ed9a";
      ctx.stroke();

      if(polygonClosed){
        ctx.fillStyle="rgba(105,237,154,.20)";
        ctx.fill();
      }

      const radius=Math.max(5,c.width/180);
      polygon.forEach((p,i)=>{
        ctx.beginPath();
        ctx.arc(p.x,p.y,radius,0,Math.PI*2);
        ctx.fillStyle=i===0 ? "#ffd166" : "#69ed9a";
        ctx.fill();
        ctx.strokeStyle="#06100b";
        ctx.lineWidth=Math.max(1,c.width/900);
        ctx.stroke();
      });
      ctx.restore();
    }
  }

  function canvasPoint(event){
    const c=$("sfCanvas");
    const rect=c.getBoundingClientRect();
    const clientX=event.touches?.[0]?.clientX ?? event.clientX;
    const clientY=event.touches?.[0]?.clientY ?? event.clientY;
    return {
      x:(clientX-rect.left)*(c.width/rect.width),
      y:(clientY-rect.top)*(c.height/rect.height)
    };
  }

  function onCanvasPointer(event){
    if(!drawingPolygon || polygonClosed || !currentBitmap) return;
    event.preventDefault();
    polygon.push(canvasPoint(event));
    updatePolygonUi();
    redrawCanvas();
  }

  function normalizedPolygon(){
    const c=$("sfCanvas");
    if(!polygonClosed || polygon.length<3 || !c.width || !c.height) return [];
    return polygon.map(p=>({
      x:+Math.max(0,Math.min(1,p.x/c.width)).toFixed(6),
      y:+Math.max(0,Math.min(1,p.y/c.height)).toFixed(6)
    }));
  }

  function updateSaveState(){
    const level=Number($("sfLevel")?.value||0);
    const maskOk=level===0 || (polygonClosed && polygon.length>=3);
    $("sfSaveSample").disabled=!(currentBlob && maskOk);
  }

  async function showImageBlob(blob,name,sourceType="image"){
    currentBlob=blob;
    currentName=name||"smartfill.jpg";
    currentSourceType=sourceType;
    currentBitmap=await blobToBitmap(blob);

    const c=$("sfCanvas");
    c.width=currentBitmap.width||currentBitmap.naturalWidth;
    c.height=currentBitmap.height||currentBitmap.naturalHeight;
    c.hidden=false;
    $("sfVideo").hidden=true;
    $("sfEmpty").style.display="none";
    $("sfQueueStatus").textContent=`Lista para etiquetar · ${currentName}`;

    resetPolygon();
    redrawCanvas();
    updateQueueUi();
  }

  async function canvasFromImage(file){
    await showImageBlob(file,file.name,"image");
  }

  function loadVideo(file){
    if(videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl=URL.createObjectURL(file);
    const v=$("sfVideo");
    v.src=videoObjectUrl;
    v.hidden=false;
    $("sfCanvas").hidden=true;
    $("sfEmpty").style.display="none";
    $("sfCaptureFrame").disabled=false;
    currentBlob=null;
    currentBitmap=null;
    currentName=file.name;
    currentSourceType="video";
    $("sfQueueStatus").textContent=`Video listo · ${file.name} · elegí un instante y capturá frame`;
    resetPolygon();
    updateQueueUi();
  }

  async function captureFrame(){
    const v=$("sfVideo");
    if(!v.videoWidth) return;
    const temp=document.createElement("canvas");
    temp.width=v.videoWidth;
    temp.height=v.videoHeight;
    temp.getContext("2d").drawImage(v,0,0,temp.width,temp.height);
    const blob=await new Promise(resolve=>temp.toBlob(resolve,"image/jpeg",.94));
    const base=(currentName||"video").replace(/\.[^.]+$/,"");
    const time=Number(v.currentTime||0).toFixed(2).replace(".","_");
    await showImageBlob(blob,`${base}_${time}s.jpg`,"video_frame");
  }

  async function loadQueueItem(index){
    if(index<0 || index>=queue.length) return;
    queueIndex=index;
    const file=queue[index];
    if(file.type.startsWith("video/")) loadVideo(file);
    else if(file.type.startsWith("image/")) await canvasFromImage(file);
    updateQueueUi();
  }

  async function advanceQueue(){
    if(queueIndex+1 < queue.length){
      await loadQueueItem(queueIndex+1);
    }else{
      updateQueueUi();
    }
  }

  function updateQueueUi(){
    const remaining=Math.max(0,queue.length-(queueIndex+1));
    const current=queueIndex>=0 ? queueIndex+1 : 0;
    $("sfQueueStatus").textContent=queue.length
      ? `Archivo ${current}/${queue.length} · ${remaining} pendiente${remaining===1?"":"s"}`
      : "Sin archivos en cola";
    $("sfNextMedia").disabled=!(queueIndex+1 < queue.length);
  }

  async function saveSample(){
    if(!currentBlob) return;
    const level=Number($("sfLevel").value||0);
    if(level>0 && (!polygonClosed || polygon.length<3)){
      alert("Para niveles mayores a 0%, marcá primero la zona ocupada por los plásticos.");
      return;
    }

    const h=Number($("sfHeight").value||0)||null;
    const c=$("sfCanvas");
    const id="sf_"+Date.now()+"_"+Math.random().toString(36).slice(2,8);
    const row={
      id,
      created_at:new Date().toISOString(),
      source_name:currentName||"capture.jpg",
      source_type:currentSourceType||"unknown",
      width:c.width,
      height:c.height,
      level_percent:level,
      fill_bin:fillBin(level),
      diameter_m:DIAMETER_M,
      useful_height_m:h,
      estimated_volume_l:h?Math.round(volumeLiters(level)*10)/10:null,
      target_class:"plastic_fill",
      polygon:normalizedPolygon(),
      image_blob:currentBlob
    };

    await dbPut(row);
    await refreshDatasetStats();

    const b=$("sfSaveSample");
    const old=b.textContent;
    b.textContent="✓ MUESTRA + MÁSCARA GUARDADA";
    setTimeout(()=>b.textContent=old,1300);

    if(queueIndex+1 < queue.length){
      setTimeout(()=>advanceQueue(),350);
    }
  }

  async function exportDataset(){
    const rows=await dbGetAll();
    if(!rows.length){
      alert("Todavía no hay muestras guardadas en Smart Fill.");
      return;
    }

    const button=$("sfExportDataset");
    const old=button.textContent;
    button.disabled=true;
    button.textContent="PREPARANDO ZIP...";

    try{
      const mod=await import("https://esm.sh/jszip@3.10.1");
      const JSZip=mod.default;
      const zip=new JSZip();

      const manifest=[];
      const sorted=[...rows].sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));

      for(let i=0;i<sorted.length;i++){
        const row=sorted[i];
        const split=(i%5===0 && sorted.length>=5) ? "val" : "train";
        const base=`sf_${String(i+1).padStart(4,"0")}`;
        const imagePath=`images/${split}/${base}.jpg`;
        const labelPath=`labels/${split}/${base}.txt`;

        zip.file(imagePath,row.image_blob);

        let label="";
        if(Array.isArray(row.polygon) && row.polygon.length>=3){
          const coords=row.polygon.flatMap(p=>[p.x,p.y]).join(" ");
          label=`0 ${coords}\n`;
        }
        zip.file(labelPath,label);

        manifest.push({
          id:row.id,
          image:imagePath,
          label:labelPath,
          split,
          source_name:row.source_name,
          source_type:row.source_type,
          width:row.width,
          height:row.height,
          level_percent:row.level_percent,
          fill_bin:row.fill_bin,
          diameter_m:row.diameter_m,
          useful_height_m:row.useful_height_m,
          estimated_volume_l:row.estimated_volume_l,
          target_class:"plastic_fill",
          polygon_points:Array.isArray(row.polygon)?row.polygon.length:0,
          created_at:row.created_at
        });
      }

      zip.file("data.yaml",
`path: .
train: images/train
val: images/val

names:
  0: plastic_fill
`);

      zip.file("manifest.json",JSON.stringify(manifest,null,2));
      zip.file("README.txt",
`RecycleVision Smart Fill — YOLO Segmentation dataset

Class:
0 = plastic_fill

Geometry:
Known container diameter = 1.00 m.
Useful internal height must be measured in the field before total liters are treated as calibrated.

Labels:
YOLO segmentation format.
Each non-empty label line is:
class x1 y1 x2 y2 ... xn yn

Important:
Level 0% samples may intentionally have an empty label file and act as negative examples.
The level_percent value is stored in manifest.json for later calibration/regression.
`);

      const blob=await zip.generateAsync({type:"blob",compression:"DEFLATE",compressionOptions:{level:6}});
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;
      a.download=`RecycleVision-SmartFill-YOLOSeg-${new Date().toISOString().slice(0,10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),4000);

      button.textContent=`✓ DATASET EXPORTADO · ${rows.length} MUESTRAS`;
    }catch(error){
      console.error("Smart Fill export",error);
      alert("No se pudo exportar el dataset: "+String(error?.message||error));
      button.textContent=old;
    }finally{
      button.disabled=false;
      setTimeout(()=>{button.textContent=old;},1800);
    }
  }

  function clearMedia(){
    const c=$("sfCanvas");
    c.width=0;
    c.height=0;
    c.hidden=false;

    const v=$("sfVideo");
    v.pause();
    v.removeAttribute("src");
    v.load();
    v.hidden=true;

    if(videoObjectUrl){
      URL.revokeObjectURL(videoObjectUrl);
      videoObjectUrl=null;
    }

    $("sfEmpty").style.display="flex";
    $("sfCaptureFrame").disabled=true;
    currentBlob=null;
    currentBitmap=null;
    currentName=null;
    currentSourceType=null;
    resetPolygon();
  }

  function init(){
    if(!$("smartFillView")) return;

    $("sfLevel").addEventListener("input",()=>{
      render();
      updatePolygonUi();
    });

    $("sfHeight").addEventListener("input",()=>{
      localStorage.setItem("rv_sf_height",$("sfHeight").value);
      render();
    });

    const fileInput=$("sfFileInput");
    const uploadBtn=$("sfUploadBtn");

    uploadBtn.addEventListener("click",()=>{
      $("sfQueueStatus").textContent="Seleccioná fotos o un video...";
      fileInput.click();
    });

    fileInput.addEventListener("change",async event=>{
      const files=[...(event.target.files||[])];
      if(!files.length){
        $("sfQueueStatus").textContent="No seleccionaste archivos";
        return;
      }

      $("sfQueueStatus").textContent=`Cargando ${files.length} archivo${files.length===1?"":"s"}...`;
      uploadBtn.disabled=true;

      try{
        queue=files;
        queueIndex=-1;
        await loadQueueItem(0);
      }catch(error){
        console.error("Smart Fill media load",error);
        $("sfQueueStatus").textContent="ERROR AL CARGAR";
        alert("No se pudo abrir el archivo seleccionado: "+String(error?.message||error));
      }finally{
        uploadBtn.disabled=false;
        event.target.value="";
      }
    });

    // También permite soltar fotos/videos directamente sobre el visor.
    const dropZone=$("sfMediaStage");
    ["dragenter","dragover"].forEach(type=>dropZone.addEventListener(type,event=>{
      event.preventDefault();
      dropZone.classList.add("drag-over");
    }));
    ["dragleave","drop"].forEach(type=>dropZone.addEventListener(type,event=>{
      event.preventDefault();
      dropZone.classList.remove("drag-over");
    }));
    dropZone.addEventListener("drop",async event=>{
      const files=[...(event.dataTransfer?.files||[])].filter(file=>
        file.type.startsWith("image/") || file.type.startsWith("video/")
      );
      if(!files.length){
        $("sfQueueStatus").textContent="El archivo no es una foto o video compatible";
        return;
      }
      $("sfQueueStatus").textContent=`Cargando ${files.length} archivo${files.length===1?"":"s"}...`;
      try{
        queue=files;
        queueIndex=-1;
        await loadQueueItem(0);
      }catch(error){
        console.error("Smart Fill drag/drop",error);
        $("sfQueueStatus").textContent="ERROR AL CARGAR";
        alert("No se pudo abrir el archivo: "+String(error?.message||error));
      }
    });

    $("sfCaptureFrame").addEventListener("click",captureFrame);
    $("sfNextMedia").addEventListener("click",advanceQueue);
    $("sfClearMedia").addEventListener("click",clearMedia);
    $("sfSaveSample").addEventListener("click",saveSample);
    $("sfExportDataset").addEventListener("click",exportDataset);

    $("sfDrawPolygon").addEventListener("click",()=>{
      if(!currentBitmap){
        alert("Primero cargá una foto o capturá un frame del video.");
        return;
      }
      if(polygonClosed) resetPolygon();
      drawingPolygon=!drawingPolygon;
      updatePolygonUi();
    });

    $("sfUndoPoint").addEventListener("click",()=>{
      if(polygonClosed || !polygon.length) return;
      polygon.pop();
      updatePolygonUi();
      redrawCanvas();
    });

    $("sfClosePolygon").addEventListener("click",()=>{
      if(polygon.length<3) return;
      polygonClosed=true;
      drawingPolygon=false;
      updatePolygonUi();
      redrawCanvas();
    });

    $("sfClearPolygon").addEventListener("click",resetPolygon);

    $("sfCanvas").addEventListener("pointerdown",onCanvasPointer);

    const saved=localStorage.getItem("rv_sf_height");
    if(saved) $("sfHeight").value=saved;

    render();
    updatePolygonUi();
    updateQueueUi();
    refreshDatasetStats();
  }

  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",init);
  else init();
})();

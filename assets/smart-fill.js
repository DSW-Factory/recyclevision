// RecycleVision Smart Fill v1
(() => {
  const $ = id => document.getElementById(id);
  const DB_NAME = "recyclevision_smartfill";
  const STORE = "samples";
  const DIAMETER_M = 1.0;
  let currentBlob = null;
  let currentName = null;
  let videoObjectUrl = null;

  function dbOpen(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,1);
      req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:"id"});};
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
  }
  async function countSamples(){
    try{
      const db=await dbOpen();
      const tx=db.transaction(STORE,"readonly");
      const req=tx.objectStore(STORE).count();
      req.onsuccess=()=>{$("sfSampleCount").textContent=`${req.result} MUESTRA${req.result===1?"":"S"}`;};
    }catch{}
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
    $("sfHeightDisplay").textContent=h? h.toFixed(2)+" m":"—";
    const v=volumeLiters(level);
    $("sfVolumeKpi").textContent=v==null?"—":Math.round(v)+" L";

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
  }

  function canvasFromImage(file){
    return new Promise((resolve,reject)=>{
      const img=new Image();
      const url=URL.createObjectURL(file);
      img.onload=()=>{
        const c=$("sfCanvas"),ctx=c.getContext("2d");
        c.width=img.naturalWidth;c.height=img.naturalHeight;
        ctx.drawImage(img,0,0);
        URL.revokeObjectURL(url);
        c.hidden=false;$("sfVideo").hidden=true;$("sfEmpty").style.display="none";
        c.toBlob(blob=>{currentBlob=blob;currentName=file.name;$("sfSaveSample").disabled=!blob;resolve();},"image/jpeg",.92);
      };
      img.onerror=reject;img.src=url;
    });
  }

  function loadVideo(file){
    if(videoObjectUrl)URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl=URL.createObjectURL(file);
    const v=$("sfVideo");
    v.src=videoObjectUrl;v.hidden=false;$("sfCanvas").hidden=true;$("sfEmpty").style.display="none";
    $("sfCaptureFrame").disabled=false;
    currentBlob=null;currentName=file.name;$("sfSaveSample").disabled=true;
  }

  function captureFrame(){
    const v=$("sfVideo");
    if(!v.videoWidth)return;
    const c=$("sfCanvas"),ctx=c.getContext("2d");
    c.width=v.videoWidth;c.height=v.videoHeight;
    ctx.drawImage(v,0,0,c.width,c.height);
    c.hidden=false;v.hidden=true;
    c.toBlob(blob=>{currentBlob=blob;currentName=(currentName||"video").replace(/\.[^.]+$/,"")+"_frame.jpg";$("sfSaveSample").disabled=!blob;},"image/jpeg",.92);
  }

  async function saveSample(){
    if(!currentBlob)return;
    const level=Number($("sfLevel").value||0);
    const h=Number($("sfHeight").value||0)||null;
    const id="sf_"+Date.now()+"_"+Math.random().toString(36).slice(2,8);
    const row={
      id,
      created_at:new Date().toISOString(),
      source_name:currentName||"capture.jpg",
      level_percent:level,
      diameter_m:DIAMETER_M,
      useful_height_m:h,
      estimated_volume_l:h?Math.round(volumeLiters(level)*10)/10:null,
      target_class:"plastic_fill",
      image_blob:currentBlob
    };
    const db=await dbOpen();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,"readwrite");
      tx.objectStore(STORE).put(row);
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });
    await countSamples();
    const b=$("sfSaveSample");
    const old=b.textContent;b.textContent="✓ MUESTRA GUARDADA";
    setTimeout(()=>b.textContent=old,1300);
  }

  function clearMedia(){
    const c=$("sfCanvas");c.width=0;c.height=0;c.hidden=false;
    const v=$("sfVideo");v.pause();v.removeAttribute("src");v.load();v.hidden=true;
    if(videoObjectUrl){URL.revokeObjectURL(videoObjectUrl);videoObjectUrl=null;}
    $("sfEmpty").style.display="flex";
    $("sfCaptureFrame").disabled=true;$("sfSaveSample").disabled=true;
    currentBlob=null;currentName=null;
  }

  function init(){
    if(!$("smartFillView"))return;
    $("sfLevel").addEventListener("input",render);
    $("sfHeight").addEventListener("input",()=>{localStorage.setItem("rv_sf_height",$("sfHeight").value);render();});
    $("sfFileInput").addEventListener("change",async e=>{
      const file=e.target.files?.[0]; if(!file)return;
      if(file.type.startsWith("video/"))loadVideo(file); else if(file.type.startsWith("image/"))await canvasFromImage(file);
      e.target.value="";
    });
    $("sfCaptureFrame").addEventListener("click",captureFrame);
    $("sfClearMedia").addEventListener("click",clearMedia);
    $("sfSaveSample").addEventListener("click",saveSample);
    const saved=localStorage.getItem("rv_sf_height");if(saved)$("sfHeight").value=saved;
    render();countSamples();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();

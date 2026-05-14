const $ = id => document.getElementById(id);

const HR_SERVICE = 0x180D;
const HR_MEASUREMENT = 0x2A37;
const FTMS_SERVICE = 0x1826;
const INDOOR_BIKE_DATA = 0x2AD2;

let workout = [];
let loadedName = "";
let startedAt = 0;
let elapsedBeforePause = 0;
let playing = false;
let timer = null;
let simTimer = null;
let simOn = false;
let currentPower = null;
let bias = 1.0;
let ergReady = false;

function supportsBluetooth(){ return !!navigator.bluetooth; }
function ftp(){ return Number($("ftpInput").value || 250); }
function formatTime(sec){
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = sec%60;
  if(h>0) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return `${m}:${String(s).padStart(2,"0")}`;
}
function setStatus(prefix, state, text){
  let cls = "dot";
  if(state === "ok") cls += " ok";
  if(state === "bad") cls += " bad";
  if(state === "warn") cls += " warn";
  $(prefix+"Dot").className = cls;
  $(prefix+"Status").textContent = text;
}
function parseHeartRate(value){
  const flags = value.getUint8(0);
  const rate16 = flags & 0x1;
  return rate16 ? value.getUint16(1, true) : value.getUint8(1);
}

async function connectHR(){
  if(!supportsBluetooth()){ alert("Web Bluetooth is not available in this browser."); return; }
  try{
    const device = await navigator.bluetooth.requestDevice({ filters:[{services:[HR_SERVICE]}] });
    setStatus("hr", "warn", "Connecting to " + (device.name || "monitor") + "...");
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(HR_SERVICE);
    const char = await service.getCharacteristic(HR_MEASUREMENT);
    await char.startNotifications();
    char.addEventListener("characteristicvaluechanged", e=>{
      $("hrVal").textContent = parseHeartRate(e.target.value);
    });
    setStatus("hr", "ok", device.name || "Heart-rate monitor connected");
    device.addEventListener("gattserverdisconnected", ()=>{
      setStatus("hr", "bad", "Disconnected");
      $("hrVal").textContent = "--";
    });
  }catch(err){
    console.error(err);
    setStatus("hr", "bad", "Connection failed or cancelled");
  }
}

function parseIndoorBikeData(value){
  let offset = 0;
  const flags = value.getUint16(offset, true);
  offset += 2;
  let data = {};
  if(!(flags & 0x0001)){
    data.speed = value.getUint16(offset, true) / 100;
    offset += 2;
  }
  if(flags & 0x0002) offset += 2;
  if(flags & 0x0004){
    data.cadence = value.getUint16(offset, true) / 2;
    offset += 2;
  }
  if(flags & 0x0008) offset += 2;
  if(flags & 0x0010) offset += 3;
  if(flags & 0x0020) offset += 2;
  if(flags & 0x0040){
    data.power = value.getInt16(offset, true);
    offset += 2;
  }
  return data;
}

async function connectTrainer(){
  if(!supportsBluetooth()){ alert("Web Bluetooth is not available in this browser."); return; }
  try{
    const device = await navigator.bluetooth.requestDevice({
      filters:[{services:[FTMS_SERVICE]}],
      optionalServices:[FTMS_SERVICE]
    });
    setStatus("trainer", "warn", "Connecting to " + (device.name || "trainer") + "...");
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(FTMS_SERVICE);
    const char = await service.getCharacteristic(INDOOR_BIKE_DATA);
    await char.startNotifications();
    char.addEventListener("characteristicvaluechanged", e=>{
      const data = parseIndoorBikeData(e.target.value);
      if(Number.isFinite(data.power)){ currentPower = Math.round(data.power); $("powerVal").textContent = currentPower; }
      if(Number.isFinite(data.cadence)) $("cadenceVal").textContent = Math.round(data.cadence);
      if(Number.isFinite(data.speed)) $("speedVal").textContent = data.speed.toFixed(1);
      updateFeedback();
    });
    setStatus("trainer", "ok", device.name || "Smart trainer connected");
    device.addEventListener("gattserverdisconnected", ()=>{
      setStatus("trainer", "bad", "Disconnected");
      currentPower = null;
      $("powerVal").textContent = "--";
      $("cadenceVal").textContent = "--";
      $("speedVal").textContent = "--";
    });
  }catch(err){
    console.error(err);
    setStatus("trainer", "bad", "Connection failed or cancelled");
  }
}

function loadDemo(){
  const demo = `<?xml version="1.0" encoding="UTF-8"?>
<workout_file>
  <name>Demo ZWO Workout</name>
  <sportType>bike</sportType>
  <workout>
    <Warmup Duration="300" PowerLow="0.45" PowerHigh="0.70"/>
    <SteadyState Duration="360" Power="0.78"/>
    <IntervalsT Repeat="4" OnDuration="60" OffDuration="60" OnPower="1.10" OffPower="0.55"/>
    <Cooldown Duration="300" PowerLow="0.65" PowerHigh="0.40"/>
  </workout>
</workout_file>`;
  parseZwo(demo, "Demo ZWO Workout");
}
function getAttr(node, name, fallback=null){
  const v = node.getAttribute(name);
  return v === null ? fallback : v;
}

function parseZwo(xmlText, fallbackName="Loaded Workout"){
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const parserError = doc.querySelector("parsererror");
  if(parserError){ alert("Could not read this ZWO file."); return; }

  loadedName = doc.querySelector("name")?.textContent?.trim() || fallbackName;
  const nodes = Array.from(doc.querySelectorAll("workout > *"));
  const blocks = [];

  nodes.forEach(n=>{
    const tag = n.tagName;
    if(tag === "Warmup" || tag === "Cooldown"){
      blocks.push({
        type: tag,
        duration: Number(getAttr(n,"Duration",0)),
        low: Number(getAttr(n,"PowerLow",0.5)),
        high: Number(getAttr(n,"PowerHigh",0.7)),
        source: tag
      });
    }else if(tag === "SteadyState" || tag === "FreeRide"){
      blocks.push({
        type: tag,
        duration: Number(getAttr(n,"Duration",0)),
        power: Number(getAttr(n,"Power",0.6)),
        source: tag
      });
    }else if(tag === "IntervalsT"){
      const repeat = Number(getAttr(n,"Repeat",1));
      const onDur = Number(getAttr(n,"OnDuration",0));
      const offDur = Number(getAttr(n,"OffDuration",0));
      for(let i=0;i<repeat;i++){
        blocks.push({type:`Interval ${i+1} On`, duration:onDur, power:Number(getAttr(n,"OnPower",1.0)), source:"IntervalsT"});
        blocks.push({type:`Interval ${i+1} Off`, duration:offDur, power:Number(getAttr(n,"OffPower",0.5)), source:"IntervalsT"});
      }
    }
  });

  workout = blocks.filter(b => b.duration > 0);
  $("zwoStatus").textContent = loadedName + " loaded";
  $("zwoDot").className = "dot ok";
  elapsedBeforePause = 0;
  playing = false;
  setControls();
  render();
}

function totalDuration(){ return workout.reduce((s,b)=>s+b.duration,0); }
function currentElapsed(){
  return playing ? (Date.now()-startedAt)/1000 + elapsedBeforePause : elapsedBeforePause;
}
function blockAt(seconds){
  let t = 0;
  for(let i=0;i<workout.length;i++){
    const b = workout[i];
    if(seconds >= t && seconds < t + b.duration){
      return {block:b, index:i, start:t, end:t+b.duration};
    }
    t += b.duration;
  }
  return null;
}
function targetAt(seconds){
  const hit = blockAt(seconds);
  if(!hit) return null;
  const {block:b,start,end,index} = hit;
  const local = seconds - start;
  let pct = b.power;
  if(b.low !== undefined && b.high !== undefined){
    const p = Math.max(0, Math.min(1, local / b.duration));
    pct = b.low + (b.high-b.low)*p;
  }
  pct *= bias;
  return {block:b, index, pct, watts: Math.round(pct * ftp()), start, end};
}
function nextBlock(index){
  return workout[index+1] || null;
}
function drawGraph(elapsed=0){
  const canvas = $("graph");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  for(let i=1;i<5;i++){
    const y = i*h/5;
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
  }

  const total = Math.max(1,totalDuration());
  const maxPct = Math.max(1.3, ...workout.map(b=>Math.max(b.power||0,b.low||0,b.high||0))) * 1.15;
  let x = 0;

  ctx.strokeStyle = "#fc5200";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.beginPath();

  workout.forEach((b, idx)=>{
    const x1 = (x/total)*w;
    const x2 = ((x+b.duration)/total)*w;
    const p1 = (b.low !== undefined ? b.low : b.power) * bias;
    const p2 = (b.high !== undefined ? b.high : b.power) * bias;
    const y1 = h - (p1/maxPct)*(h-28) - 14;
    const y2 = h - (p2/maxPct)*(h-28) - 14;
    if(idx===0) ctx.moveTo(x1,y1);
    else ctx.lineTo(x1,y1);
    ctx.lineTo(x2,y2);
    x += b.duration;
  });
  ctx.stroke();

  const px = Math.min(w, (elapsed/total)*w);
  ctx.strokeStyle = "#00a3ff";
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(px,0); ctx.lineTo(px,h); ctx.stroke();

  ctx.fillStyle = "#111827";
  ctx.font = "13px Arial";
  ctx.fillText(formatTime(total), w-70, h-12);
}
function updateFeedback(){
  const target = targetAt(currentElapsed());
  if(!target || currentPower === null){
    $("feedbackTitle").textContent = "Actual vs Target";
    $("feedbackText").textContent = "Connect trainer or use simulate mode.";
    return;
  }
  const diff = currentPower - target.watts;
  const abs = Math.abs(diff);
  if(abs <= 10){
    $("feedbackTitle").textContent = "On Target";
    $("feedbackText").textContent = `${currentPower}w actual / ${target.watts}w target`;
  }else if(diff > 0){
    $("feedbackTitle").textContent = `${abs}w Over`;
    $("feedbackText").textContent = `${currentPower}w actual / ${target.watts}w target`;
  }else{
    $("feedbackTitle").textContent = `${abs}w Under`;
    $("feedbackText").textContent = `${currentPower}w actual / ${target.watts}w target`;
  }
}
function render(){
  const elapsed = currentElapsed();
  const total = totalDuration();
  const target = targetAt(elapsed);
  drawGraph(elapsed);
  $("progress").style.width = total ? Math.min(100,(elapsed/total)*100) + "%" : "0%";
  $("elapsedText").textContent = formatTime(elapsed);
  $("totalText").textContent = formatTime(total);
  $("summaryName").textContent = loadedName || "--";
  $("summaryTime").textContent = total ? formatTime(total) : "--";
  $("summaryBlocks").textContent = workout.length || "--";
  $("summaryBias").textContent = Math.round(bias*100) + "%";

  if(target){
    $("targetPower").textContent = target.watts;
    $("intervalText").textContent = `${Math.round(target.pct*100)}% FTP • ${formatTime(target.end - elapsed)} remaining • ${loadedName}`;
    $("currentName").textContent = target.block.type;
    $("remainingText").textContent = formatTime(target.end - elapsed);
    const next = nextBlock(target.index);
    $("nextName").textContent = next ? next.type : "Finish";
  }else if(workout.length && elapsed >= total){
    $("targetPower").textContent = "--";
    $("intervalText").textContent = "Workout complete.";
    $("currentName").textContent = "Complete";
    $("remainingText").textContent = "0:00";
    $("nextName").textContent = "--";
    pause();
  }else{
    $("targetPower").textContent = "--";
    $("intervalText").textContent = "Load a workout to begin.";
    $("currentName").textContent = "--";
    $("remainingText").textContent = "--";
    $("nextName").textContent = "--";
  }

  const active = target ? target.index : -1;
  $("blockList").innerHTML = workout.map((b,i)=>{
    const min = formatTime(b.duration);
    const pct = b.low !== undefined ? `${Math.round(b.low*bias*100)}→${Math.round(b.high*bias*100)}%` : `${Math.round((b.power||0)*bias*100)}%`;
    const watts = b.low !== undefined ? `${Math.round(b.low*bias*ftp())}→${Math.round(b.high*bias*ftp())}w` : `${Math.round((b.power||0)*bias*ftp())}w`;
    return `<div class="block-row ${i===active ? "active" : ""}"><span>${i+1}. ${b.type}</span><span>${min}<br>${pct} / ${watts}</span></div>`;
  }).join("");

  updateFeedback();
}
function setControls(){
  const has = workout.length > 0;
  $("startBtn").disabled = !has || playing;
  $("pauseBtn").disabled = !playing;
  $("resetBtn").disabled = !has;
  $("simBtn").disabled = !has;
  $("skipBtn").disabled = !has;
  $("biasDownBtn").disabled = !has;
  $("biasUpBtn").disabled = !has;
  $("biasResetBtn").disabled = !has;
  $("ergReadyBtn").disabled = !has;
}
function start(){
  if(!workout.length || playing) return;
  playing = true;
  startedAt = Date.now();
  timer = setInterval(render, 250);
  setControls();
  render();
}
function pause(){
  if(!playing) { setControls(); return; }
  elapsedBeforePause += (Date.now()-startedAt)/1000;
  playing = false;
  clearInterval(timer);
  setControls();
  render();
}
function reset(){
  pause();
  elapsedBeforePause = 0;
  render();
}
function skipInterval(){
  const hit = blockAt(currentElapsed());
  if(!hit) return;
  elapsedBeforePause = hit.end;
  if(playing) startedAt = Date.now();
  render();
}
function changeBias(delta){
  bias = Math.max(0.5, Math.min(1.5, bias + delta));
  render();
}
function resetBias(){
  bias = 1.0;
  render();
}
function toggleErgReady(){
  ergReady = !ergReady;
  $("ergReadyBtn").textContent = ergReady ? "ERG Ready: On" : "ERG Ready: Off";
  $("ergReadyBtn").className = ergReady ? "green" : "ghost";
}
function toggleSim(){
  simOn = !simOn;
  $("simBtn").textContent = simOn ? "Stop Simulation" : "Simulate Data";
  if(simOn){
    simTimer = setInterval(()=>{
      const t = targetAt(currentElapsed());
      const targetWatts = t ? t.watts : Math.round(ftp()*0.6);
      currentPower = Math.max(60, Math.round(targetWatts + (Math.random()*24-12)));
      $("powerVal").textContent = currentPower;
      $("cadenceVal").textContent = Math.round(86 + (Math.random()*8-4));
      $("speedVal").textContent = (30 + (Math.random()*3-1.5)).toFixed(1);
      $("hrVal").textContent = Math.round(118 + (targetWatts/ftp())*45 + (Math.random()*8-4));
      updateFeedback();
    }, 1000);
  }else{
    clearInterval(simTimer);
  }
}
function handleFile(file){
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e => parseZwo(e.target.result, file.name.replace(/\.(zwo|xml)$/i,""));
  reader.readAsText(file);
}

$("connectHrBtn").addEventListener("click", connectHR);
$("connectTrainerBtn").addEventListener("click", connectTrainer);
$("demoBtn").addEventListener("click", loadDemo);
$("zwoInput").addEventListener("change", e=>handleFile(e.target.files[0]));
$("startBtn").addEventListener("click", start);
$("pauseBtn").addEventListener("click", pause);
$("resetBtn").addEventListener("click", reset);
$("skipBtn").addEventListener("click", skipInterval);
$("biasDownBtn").addEventListener("click", ()=>changeBias(-0.05));
$("biasUpBtn").addEventListener("click", ()=>changeBias(0.05));
$("biasResetBtn").addEventListener("click", resetBias);
$("ergReadyBtn").addEventListener("click", toggleErgReady);
$("simBtn").addEventListener("click", toggleSim);
$("ftpInput").addEventListener("input", render);

const dropZone = $("dropZone");
dropZone.addEventListener("dragover", e=>{e.preventDefault(); dropZone.classList.add("dragover");});
dropZone.addEventListener("dragleave", ()=>dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", e=>{
  e.preventDefault();
  dropZone.classList.remove("dragover");
  handleFile(e.dataTransfer.files[0]);
});

if(!supportsBluetooth()){
  setStatus("hr", "bad", "Web Bluetooth unavailable in this browser");
  setStatus("trainer", "bad", "Web Bluetooth unavailable in this browser");
}else{
  setStatus("hr", "", "Not connected");
  setStatus("trainer", "", "Not connected");
}
render();
setControls();

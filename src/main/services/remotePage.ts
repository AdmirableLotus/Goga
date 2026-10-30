// The phone page Goga serves on the home network: pair once with the 6-digit code from
// Settings, then chat by text or voice. Self-contained (no external files), same-origin API.

export function remotePageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<title>Goga</title>
<style>
  :root { --bg:#0b0710; --surface:#15101f; --surface2:#1e1730; --text:#ece8f5; --muted:#8b7fa6; --accent:#8b5cff; --border:#2a2040; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--text); font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  #app { display:flex; flex-direction:column; height:100dvh; }
  header { padding:14px 16px; background:var(--surface); border-bottom:1px solid var(--border); font-weight:700; color:var(--accent); display:flex; align-items:center; gap:8px; }
  header small { color:var(--muted); font-weight:400; margin-left:auto; }
  #log { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px; }
  .msg { max-width:85%; padding:9px 13px; border-radius:14px; white-space:pre-wrap; word-wrap:break-word; }
  .me { align-self:flex-end; background:var(--accent); color:#fff; border-bottom-right-radius:4px; }
  .goga { align-self:flex-start; background:var(--surface2); border-bottom-left-radius:4px; }
  .sys { align-self:center; color:var(--muted); font-size:13px; text-align:center; }
  form { display:flex; gap:8px; padding:10px; background:var(--surface); border-top:1px solid var(--border); padding-bottom:calc(10px + env(safe-area-inset-bottom)); }
  input,button { font:inherit; border-radius:10px; border:1px solid var(--border); }
  #text { flex:1; padding:11px 13px; background:var(--surface2); color:var(--text); min-width:0; }
  button { background:var(--accent); color:#fff; border:none; padding:0 16px; font-weight:600; }
  button:disabled { opacity:.5; }
  #mic.rec { background:#e0245e; }
  #pair { padding:28px 20px; text-align:center; }
  #pair input { width:160px; text-align:center; letter-spacing:6px; font-size:24px; padding:12px; margin:14px 0; }
  #pair p { color:var(--muted); }
</style>
</head>
<body>
<div id="app">
  <header>Goga <small id="state">connecting…</small></header>
  <div id="log"></div>
  <div id="pair" hidden>
    <h2>Pair this phone</h2>
    <p>In Goga on your PC: Settings → Remote → <b>Pair a device</b>. Enter the 6-digit code:</p>
    <input id="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="------">
    <br><button id="pairBtn">Connect</button>
    <p id="pairErr" style="color:#e0245e"></p>
  </div>
  <form id="bar" hidden>
    <input id="text" placeholder="Message Goga…" autocomplete="off">
    <button id="mic" type="button" title="Hold to talk">🎤</button>
    <button id="send" type="submit">Send</button>
  </form>
</div>
<script>
const $ = s => document.querySelector(s)
const log = $('#log'), state = $('#state')
let key = localStorage.getItem('goga_key') || ''
function add(cls, text){ const d=document.createElement('div'); d.className='msg '+cls; d.textContent=text; log.appendChild(d); log.scrollTop=log.scrollHeight; return d }
async function api(path, opts={}){ const h=Object.assign({}, opts.headers); if(key) h.Authorization='Bearer '+key; const r=await fetch(path,Object.assign({},opts,{headers:h})); const t=await r.text(); let j={}; try{j=JSON.parse(t)}catch{} if(!r.ok) throw new Error(j.error||('HTTP '+r.status)); return j }
function play(b64){ if(!b64) return; try{ new Audio('data:audio/wav;base64,'+b64).play().catch(()=>{}) }catch{} }

function showChat(){ $('#pair').hidden=true; $('#bar').hidden=false; state.textContent='connected'; $('#text').focus() }
function showPair(){ $('#pair').hidden=false; $('#bar').hidden=true; state.textContent='not paired' }

async function hello(){
  if(!key){ showPair(); return }
  try{ const h=await api('/v1/hello'); state.textContent='connected'; showChat() }
  catch(e){ key=''; localStorage.removeItem('goga_key'); showPair() }
}

$('#pairBtn').onclick = async () => {
  const code=$('#code').value.trim(); $('#pairErr').textContent=''
  try{ const r=await api('/v1/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,name:'Phone'})}); key=r.key; localStorage.setItem('goga_key',key); add('sys','Paired. Say hello to Goga.'); showChat() }
  catch(e){ $('#pairErr').textContent=e.message }
}

$('#bar').onsubmit = async (ev) => {
  ev.preventDefault(); const text=$('#text').value.trim(); if(!text) return
  $('#text').value=''; add('me',text); const t=add('goga','…')
  try{ const r=await api('/v1/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,voice:true})}); t.textContent=r.reply||'(no reply)'; play(r.audio) }
  catch(e){ t.textContent='⚠️ '+e.message }
}

// Voice: tap mic to start/stop recording, send to /v1/voice
let rec, chunks=[]
$('#mic').onclick = async () => {
  const mic=$('#mic')
  if(rec && rec.state==='recording'){ rec.stop(); return }
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true})
    rec=new MediaRecorder(stream); chunks=[]
    rec.ondataavailable=e=>chunks.push(e.data)
    rec.onstop=async ()=>{
      stream.getTracks().forEach(t=>t.stop()); mic.classList.remove('rec'); mic.textContent='🎤'
      const blob=new Blob(chunks,{type:'audio/webm'}); if(blob.size<1200) return
      const t=add('goga','…')
      try{ const r=await api('/v1/voice',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:blob}); if(r.transcript) add('me',r.transcript); t.textContent=r.reply||'(no reply)'; play(r.audio) }
      catch(e){ t.textContent='⚠️ '+e.message }
    }
    rec.start(); mic.classList.add('rec'); mic.textContent='⏹'
  }catch(e){ add('sys','Microphone unavailable: '+e.message) }
}

hello()
</script>
</body>
</html>`
}

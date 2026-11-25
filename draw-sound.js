// Local foley: diffuse cardstock friction, then a short, dry contact transient.
window.DrawSound = (() => {
 const key='grimdeck.draw.sound';
 let enabled=true, audio, paper, master;
 try { enabled=localStorage.getItem(key)!=='off'; } catch {}
 function toggle(){
  enabled=!enabled;
  try { localStorage.setItem(key,enabled?'on':'off'); } catch {}
  if(master) master.gain.setTargetAtTime(enabled ? .8 : 0,audio.currentTime,.008);
 }
 function noise(at,length,level,low,high,attack,tail,grain=0){
  const source=audio.createBufferSource(), hp=audio.createBiquadFilter(), lp=audio.createBiquadFilter(), gain=audio.createGain();
  source.buffer=paper;hp.type='highpass';hp.frequency.value=low;lp.type='lowpass';lp.frequency.value=high;
  hp.Q.value=lp.Q.value=.55;
  const points=64, shape=Float32Array.from({length:points},(_,i)=>{
   const t=i/(points-1);
   if(i===points-1)return 0;
   const envelope=t<attack?t/attack:Math.exp(-(t-attack)*tail);
   return level*envelope*(1-grain*Math.random());
  });
  gain.gain.setValueCurveAtTime(shape,at,length);
  source.connect(hp).connect(lp).connect(gain).connect(master);
  source.start(at,Math.random()*.2,length);source.onended=()=>{source.disconnect();hp.disconnect();lp.disconnect();gain.disconnect();};
 }
 function slap(at){
  noise(at,.041,.84,310,1720,.032,8);
  noise(at+.002,.027,.54,2200,6700,.025,10);
  noise(at+.008,.044,.19,850,4000,.07,7,.27);
 }
 function tone(at,hz,length,level,type='sine',end=hz){
  const osc=audio.createOscillator(), gain=audio.createGain();
  osc.type=type;osc.frequency.setValueAtTime(hz,at);osc.frequency.exponentialRampToValueAtTime(end,at+length);
  gain.gain.setValueAtTime(.0001,at);
  gain.gain.exponentialRampToValueAtTime(level,at+.018);
  gain.gain.exponentialRampToValueAtTime(.0001,at+length);
  osc.connect(gain).connect(master);osc.start(at);osc.stop(at+length);
  osc.onended=()=>{osc.disconnect();gain.disconnect();};
 }
 function reveal(rarity){
  if(!enabled||audio?.state!=='running')return;
  try {
   const at=audio.currentTime;
   switch(rarity){
    case 'C': slap(at);break;
    case 'R':
     tone(at,440,.19,.17,'triangle');tone(at+.083,587.33,.24,.15);break;
    case 'E':
     [261.63,311.13,392,523.25].forEach((hz,i)=>tone(at+i*.012,hz,.32+i*.03,.125));break;
    case 'L':
     tone(at,115,.26,.32,'triangle',62);noise(at,.094,.30,110,1000,.03,8);
     tone(at+.045,659.25,.32,.18);tone(at+.052,1323,.21,.073);break;
    case 'M':
     tone(at,220,.42,.18,'sine',440);
     [440,659.25,880].forEach((hz,i)=>tone(at+.075+i*.07,hz,.32,.15,'triangle'));break;
   }
  } catch { /* Audio must never interrupt a draw. */ }
 }
 async function unlock(){
  if(!enabled)return;
  try {
   const Context=window.AudioContext||window.webkitAudioContext;
   if(!Context)return;
   if(!audio){
    audio=new Context();master=audio.createGain();master.gain.value=.8;master.connect(audio.destination);
    paper=audio.createBuffer(1,Math.ceil(audio.sampleRate*.56),audio.sampleRate);
    const data=paper.getChannelData(0);
    for(let i=0;i<data.length;i++)data[i]=Math.random()*2-1;
   }
   if(audio.state!=='running')await audio.resume();
   return enabled&&audio.state==='running';
  } catch { return false; }
 }
 async function play(immediateRarity){
  if(!await unlock())return;
  try {
   if(immediateRarity)reveal(immediateRarity);
   else noise(audio.currentTime,.31,.29,750,3700,.22,5,.32);
  } catch { /* Audio must never interrupt a draw. */ }
 }
 function cue(name,variant=0){
  if(!enabled||audio?.state!=='running'||document.hidden)return;
  try {
   const at=audio.currentTime;
   if(name==='hammer'){
    noise(at,.062,.36,185,1900,.03,9);
    noise(at+.002,.031,.21,2400,6600,.035,9);
    tone(at,510+55*variant,.116,.09,'triangle',420);
   }else if(name==='forge-ready'){
    tone(at,523.25,.22,.10,'triangle');tone(at+.056,783.99,.27,.08);
   }else if(name==='paper'){
    noise(at,.14,.23,570,4900,.16,6,.42);
   }else if(name==='shuffle-ready'){
    noise(at,.068,.38,240,2800,.04,8);
    tone(at+.022,variant?523.25:330,.20,.09,'triangle');
   }
  } catch { /* Audio is optional. */ }
 }
 return {play,reveal,unlock,cue,toggle,get enabled(){return enabled;}};
})();

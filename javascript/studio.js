/**
 * Forge Studio v1.0 — by ToxicHost & Moritz
 * Full rewrite: zoom/pan, mode-contextual UI, HSV wheel, color fix,
 * load-image fix, aspect ratio, generation preview, settings transfer.
 */
(function(){
"use strict";

// ========================================================================
// STATE
// ========================================================================
const S={canvas:null,ctx:null,
layers:{reference:{canvas:null,ctx:null,visible:true,opacity:1},paint:{canvas:null,ctx:null,visible:true,opacity:1},mask:{canvas:null,ctx:null,visible:true,opacity:0.5}},
activeLayer:"paint",W:512,H:512,
tool:"brush",brushSize:12,brushOpacity:1,color:"#000000",maskColor:"#ff0000",
brushPreset:"round",brushHardness:1.0,pressureSensitivity:false,pressureAffects:"both",
smoothing:4,toolStrength:0.5,symmetry:"none",
drawing:false,lastResult:null,lastSettings:null,ready:false,
undoStack:[],redoStack:[],maxUndo:30,colorHistory:["#000000","#ffffff"],smudgeBuffer:null,
stroke:{canvas:null,ctx:null,points:[],lx:0,ly:0,lp:0.5},
zoom:{scale:1,ox:0,oy:0,panning:false,panStartX:0,panStartY:0,panOxStart:0,panOyStart:0},
studioMode:"Create",
arLocked:false,arRatio:null,
hsvOpen:false,
generating:false,previewInterval:null};

// ========================================================================
// BOOT
// ========================================================================
function boot(){if(S.ready)return;const el=document.getElementById("studio-canvas");if(!el)return;
S.canvas=el;S.canvas.width=S.W;S.canvas.height=S.H;S.ctx=S.canvas.getContext("2d");
for(const k of Object.keys(S.layers)){const c=document.createElement("canvas");c.width=S.W;c.height=S.H;S.layers[k].canvas=c;S.layers[k].ctx=c.getContext("2d");if(k==="reference"){S.layers[k].ctx.fillStyle="#fff";S.layers[k].ctx.fillRect(0,0,S.W,S.H);}}
S.stroke.canvas=document.createElement("canvas");S.stroke.canvas.width=S.W;S.stroke.canvas.height=S.H;S.stroke.ctx=S.stroke.canvas.getContext("2d");
bindCanvas();bindToolbar();bindLayers();bindKeys();hookGenerate();watchSliders();watchModeRadio();
bindAspectRatio();bindZoomButtons();buildHSVWheel();injectBridgeButtons();watchSettingsTransfer();
updateCSS();applyMode("Create");composite();S.ready=true;
console.log("[Studio v1.0] Ready",S.W+"x"+S.H);}
let _bt=0;const _bp=setInterval(()=>{if(document.getElementById("studio-canvas")||_bt++>50){clearInterval(_bp);boot();}},400);

// ========================================================================
// MODE-CONTEXTUAL UI
// ========================================================================
function applyMode(mode){
S.studioMode=mode;
const isSketch=mode==="Create",isInpaint=mode==="Edit",isImg2img=mode==="img2img";
const isDraw=isSketch||isInpaint;

// Check inpaint sub-mode
const ipMode=document.querySelector('#studio_inpaint_mode input[type="radio"]:checked');
const isIPSketch=isInpaint&&ipMode&&(ipMode.value==="Inpaint Sketch"||(ipMode.closest("label")?.textContent?.trim()==="Inpaint Sketch"));
const showFullToolbar=isSketch||isIPSketch;

document.querySelectorAll(".studio-sketch-only").forEach(e=>e.style.display=showFullToolbar?"":"none");
document.querySelectorAll(".studio-draw-only").forEach(e=>e.style.display=isDraw?"":"none");
document.querySelectorAll(".studio-inpaint-only").forEach(e=>e.style.display=(isInpaint&&!isIPSketch)?"":"none");
document.querySelectorAll(".studio-layer-select").forEach(e=>e.style.display=isSketch?"":"none");

const tb1=document.getElementById("studio-toolbar");
const tb2=document.getElementById("studio-toolbar2");
if(tb1)tb1.style.display=isDraw?"flex":"none";
if(tb2)tb2.style.display=isDraw?"flex":"none";

// Hide layers panel in Inpaint (Mode radio replaces it) and img2img
// Hide layer rows based on mode, but always show the actions bar (Load Image etc.)
const layers=document.getElementById("studio-layers");
if(layers)layers.style.display="flex";
document.querySelectorAll(".studio-inpaint-layer").forEach(e=>e.style.display="none");
document.querySelectorAll(".studio-sketch-layer").forEach(e=>e.style.display=isSketch?"flex":"none");

// Hide inpaint settings accordion when not in inpaint mode
const ipS=document.getElementById("studio_inpaint_settings");
if(ipS){
    let el=ipS.closest('.gradio-accordion')||ipS;
    el.style.display=isInpaint?"":"none";
}

if(isSketch)setLayer("paint");
else if(isInpaint){
    setLayer(isIPSketch?"paint":"mask");
}

S.canvas.style.cursor=isImg2img?"default":(S.tool==="eyedropper"||S.tool==="fill")?"crosshair":"none";
if(isInpaint&&S.tool!=="brush"&&S.tool!=="eraser")setTool("brush");
composite();}

function watchModeRadio(){
const poll=()=>{
    const radios=document.querySelectorAll('#studio_mode_radio input[type="radio"]');
    if(!radios.length){setTimeout(poll,500);return;}
    radios.forEach(r=>{r.addEventListener("change",()=>{
        if(r.checked){const label=r.closest("label")?.textContent?.trim()||r.value;applyMode(label);}
    });});
    radios.forEach(r=>{if(r.checked){const label=r.closest("label")?.textContent?.trim()||r.value;applyMode(label);}});
};poll();

// Watch inpaint sub-mode radio
const pollIP=()=>{
    const radios=document.querySelectorAll('#studio_inpaint_mode input[type="radio"]');
    if(!radios.length){setTimeout(pollIP,500);return;}
    radios.forEach(r=>{r.addEventListener("change",()=>{
        if(r.checked&&S.studioMode==="Edit"){
            applyMode("Edit"); // Re-run to update toolbars
        }
    });});
};pollIP();
}

// ========================================================================
// COMPOSITE (with zoom/pan transform)
// ========================================================================
function composite(){
const c=S.ctx,w=S.W,h=S.H,z=S.zoom;
c.setTransform(1,0,0,1,0,0);
c.clearRect(0,0,S.canvas.width,S.canvas.height);
c.setTransform(z.scale,0,0,z.scale,z.ox,z.oy);
checker(c,w,h);
for(const k of["reference","paint","mask"]){
    const L=S.layers[k];if(!L.visible)continue;
    c.globalAlpha=L.opacity;c.drawImage(L.canvas,0,0);
}
if(S.drawing&&S.stroke.canvas&&S.tool==="brush"){
    c.globalAlpha=S.layers[S.activeLayer].opacity;c.drawImage(S.stroke.canvas,0,0);
}
c.globalAlpha=1;
if(S.symmetry!=="none")symGuides(c);
c.setTransform(1,0,0,1,0,0);}

function checker(ctx,w,h){const s=10;ctx.fillStyle="#3a3a3a";ctx.fillRect(0,0,w,h);ctx.fillStyle="#444";for(let y=0;y<h;y+=s)for(let x=0;x<w;x+=s)if((~~(x/s)+~~(y/s))&1)ctx.fillRect(x,y,s,s);}
function symGuides(c){c.save();c.strokeStyle="rgba(100,200,255,0.3)";c.lineWidth=1/S.zoom.scale;c.setLineDash([4/S.zoom.scale,4/S.zoom.scale]);if(S.symmetry==="h"||S.symmetry==="both"){c.beginPath();c.moveTo(S.W/2,0);c.lineTo(S.W/2,S.H);c.stroke();}if(S.symmetry==="v"||S.symmetry==="both"){c.beginPath();c.moveTo(0,S.H/2);c.lineTo(S.W,S.H/2);c.stroke();}c.restore();}
function updateCSS(){if(!S.canvas)return;S.canvas.style.maxWidth="100%";S.canvas.style.maxHeight="65vh";S.canvas.style.aspectRatio=S.W+"/"+S.H;updateZoomDisplay();}
function updateZoomDisplay(){const d=document.getElementById("studio-zoom-display");if(d)d.textContent=Math.round(S.zoom.scale*100)+"%";}

// ========================================================================
// ZOOM / PAN
// ========================================================================
function screenToCanvas(sx,sy){
const r=S.canvas.getBoundingClientRect(),z=S.zoom;
const cx=(sx-r.left)*(S.W*z.scale/(r.width))-z.ox;
const cy=(sy-r.top)*(S.H*z.scale/(r.height))-z.oy;
// Nope — simpler: map screen to canvas element pixels, then invert transform
const ex=(sx-r.left)/r.width*S.canvas.width;
const ey=(sy-r.top)/r.height*S.canvas.height;
return{x:(ex-z.ox)/z.scale, y:(ey-z.oy)/z.scale};}

function zoomAt(screenX,screenY,factor){
const z=S.zoom,r=S.canvas.getBoundingClientRect();
const ex=(screenX-r.left)/r.width*S.canvas.width;
const ey=(screenY-r.top)/r.height*S.canvas.height;
const newScale=Math.min(16,Math.max(0.1,z.scale*factor));
z.ox=ex-(ex-z.ox)/z.scale*newScale;
z.oy=ey-(ey-z.oy)/z.scale*newScale;
z.scale=newScale;updateZoomDisplay();composite();}

function zoomFit(){S.zoom.scale=1;S.zoom.ox=0;S.zoom.oy=0;updateZoomDisplay();composite();}
function zoomReset(){S.zoom.scale=1;S.zoom.ox=0;S.zoom.oy=0;updateZoomDisplay();composite();}
function bindZoomButtons(){
document.getElementById("studio-zoom-fit")?.addEventListener("click",zoomFit);
document.getElementById("studio-zoom-reset")?.addEventListener("click",zoomReset);}

// ========================================================================
// CURSOR
// ========================================================================
let _cx=-1,_cy=-1;
function drawCursor(){if(_cx<0||S.tool==="eyedropper"||S.tool==="fill"||S.studioMode==="img2img")return;
const c=S.ctx,z=S.zoom;c.setTransform(1,0,0,1,0,0);
const px=_cx*z.scale+z.ox, py=_cy*z.scale+z.oy, pr=S.brushSize/2*z.scale;
c.save();c.strokeStyle="rgba(255,255,255,0.7)";c.lineWidth=1.5;c.setLineDash([]);
c.beginPath();c.arc(px,py,Math.max(1,pr),0,Math.PI*2);c.stroke();
c.strokeStyle="rgba(0,0,0,0.4)";c.lineWidth=1;c.setLineDash([3,3]);
c.beginPath();c.arc(px,py,Math.max(1,pr),0,Math.PI*2);c.stroke();
c.setLineDash([]);c.strokeStyle="rgba(255,255,255,0.4)";c.lineWidth=1;
c.beginPath();c.moveTo(px-3,py);c.lineTo(px+3,py);c.stroke();
c.beginPath();c.moveTo(px,py-3);c.lineTo(px,py+3);c.stroke();
c.restore();}

// ========================================================================
// COLOR HISTORY
// ========================================================================
function addColor(hex){hex=hex.toLowerCase();S.colorHistory=S.colorHistory.filter(c=>c!==hex);S.colorHistory.unshift(hex);if(S.colorHistory.length>10)S.colorHistory.pop();renderColors();}
function renderColors(){const b=document.getElementById("studio-color-history");if(!b)return;b.innerHTML="";for(const c of S.colorHistory){const e=document.createElement("span");e.className="ssw shist";e.style.background=c;if(c==="#ffffff")e.style.outline="1px solid #555";e.addEventListener("click",()=>{S.color=c;const cp=document.getElementById("studio-color");if(cp)cp.value=c;updateHSVFromColor(c);});b.appendChild(e);}}

// ========================================================================
// UNDO
// ========================================================================
function saveUndo(){const L=S.layers[S.activeLayer];S.undoStack.push({layer:S.activeLayer,data:L.ctx.getImageData(0,0,S.W,S.H)});if(S.undoStack.length>S.maxUndo)S.undoStack.shift();S.redoStack=[];}
function undo(){if(!S.undoStack.length)return;const e=S.undoStack.pop(),L=S.layers[e.layer];S.redoStack.push({layer:e.layer,data:L.ctx.getImageData(0,0,S.W,S.H)});L.ctx.putImageData(e.data,0,0);composite();}
function redo(){if(!S.redoStack.length)return;const e=S.redoStack.pop(),L=S.layers[e.layer];S.undoStack.push({layer:e.layer,data:L.ctx.getImageData(0,0,S.W,S.H)});L.ctx.putImageData(e.data,0,0);composite();}

// ========================================================================
// STAMP — COLOR FIX: full opacity at brush center
// ========================================================================
function makeStamp(sz,hard,preset,col,op,ang){
const d=Math.max(2,Math.ceil(sz)),c=document.createElement("canvas");c.width=d;c.height=d;
const x=c.getContext("2d"),rgb=hexRgb(col),cx=d/2,cy=d/2,r=d/2;
switch(preset){
case"round":softCirc(x,cx,cy,r,hard,rgb,op);break;
case"flat":x.save();x.translate(cx,cy);x.rotate(ang||0);x.fillStyle=`rgba(${rgb.r},${rgb.g},${rgb.b},${op})`;x.beginPath();x.ellipse(0,0,r,Math.max(1,r*0.3),0,0,Math.PI*2);x.fill();x.restore();break;
case"scatter":{const n=Math.max(3,~~(sz/3));for(let i=0;i<n;i++)softCirc(x,cx+(Math.random()-0.5)*d*0.8,cy+(Math.random()-0.5)*d*0.8,Math.random()*r*0.3+1,0.6,rgb,op*(0.3+Math.random()*0.7));break;}
case"marker":x.save();x.translate(cx,cy);x.rotate(ang||0.4);x.fillStyle=`rgba(${rgb.r},${rgb.g},${rgb.b},${op*0.7})`;x.fillRect(-r*0.8,-r*0.35,r*1.6,r*0.7);x.restore();break;}
return c;}

function softCirc(ctx,cx,cy,r,h,rgb,op){
if(r<1)r=1;
if(h>0.95){
    ctx.fillStyle=`rgba(${rgb.r},${rgb.g},${rgb.b},${op})`;
    ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();
} else {
    // COLOR FIX: gradient keeps center fully opaque, fades only at edge
    const g=ctx.createRadialGradient(cx,cy,r*h*0.5,cx,cy,r);
    g.addColorStop(0,`rgba(${rgb.r},${rgb.g},${rgb.b},${op})`);
    g.addColorStop(h,`rgba(${rgb.r},${rgb.g},${rgb.b},${op})`);
    g.addColorStop(1,`rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();
}}

// ========================================================================
// STABILIZER
// ========================================================================
function stab(rx,ry,rp){const pts=S.stroke.points;pts.push({x:rx,y:ry,p:rp});const w=Math.min(S.smoothing,pts.length);let sx=0,sy=0,sp=0;for(let i=pts.length-w;i<pts.length;i++){sx+=pts[i].x;sy+=pts[i].y;sp+=pts[i].p;}return{x:sx/w,y:sy/w,p:sp/w};}

// ========================================================================
// STROKE ENGINE — COLOR FIX: proper opacity
// ========================================================================
let _sa=0,_saSmooth=0;
function pSz(p){if(!S.pressureSensitivity)return S.brushSize;const v=Math.max(0.1,p);return(S.pressureAffects==="size"||S.pressureAffects==="both")?S.brushSize*v:S.brushSize;}
function pOp(p){if(!S.pressureSensitivity)return S.brushOpacity;const v=Math.max(0.1,p);return(S.pressureAffects==="opacity"||S.pressureAffects==="both")?S.brushOpacity*v:S.brushOpacity;}

function stampOnStroke(x,y,p){
const sz=Math.max(2,pSz(p)),op=pOp(p),col=S.activeLayer==="mask"?S.maskColor:S.color;
const stamp=makeStamp(sz,S.brushHardness,S.brushPreset,col,1,S.brushPreset==="flat"?_saSmooth:0.4);
const ctx=S.stroke.ctx;ctx.save();
// COLOR FIX: use actual opacity, not halved
ctx.globalAlpha=Math.min(1,op);
ctx.drawImage(stamp,x-sz/2,y-sz/2);
if(S.symmetry==="h"||S.symmetry==="both")ctx.drawImage(stamp,(S.W-x)-sz/2,y-sz/2);
if(S.symmetry==="v"||S.symmetry==="both")ctx.drawImage(stamp,x-sz/2,(S.H-y)-sz/2);
if(S.symmetry==="both")ctx.drawImage(stamp,(S.W-x)-sz/2,(S.H-y)-sz/2);
ctx.restore();}

function plotTo(x,y,p){const x0=S.stroke.lx,y0=S.stroke.ly,p0=S.stroke.lp,dx=x-x0,dy=y-y0;
if(Math.hypot(dx,dy)>2){const raw=Math.atan2(dy,dx),diff=raw-_saSmooth;_saSmooth+=Math.atan2(Math.sin(diff),Math.cos(diff))*0.3;_sa=raw;}
const dist=Math.hypot(dx,dy),sp=Math.max(0.5,S.brushSize*0.06),steps=Math.max(1,Math.ceil(dist/sp));
for(let i=1;i<=steps;i++){const t=i/steps;stampOnStroke(x0+dx*t,y0+dy*t,p0+(p-p0)*t);}
S.stroke.lx=x;S.stroke.ly=y;S.stroke.lp=p;}

function beginStroke(x,y,p){S.stroke.ctx.clearRect(0,0,S.W,S.H);S.stroke.points=[];S.stroke.lx=x;S.stroke.ly=y;S.stroke.lp=p;stampOnStroke(x,y,p);}
function commitStroke(){const L=S.layers[S.activeLayer];L.ctx.save();L.ctx.globalCompositeOperation="source-over";L.ctx.drawImage(S.stroke.canvas,0,0);L.ctx.restore();S.stroke.ctx.clearRect(0,0,S.W,S.H);}

// Eraser
function eraseAt(ctx,x,y,p){const sz=Math.max(2,pSz(p));const stamp=makeStamp(sz,S.brushHardness,"round","#ffffff",1,0);
ctx.save();ctx.globalCompositeOperation="destination-out";ctx.globalAlpha=pOp(p);
ctx.drawImage(stamp,x-sz/2,y-sz/2);
if(S.symmetry==="h"||S.symmetry==="both")ctx.drawImage(stamp,(S.W-x)-sz/2,y-sz/2);
if(S.symmetry==="v"||S.symmetry==="both")ctx.drawImage(stamp,x-sz/2,(S.H-y)-sz/2);
if(S.symmetry==="both")ctx.drawImage(stamp,(S.W-x)-sz/2,(S.H-y)-sz/2);
ctx.restore();}
function eraseStroke(x1,y1,x2,y2,p1,p2){const L=S.layers[S.activeLayer],dx=x2-x1,dy=y2-y1,dist=Math.hypot(dx,dy),sp=Math.max(0.5,S.brushSize*0.06),steps=Math.max(1,Math.ceil(dist/sp));for(let i=0;i<=steps;i++){const t=i/steps;eraseAt(L.ctx,x1+dx*t,y1+dy*t,p1+(p2-p1)*t);}}

// Smudge
function smudgeInit(ctx,x,y){const sz=~~Math.max(6,S.brushSize),r=sz/2;const ix=~~Math.max(0,x-r),iy=~~Math.max(0,y-r),ex=~~Math.min(S.W,x+r),ey=~~Math.min(S.H,y+r),w=ex-ix,h=ey-iy;if(w<2||h<2)return;const s=ctx.getImageData(ix,iy,w,h),d=s.data,cl=x-ix,ct=y-iy;for(let py=0;py<h;py++)for(let px=0;px<w;px++){const dist=Math.hypot(px-cl,py-ct)/r,i=(py*w+px)*4;if(dist>1)d[i+3]=0;else if(dist>.6)d[i+3]=~~(d[i+3]*(1-(dist-.6)/.4));}const buf=document.createElement("canvas");buf.width=w;buf.height=h;buf.getContext("2d").putImageData(s,0,0);S.smudgeBuffer={canvas:buf,w,h};}
function smudgeDrag(ctx,x,y,p){if(!S.smudgeBuffer)return;const sz=~~Math.max(6,S.brushSize),r=sz/2,str=S.toolStrength*(S.pressureSensitivity?Math.max(.1,p):1);ctx.save();ctx.globalAlpha=str;ctx.drawImage(S.smudgeBuffer.canvas,~~(x-r),~~(y-r),sz,sz);ctx.restore();const ix=~~Math.max(0,x-r),iy=~~Math.max(0,y-r),ex=~~Math.min(S.W,x+r),ey=~~Math.min(S.H,y+r),w=ex-ix,h=ey-iy;if(w<2||h<2)return;const f=ctx.getImageData(ix,iy,w,h),fd=f.data,cl=x-ix,ct=y-iy;for(let py=0;py<h;py++)for(let px=0;px<w;px++){const dist=Math.hypot(px-cl,py-ct)/r,i=(py*w+px)*4;if(dist>1)fd[i+3]=0;else if(dist>.6)fd[i+3]=~~(fd[i+3]*(1-(dist-.6)/.4));}const nb=document.createElement("canvas");nb.width=w;nb.height=h;nb.getContext("2d").putImageData(f,0,0);S.smudgeBuffer={canvas:nb,w,h};}
function smudgeStroke(ctx,x1,y1,x2,y2,p1,p2){const dx=x2-x1,dy=y2-y1,dist=Math.hypot(dx,dy),sp=Math.max(2,S.brushSize*.1),steps=Math.max(1,Math.ceil(dist/sp));for(let i=1;i<=steps;i++){const t=i/steps;smudgeDrag(ctx,x1+dx*t,y1+dy*t,p1+(p2-p1)*t);}}

// Blur
function blurAt(ctx,x,y,p){const sz=Math.max(6,pSz(p)),r=~~(sz/2);const ix=~~Math.max(0,x-r),iy=~~Math.max(0,y-r),ex=~~Math.min(S.W,x+r),ey=~~Math.min(S.H,y+r),w=ex-ix,h=ey-iy;if(w<3||h<3)return;const img=ctx.getImageData(ix,iy,w,h),d=img.data,out=new Uint8ClampedArray(d.length),kR=Math.max(1,~~(S.toolStrength*4));for(let py=0;py<h;py++)for(let px=0;px<w;px++){let rr=0,gg=0,bb=0,aa=0,cnt=0;for(let ky=-kR;ky<=kR;ky++)for(let kx=-kR;kx<=kR;kx++){const sx2=px+kx,sy2=py+ky;if(sx2>=0&&sx2<w&&sy2>=0&&sy2<h){const si=(sy2*w+sx2)*4;rr+=d[si];gg+=d[si+1];bb+=d[si+2];aa+=d[si+3];cnt++;}}const di=(py*w+px)*4;out[di]=rr/cnt;out[di+1]=gg/cnt;out[di+2]=bb/cnt;out[di+3]=aa/cnt;}const cl=w/2,ct=h/2;for(let py=0;py<h;py++)for(let px=0;px<w;px++){const dist=Math.hypot(px-cl,py-ct)/r;if(dist>1)continue;const b=1-dist,di=(py*w+px)*4;d[di]+=(out[di]-d[di])*b;d[di+1]+=(out[di+1]-d[di+1])*b;d[di+2]+=(out[di+2]-d[di+2])*b;d[di+3]+=(out[di+3]-d[di+3])*b;}ctx.putImageData(img,ix,iy);}

// ========================================================================
// CANVAS EVENTS (with zoom/pan support)
// ========================================================================
function pos(e){
const r=S.canvas.getBoundingClientRect(),z=S.zoom;
const ex=(e.clientX-r.left)/r.width*S.canvas.width;
const ey=(e.clientY-r.top)/r.height*S.canvas.height;
return{x:(ex-z.ox)/z.scale, y:(ey-z.oy)/z.scale, pressure:e.pressure||0.5};}

function bindCanvas(){const c=S.canvas;
c.addEventListener("pointerdown",onDown);c.addEventListener("pointermove",onMove);
c.addEventListener("pointerup",onUp);c.addEventListener("pointerleave",onLeave);
c.addEventListener("contextmenu",e=>e.preventDefault());c.style.touchAction="none";
// Zoom with mouse wheel
c.addEventListener("wheel",e=>{e.preventDefault();
const factor=e.deltaY<0?1.15:1/1.15;
zoomAt(e.clientX,e.clientY,factor);},{passive:false});
// Middle-click pan
c.addEventListener("pointerdown",e=>{
if(e.button===1||e.button===2||(e.button===0&&e.altKey)){
    e.preventDefault();S.zoom.panning=true;S.zoom.panStartX=e.clientX;S.zoom.panStartY=e.clientY;
    S.zoom.panOxStart=S.zoom.ox;S.zoom.panOyStart=S.zoom.oy;c.setPointerCapture(e.pointerId);}
});
c.addEventListener("pointermove",e=>{if(S.zoom.panning){
    const dx=e.clientX-S.zoom.panStartX,dy=e.clientY-S.zoom.panStartY;
    const r=S.canvas.getBoundingClientRect();
    S.zoom.ox=S.zoom.panOxStart+dx*(S.canvas.width/r.width);
    S.zoom.oy=S.zoom.panOyStart+dy*(S.canvas.height/r.height);
    composite();drawCursor();}
});
c.addEventListener("pointerup",e=>{if(S.zoom.panning){S.zoom.panning=false;try{c.releasePointerCapture(e.pointerId);}catch(_){}}});}

function onDown(e){
if(e.button!==0||e.altKey)return; // left-click only, not alt (pan)
if(S.studioMode==="img2img")return;
const p=pos(e);
if(S.tool==="eyedropper"){pickColor(p);return;}
if(S.tool==="fill"){floodFill(p);return;}
saveUndo();S.drawing=true;S.canvas.setPointerCapture(e.pointerId);
const L=S.layers[S.activeLayer];
if(S.tool==="smudge"){S.stroke.points=[];smudgeInit(L.ctx,p.x,p.y);S.stroke.lx=p.x;S.stroke.ly=p.y;S.stroke.lp=p.pressure;}
else if(S.tool==="blur"){S.stroke.points=[];blurAt(L.ctx,p.x,p.y,p.pressure);S.stroke.lx=p.x;S.stroke.ly=p.y;S.stroke.lp=p.pressure;}
else if(S.tool==="eraser"){S.stroke.points=[];S.stroke.lx=p.x;S.stroke.ly=p.y;S.stroke.lp=p.pressure;eraseAt(L.ctx,p.x,p.y,p.pressure);}
else{beginStroke(p.x,p.y,p.pressure);}
_cx=p.x;_cy=p.y;composite();drawCursor();}

function onMove(e){
if(S.zoom.panning)return;
if(S.studioMode==="img2img")return;
const p=pos(e);_cx=p.x;_cy=p.y;
if(!S.drawing){composite();drawCursor();return;}
const sp=stab(p.x,p.y,p.pressure),L=S.layers[S.activeLayer];
if(S.tool==="smudge"){smudgeStroke(L.ctx,S.stroke.lx,S.stroke.ly,sp.x,sp.y,S.stroke.lp,sp.p);S.stroke.lx=sp.x;S.stroke.ly=sp.y;S.stroke.lp=sp.p;}
else if(S.tool==="blur"){blurAt(L.ctx,sp.x,sp.y,sp.p);}
else if(S.tool==="eraser"){eraseStroke(S.stroke.lx,S.stroke.ly,sp.x,sp.y,S.stroke.lp,sp.p);S.stroke.lx=sp.x;S.stroke.ly=sp.y;S.stroke.lp=sp.p;}
else{plotTo(sp.x,sp.y,sp.p);}
composite();drawCursor();}

function onUp(e){if(S.drawing){try{S.canvas.releasePointerCapture(e.pointerId);}catch(_){}if(S.tool==="brush")commitStroke();S.smudgeBuffer=null;if(S.tool==="brush")addColor(S.color);}S.drawing=false;composite();drawCursor();}
function onLeave(){if(S.drawing){if(S.tool==="brush")commitStroke();S.smudgeBuffer=null;}S.drawing=false;_cx=-1;_cy=-1;composite();}

function pickColor(pt){const px=S.layers.reference.ctx.getImageData(~~pt.x,~~pt.y,1,1).data;
// Also check paint layer
const px2=S.layers.paint.ctx.getImageData(~~pt.x,~~pt.y,1,1).data;
// Use paint layer if it has alpha, otherwise reference
const src=(px2[3]>10)?px2:px;
S.color="#"+[src[0],src[1],src[2]].map(v=>v.toString(16).padStart(2,"0")).join("");
const cp=document.getElementById("studio-color");if(cp)cp.value=S.color;addColor(S.color);updateHSVFromColor(S.color);setTool("brush");}

function floodFill(pt){saveUndo();const L=S.layers[S.activeLayer],ctx=L.ctx,w=S.W,h=S.H,sx=~~pt.x,sy=~~pt.y;if(sx<0||sx>=w||sy<0||sy>=h)return;const img=ctx.getImageData(0,0,w,h),d=img.data,idx=(sy*w+sx)*4;const tR=d[idx],tG=d[idx+1],tB=d[idx+2],tA=d[idx+3],fc=hexRgb(S.activeLayer==="mask"?S.maskColor:S.color),fA=~~(S.brushOpacity*255);if(tR===fc.r&&tG===fc.g&&tB===fc.b&&tA===fA)return;const tol=32,stack=[sx,sy],vis=new Uint8Array(w*h);while(stack.length){const cy2=stack.pop(),cx2=stack.pop(),ci=cy2*w+cx2;if(vis[ci])continue;const pi=ci*4;if(Math.abs(d[pi]-tR)>tol||Math.abs(d[pi+1]-tG)>tol||Math.abs(d[pi+2]-tB)>tol||Math.abs(d[pi+3]-tA)>tol)continue;vis[ci]=1;d[pi]=fc.r;d[pi+1]=fc.g;d[pi+2]=fc.b;d[pi+3]=fA;if(cx2>0)stack.push(cx2-1,cy2);if(cx2<w-1)stack.push(cx2+1,cy2);if(cy2>0)stack.push(cx2,cy2-1);if(cy2<h-1)stack.push(cx2,cy2+1);}ctx.putImageData(img,0,0);composite();}
function hexRgb(h){return{r:parseInt(h.slice(1,3),16),g:parseInt(h.slice(3,5),16),b:parseInt(h.slice(5,7),16)};}

// ========================================================================
// TOOLBAR
// ========================================================================
function bindToolbar(){
const tm={"studio-tool-brush":"brush","studio-tool-eraser":"eraser","studio-tool-smudge":"smudge","studio-tool-blur":"blur","studio-tool-fill":"fill","studio-tool-eyedropper":"eyedropper"};
for(const[id,t]of Object.entries(tm))document.getElementById(id)?.addEventListener("click",()=>setTool(t));
document.querySelectorAll(".stool-preset").forEach(b=>{b.addEventListener("click",()=>{S.brushPreset=b.dataset.preset;document.querySelectorAll(".stool-preset").forEach(x=>x.classList.remove("active"));b.classList.add("active");});});
const hd=document.getElementById("studio-hardness"),hdV=document.getElementById("studio-hardness-val");hd?.addEventListener("input",()=>{S.brushHardness=+hd.value/100;hdV.textContent=hd.value+"%";});
const sz=document.getElementById("studio-brush-size"),szV=document.getElementById("studio-size-val");sz?.addEventListener("input",()=>{S.brushSize=+sz.value;szV.textContent=sz.value;});
const op=document.getElementById("studio-brush-opacity"),opV=document.getElementById("studio-opacity-val");op?.addEventListener("input",()=>{S.brushOpacity=+op.value/100;opV.textContent=op.value+"%";});
const sm=document.getElementById("studio-smoothing"),smV=document.getElementById("studio-smooth-val");sm?.addEventListener("input",()=>{S.smoothing=+sm.value;smV.textContent=sm.value;});
const str=document.getElementById("studio-strength"),strV=document.getElementById("studio-strength-val");str?.addEventListener("input",()=>{S.toolStrength=+str.value/100;strV.textContent=str.value+"%";});
document.getElementById("studio-color")?.addEventListener("input",e=>{S.color=e.target.value;updateHSVFromColor(S.color);});
document.querySelectorAll("#studio-swatches .ssw").forEach(s=>{s.addEventListener("click",()=>{S.color=s.dataset.c;const cp=document.getElementById("studio-color");if(cp)cp.value=S.color;updateHSVFromColor(S.color);});});
// Layer select buttons
document.getElementById("studio-mode-sketch")?.addEventListener("click",()=>setLayer("paint"));
document.getElementById("studio-mode-ref")?.addEventListener("click",()=>setLayer("reference"));
document.getElementById("studio-mode-mask")?.addEventListener("click",()=>setLayer("mask"));
// Symmetry
document.querySelectorAll(".stool-sym").forEach(b=>{b.addEventListener("click",()=>{const m=b.dataset.sym;S.symmetry=(S.symmetry===m)?"none":m;document.querySelectorAll(".stool-sym").forEach(x=>x.classList.remove("active"));if(S.symmetry!=="none")document.querySelector(`.stool-sym[data-sym="${S.symmetry}"]`)?.classList.add("active");composite();});});
document.getElementById("studio-pressure-toggle")?.addEventListener("click",e=>{S.pressureSensitivity=!S.pressureSensitivity;e.currentTarget.classList.toggle("active",S.pressureSensitivity);});
document.querySelectorAll(".stool-pmode").forEach(b=>{b.addEventListener("click",()=>{if(b.classList.contains("active")){b.classList.remove("active");S.pressureAffects="none";}else{S.pressureAffects=b.dataset.pmode;document.querySelectorAll(".stool-pmode").forEach(x=>x.classList.remove("active"));b.classList.add("active");}});});
document.getElementById("studio-undo-btn")?.addEventListener("click",undo);
document.getElementById("studio-redo-btn")?.addEventListener("click",redo);
document.getElementById("studio-btn-clear")?.addEventListener("click",()=>{saveUndo();const L=S.layers[S.activeLayer];L.ctx.clearRect(0,0,S.W,S.H);if(S.activeLayer==="reference"){L.ctx.fillStyle="#fff";L.ctx.fillRect(0,0,S.W,S.H);}composite();});
document.getElementById("studio-btn-clearall")?.addEventListener("click",()=>{saveUndo();for(const k of Object.keys(S.layers)){S.layers[k].ctx.clearRect(0,0,S.W,S.H);if(k==="reference"){S.layers[k].ctx.fillStyle="#fff";S.layers[k].ctx.fillRect(0,0,S.W,S.H);}}composite();});
document.getElementById("studio-btn-load")?.addEventListener("click",()=>{document.getElementById("studio-file-input")?.click();});
document.getElementById("studio-file-input")?.addEventListener("change",e=>{const f=e.target?.files?.[0];if(!f)return;const r=new FileReader();r.onload=ev=>loadRef(ev.target.result);r.readAsDataURL(f);e.target.value="";});
// Result buttons
document.getElementById("studio_result_to_ref")?.addEventListener("click",()=>{if(S.lastResult)loadRef(S.lastResult);});
document.getElementById("studio_to_img2img")?.addEventListener("click",()=>{const b64=S.lastResult||exportCanvas();sendToImg2img(b64);});
renderColors();}

function setTool(t){S.tool=t;document.querySelectorAll(".stool").forEach(b=>b.classList.remove("active"));document.getElementById("studio-tool-"+t)?.classList.add("active");S.canvas.style.cursor=(t==="eyedropper"||t==="fill")?"crosshair":"none";const sg=document.getElementById("studio-strength-group");if(sg)sg.style.display=(t==="blur"||t==="smudge")?"":"none";}
function setLayer(l){S.activeLayer=l;document.querySelectorAll(".stool-mode").forEach(b=>b.classList.remove("active"));const map={paint:"studio-mode-sketch",reference:"studio-mode-ref",mask:"studio-mode-mask"};document.getElementById(map[l])?.classList.add("active");}

// ========================================================================
// LOAD IMAGE — FIX: preserve other layers during resize
// ========================================================================
function loadRef(src){
const img=new Image();img.crossOrigin="anonymous";
img.onload=()=>{
    const nw=img.naturalWidth,nh=img.naturalHeight;
    if(nw!==S.W||nh!==S.H){
        // LOAD FIX: save ALL layers as ImageData before resize
        const savedData={};
        for(const k of Object.keys(S.layers)){
            if(k!=="reference") savedData[k]=S.layers[k].ctx.getImageData(0,0,S.W,S.H);
        }
        // Resize all canvases
        S.W=nw;S.H=nh;
        S.canvas.width=nw;S.canvas.height=nh;
        S.stroke.canvas.width=nw;S.stroke.canvas.height=nh;
        for(const k of Object.keys(S.layers)){
            const L=S.layers[k];L.canvas.width=nw;L.canvas.height=nh;
            L.ctx=L.canvas.getContext("2d");
        }
        // Restore non-reference layers by drawing scaled
        for(const k of Object.keys(savedData)){
            const tmpC=document.createElement("canvas");
            tmpC.width=savedData[k].width;tmpC.height=savedData[k].height;
            tmpC.getContext("2d").putImageData(savedData[k],0,0);
            S.layers[k].ctx.drawImage(tmpC,0,0,nw,nh);
        }
        S.undoStack=[];S.redoStack=[];
        setStudioSlider("#studio_width",nw);
        setStudioSlider("#studio_height",nh);
        updateCSS();
    }
    // Draw reference
    const L=S.layers.reference;L.ctx.clearRect(0,0,S.W,S.H);
    L.ctx.fillStyle="#fff";L.ctx.fillRect(0,0,S.W,S.H);
    L.ctx.drawImage(img,0,0,S.W,S.H);
    zoomReset();composite();
    console.log("[Studio] Ref loaded:",nw+"x"+nh);
};
img.onerror=()=>console.error("[Studio] Failed to load image");
img.src=src;}
window.studioLoadReference=function(src){loadRef(src);};

function setStudioSlider(sel,val){
const n=document.querySelector(sel+" input[type=number]"),r=document.querySelector(sel+" input[type=range]");
if(n){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(n,val);n.dispatchEvent(new Event("input",{bubbles:true}));n.dispatchEvent(new Event("change",{bubbles:true}));}
if(r){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(r,val);r.dispatchEvent(new Event("input",{bubbles:true}));}}

// ========================================================================
// LAYERS (visibility toggles)
// ========================================================================
function bindLayers(){
document.querySelectorAll(".sl-eye").forEach(b=>{b.addEventListener("click",()=>{const k=b.dataset.l;S.layers[k].visible=!S.layers[k].visible;b.textContent=S.layers[k].visible?"\uD83D\uDC41":"\u2014";b.style.opacity=S.layers[k].visible?1:.35;composite();});});}

// ========================================================================
// KEYS
// ========================================================================
function bindKeys(){document.addEventListener("keydown",e=>{
if(e.shiftKey&&e.key==="Enter"&&e.target.tagName==="TEXTAREA"&&(e.target.closest("#studio_prompt")||e.target.closest("#studio_neg_prompt"))){e.preventDefault();const btn=document.getElementById("studio_generate_btn");if(btn)btn.click();return;}
if(["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName))return;
if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"){e.preventDefault();e.shiftKey?redo():undo();return;}
switch(e.key.toLowerCase()){
case"b":setTool("brush");break;case"e":setTool("eraser");break;case"g":if(S.studioMode==="Create")setTool("fill");break;
case"i":if(S.studioMode==="Create")setTool("eyedropper");break;case"s":if(!e.ctrlKey&&S.studioMode==="Create")setTool("smudge");break;
case"r":if(S.studioMode==="Create")setTool("blur");break;
case"[":S.brushSize=Math.max(1,S.brushSize-2);syncSz();break;case"]":S.brushSize=Math.min(200,S.brushSize+2);syncSz();break;
case"f":zoomFit();break;case"0":zoomReset();break;
}});}
function syncSz(){const s=document.getElementById("studio-brush-size"),v=document.getElementById("studio-size-val");if(s)s.value=S.brushSize;if(v)v.textContent=S.brushSize;}

// ========================================================================
// SLIDER WATCH + RESIZE
// ========================================================================
function watchSliders(){const poll=()=>{const wN=document.querySelector("#studio_width input[type=number]"),hN=document.querySelector("#studio_height input[type=number]");if(!wN||!hN){setTimeout(poll,500);return;}let lw=S.W,lh=S.H;const check=()=>{const nw=parseInt(wN.value)||S.W,nh=parseInt(hN.value)||S.H;if(nw!==lw||nh!==lh){lw=nw;lh=nh;if(S.studioMode==="Create")resizeCanvas(nw,nh);}};wN.addEventListener("change",check);hN.addEventListener("change",check);document.querySelector("#studio_width input[type=range]")?.addEventListener("input",check);document.querySelector("#studio_height input[type=range]")?.addEventListener("input",check);setInterval(check,2000);};poll();}

function resizeCanvas(nw,nh){if(nw===S.W&&nh===S.H)return;
// Save all layers as ImageData
const savedData={};
for(const k of Object.keys(S.layers))savedData[k]=S.layers[k].ctx.getImageData(0,0,S.W,S.H);
S.undoStack=[];S.redoStack=[];
S.W=nw;S.H=nh;S.canvas.width=nw;S.canvas.height=nh;
S.stroke.canvas.width=nw;S.stroke.canvas.height=nh;
for(const k of Object.keys(S.layers)){
    const L=S.layers[k];L.canvas.width=nw;L.canvas.height=nh;L.ctx=L.canvas.getContext("2d");
    if(k==="reference"){L.ctx.fillStyle="#fff";L.ctx.fillRect(0,0,nw,nh);}
    // Restore by drawing scaled
    const tmpC=document.createElement("canvas");
    tmpC.width=savedData[k].width;tmpC.height=savedData[k].height;
    tmpC.getContext("2d").putImageData(savedData[k],0,0);
    L.ctx.drawImage(tmpC,0,0,nw,nh);
}
updateCSS();composite();}

// ========================================================================
// GENERATION + PREVIEW
// ========================================================================
function exportCanvas(){const c=document.createElement("canvas");c.width=S.W;c.height=S.H;const x=c.getContext("2d");
// All modes: composite reference + paint for the init image
x.drawImage(S.layers.reference.canvas,0,0);x.drawImage(S.layers.paint.canvas,0,0);
return c.toDataURL("image/png");}

function exportMask(){
// Check inpaint sub-mode
const ipMode=document.querySelector('#studio_inpaint_mode input[type="radio"]:checked');
const isInpaintSketch=ipMode&&(ipMode.value==="Inpaint Sketch"||(ipMode.closest("label")?.textContent?.trim()==="Inpaint Sketch"));

if(S.studioMode==="Edit"&&isInpaintSketch){
    // Inpaint Sketch: mask = anywhere paint layer has alpha > 0
    const pd=S.layers.paint.ctx.getImageData(0,0,S.W,S.H).data;
    let has=false;for(let i=3;i<pd.length;i+=4)if(pd[i]>0){has=true;break;}
    if(!has)return"null";
    const c=document.createElement("canvas");c.width=S.W;c.height=S.H;const x=c.getContext("2d");
    x.fillStyle="#000";x.fillRect(0,0,S.W,S.H);
    const o=x.getImageData(0,0,S.W,S.H),od=o.data;
    for(let i=0;i<pd.length;i+=4)if(pd[i+3]>0){od[i]=255;od[i+1]=255;od[i+2]=255;od[i+3]=255;}
    x.putImageData(o,0,0);return c.toDataURL("image/png");
}
// Regular mask from mask layer
const d=S.layers.mask.ctx.getImageData(0,0,S.W,S.H).data;let has=false;for(let i=3;i<d.length;i+=4)if(d[i]>0){has=true;break;}if(!has)return"null";const c=document.createElement("canvas");c.width=S.W;c.height=S.H;const x=c.getContext("2d");x.fillStyle="#000";x.fillRect(0,0,S.W,S.H);const o=x.getImageData(0,0,S.W,S.H),od=o.data;for(let i=0;i<d.length;i+=4)if(d[i+3]>0){od[i]=255;od[i+1]=255;od[i+2]=255;od[i+3]=255;}x.putImageData(o,0,0);return c.toDataURL("image/png");}

function setGV(id,val){const el=document.getElementById(id);if(!el)return;const ta=el.querySelector("textarea")||el.querySelector("input");if(!ta)return;const s=Object.getOwnPropertyDescriptor(ta.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value")?.set;if(s)s.call(ta,val);ta.dispatchEvent(new Event("input",{bubbles:true}));}

function hookGenerate(){
const btn=document.getElementById("studio_generate_btn");if(!btn)return;
btn.addEventListener("click",()=>{
    setGV("studio_canvas_data",exportCanvas());
    setGV("studio_mask_data",exportMask());
    setGV("studio_fg_data","null");
},true);

// Watch result data
const obs=new MutationObserver(()=>{
    const el=document.querySelector("#studio_result_data textarea");
    if(el?.value?.startsWith("data:")){S.lastResult=el.value;}
});
const re=document.getElementById("studio_result_data");
if(re)obs.observe(re,{childList:true,subtree:true,characterData:true,attributes:true});

// Watch settings data
const obs2=new MutationObserver(()=>{
    const el=document.querySelector("#studio_settings_data textarea");
    if(el?.value&&el.value.startsWith("{")){
        try{S.lastSettings=JSON.parse(el.value);}catch(_){}
    }
});
const se=document.getElementById("studio_settings_data");
if(se)obs2.observe(se,{childList:true,subtree:true,characterData:true,attributes:true});}

// ========================================================================
// SETTINGS TRANSFER
// ========================================================================
function applySettings(s){
if(!s)return;
if(s.prompt)setGV("studio_prompt",s.prompt);
if(s.neg_prompt)setGV("studio_neg_prompt",s.neg_prompt);
if(s.width)setStudioSlider("#studio_width",s.width);
if(s.height)setStudioSlider("#studio_height",s.height);
if(s.steps)setStudioSlider("#studio_steps",s.steps);
if(s.cfg)setStudioSlider("#studio_cfg",s.cfg);
if(s.denoising)setStudioSlider("#studio_denoise",s.denoising);
if(s.seed!==undefined&&s.seed!==-1){
    const seedEl=document.querySelector("#studio_seed input[type=number]");
    if(seedEl){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(seedEl,s.seed);seedEl.dispatchEvent(new Event("input",{bubbles:true}));}
}
// Sampler and scheduler via dropdown
if(s.sampler)setDropdown("#studio_sampler",s.sampler);
if(s.scheduler)setDropdown("#studio_scheduler",s.scheduler);
console.log("[Studio] Settings applied:",s);}

function setDropdown(sel,val){
const el=document.querySelector(sel+" input");
if(el){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,val);
el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));}}

function watchSettingsTransfer(){
// Also watch for settings from external "send to studio" flows
const obs=new MutationObserver(()=>{
    const el=document.querySelector("#studio_settings_data textarea");
    if(el?.value&&el.value.startsWith("{")){try{S.lastSettings=JSON.parse(el.value);}catch(_){}}
});
const se=document.getElementById("studio_settings_data");
if(se)obs.observe(se,{childList:true,subtree:true,characterData:true,attributes:true});}

// ========================================================================
// ASPECT RATIO
// ========================================================================
function bindAspectRatio(){
// R-AR style: base sizes + ratios + orientation
let curBase=768, curOrient="landscape", curRatio=[1,1];

function calcSize(base,a,b,orient){
    const mult=Math.max(a/b,b/a);
    if(orient==="portrait")return[base,Math.round(base*mult)];
    return[Math.round(base*mult),base];
}
function applySize(w,h){
    setStudioSlider("#studio_width",w);setStudioSlider("#studio_height",h);
}

const waitAR=()=>{
const c=document.getElementById("studio-ar-container");if(!c)return setTimeout(waitAR,500);

// Orientation toggle
const orientBtn=c.querySelector("#studio-ar-orient");
if(orientBtn)orientBtn.addEventListener("click",()=>{
    curOrient=curOrient==="landscape"?"portrait":"landscape";
    orientBtn.innerHTML=curOrient==="landscape"?"&harr; Landscape":"&varr; Portrait";
    orientBtn.classList.toggle("portrait",curOrient==="portrait");
    const[w,h]=calcSize(curBase,...curRatio,curOrient);applySize(w,h);
});

// Base buttons
c.querySelectorAll(".sar-base").forEach(b=>b.addEventListener("click",()=>{
    curBase=+b.dataset.base;
    c.querySelectorAll(".sar-base").forEach(x=>x.classList.remove("active"));b.classList.add("active");
    const[w,h]=calcSize(curBase,...curRatio,curOrient);applySize(w,h);
}));

// Ratio buttons
c.querySelectorAll(".sar-ratio").forEach(b=>b.addEventListener("click",()=>{
    if(S.arLocked)return;
    curRatio=[+b.dataset.a,+b.dataset.b];
    c.querySelectorAll(".sar-ratio").forEach(x=>x.classList.remove("active"));b.classList.add("active");
    const[w,h]=calcSize(curBase,...curRatio,curOrient);applySize(w,h);
    S.arRatio={w:curRatio[0],h:curRatio[1]};
}));

// Lock button
const lockBtn=c.querySelector("#studio-ar-lock");
if(lockBtn)lockBtn.addEventListener("click",()=>{
    S.arLocked=!S.arLocked;
    lockBtn.innerHTML=S.arLocked?"&#x1f512;":"&#x1f513;";
    lockBtn.classList.toggle("active",S.arLocked);
    if(S.arLocked&&!S.arRatio){
        const wEl=document.querySelector("#studio_width input[type=number]");
        const hEl=document.querySelector("#studio_height input[type=number]");
        S.arRatio={w:parseInt(wEl?.value)||768,h:parseInt(hEl?.value)||768};
    }
});

// Swap button
const swapBtn=c.querySelector("#studio-ar-swap");
if(swapBtn)swapBtn.addEventListener("click",()=>{
    const wEl=document.querySelector("#studio_width input[type=number]");
    const hEl=document.querySelector("#studio_height input[type=number]");
    const cw=parseInt(wEl?.value)||768,ch=parseInt(hEl?.value)||768;
    setStudioSlider("#studio_width",ch);setStudioSlider("#studio_height",cw);
    if(S.arRatio)S.arRatio={w:S.arRatio.h,h:S.arRatio.w};
    curOrient=curOrient==="landscape"?"portrait":"landscape";
    if(orientBtn){orientBtn.innerHTML=curOrient==="landscape"?"&harr; Landscape":"&varr; Portrait";
    orientBtn.classList.toggle("portrait",curOrient==="portrait");}
});

// Enforce lock on width changes
const enforceAR=()=>{
    if(!S.arLocked||!S.arRatio)return;
    const wEl=document.querySelector("#studio_width input[type=number]");
    const hEl=document.querySelector("#studio_height input[type=number]");
    if(!wEl||!hEl)return;
    const cw=parseInt(wEl.value)||768;
    let nh=Math.round(cw*S.arRatio.h/S.arRatio.w/8)*8;
    nh=Math.max(64,Math.min(2048,nh));
    if(parseInt(hEl.value)!==nh)setStudioSlider("#studio_height",nh);
};
setInterval(enforceAR,500);
};waitAR();}

// ========================================================================
// HSV COLOR WHEEL
// ========================================================================
function buildHSVWheel(){
const colorInput=document.getElementById("studio-color");if(!colorInput)return;
// Create HSV popup
const popup=document.createElement("div");popup.id="studio-hsv-popup";
popup.innerHTML=`
<canvas id="studio-hsv-wheel" width="180" height="180"></canvas>
<canvas id="studio-hsv-sv" width="120" height="120" style="margin-left:8px;"></canvas>
<div style="display:flex;gap:4px;margin-top:6px;align-items:center;width:100%;">
  <span style="font-size:10px;color:#aaa;">H:</span><input id="studio-hsv-h" type="number" min="0" max="360" value="0" style="width:40px;">
  <span style="font-size:10px;color:#aaa;">S:</span><input id="studio-hsv-s" type="number" min="0" max="100" value="0" style="width:40px;">
  <span style="font-size:10px;color:#aaa;">V:</span><input id="studio-hsv-v" type="number" min="0" max="100" value="100" style="width:40px;">
</div>`;
popup.style.cssText="display:none;position:absolute;z-index:9999;background:#1a1a2e;border:1px solid #555;border-radius:8px;padding:10px;flex-wrap:wrap;align-items:flex-start;box-shadow:0 4px 20px rgba(0,0,0,0.5);";
document.getElementById("studio-container")?.appendChild(popup);

let hsv={h:0,s:0,v:100};

// Toggle on color swatch click
colorInput.addEventListener("click",e=>{
    e.preventDefault();e.stopPropagation();
    popup.style.display=popup.style.display==="none"?"flex":"none";
    if(popup.style.display!=="none"){
        popup.style.left=(colorInput.offsetLeft-50)+"px";
        popup.style.top=(colorInput.offsetTop+30)+"px";
        drawHueWheel();drawSVSquare();
    }
});

// Close on click outside
document.addEventListener("click",e=>{
    if(!popup.contains(e.target)&&e.target!==colorInput)popup.style.display="none";
});

function drawHueWheel(){
    const c=document.getElementById("studio-hsv-wheel");if(!c)return;
    const ctx=c.getContext("2d"),cx=90,cy=90,ro=85,ri=60;
    ctx.clearRect(0,0,180,180);
    for(let a=0;a<360;a++){
        const r1=a*Math.PI/180,r2=(a+2)*Math.PI/180;
        ctx.beginPath();ctx.arc(cx,cy,ro,r1,r2);ctx.arc(cx,cy,ri,r2,r1,true);ctx.closePath();
        ctx.fillStyle=`hsl(${a},100%,50%)`;ctx.fill();
    }
    // Indicator
    const ia=hsv.h*Math.PI/180,ir=(ro+ri)/2;
    ctx.beginPath();ctx.arc(cx+Math.cos(ia)*ir,cy+Math.sin(ia)*ir,5,0,Math.PI*2);
    ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.stroke();
}

function drawSVSquare(){
    const c=document.getElementById("studio-hsv-sv");if(!c)return;
    const ctx=c.getContext("2d"),w=120,h=120;
    const img=ctx.createImageData(w,h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
        const s_val=x/w*100,v_val=(1-y/h)*100;
        const rgb=hsvToRgb(hsv.h,s_val,v_val);
        const i=(y*w+x)*4;
        img.data[i]=rgb.r;img.data[i+1]=rgb.g;img.data[i+2]=rgb.b;img.data[i+3]=255;
    }
    ctx.putImageData(img,0,0);
    // Indicator
    const ix=hsv.s/100*w,iy=(1-hsv.v/100)*h;
    ctx.beginPath();ctx.arc(ix,iy,5,0,Math.PI*2);
    ctx.strokeStyle=hsv.v>50?"#000":"#fff";ctx.lineWidth=2;ctx.stroke();
}

function applyHSV(){
    const rgb=hsvToRgb(hsv.h,hsv.s,hsv.v);
    const hex="#"+[rgb.r,rgb.g,rgb.b].map(v=>v.toString(16).padStart(2,"0")).join("");
    S.color=hex;colorInput.value=hex;
    const hI=document.getElementById("studio-hsv-h"),sI=document.getElementById("studio-hsv-s"),vI=document.getElementById("studio-hsv-v");
    if(hI)hI.value=Math.round(hsv.h);if(sI)sI.value=Math.round(hsv.s);if(vI)vI.value=Math.round(hsv.v);
}

// HSV number inputs
["studio-hsv-h","studio-hsv-s","studio-hsv-v"].forEach(id=>{
    const el=document.getElementById(id);if(!el)return;
    el.addEventListener("change",()=>{
        hsv.h=+(document.getElementById("studio-hsv-h")?.value||0);
        hsv.s=+(document.getElementById("studio-hsv-s")?.value||0);
        hsv.v=+(document.getElementById("studio-hsv-v")?.value||100);
        applyHSV();drawHueWheel();drawSVSquare();
    });
});

// Expose for external updates
window._studioHSV=hsv;
window._studioHSVDraw=()=>{drawHueWheel();drawSVSquare();};

// === HSV DRAG HANDLERS (bound once, survive redraws) ===
let _hueDrag=false, _svDrag=false;
const hc=document.getElementById("studio-hsv-wheel");
const sc=document.getElementById("studio-hsv-sv");
const CX=90,CY=90,RO=85,RI=60;

if(hc){
    hc.style.cursor="crosshair";
    hc.addEventListener("pointerdown",e=>{
        const r=hc.getBoundingClientRect(),mx=e.clientX-r.left-CX,my=e.clientY-r.top-CY;
        const dist=Math.sqrt(mx*mx+my*my);
        if(dist>=RI-8&&dist<=RO+5){
            _hueDrag=true;
            hsv.h=(Math.atan2(my,mx)*180/Math.PI+360)%360;
            applyHSV();drawHueWheel();drawSVSquare();
            hc.setPointerCapture(e.pointerId);
            e.preventDefault();e.stopPropagation();
        }
    });
    hc.addEventListener("pointermove",e=>{
        if(!_hueDrag)return;
        const r=hc.getBoundingClientRect(),mx=e.clientX-r.left-CX,my=e.clientY-r.top-CY;
        hsv.h=(Math.atan2(my,mx)*180/Math.PI+360)%360;
        applyHSV();drawHueWheel();drawSVSquare();
    });
    hc.addEventListener("pointerup",()=>{_hueDrag=false;});
    hc.addEventListener("pointercancel",()=>{_hueDrag=false;});
}

if(sc){
    sc.style.cursor="crosshair";
    sc.addEventListener("pointerdown",e=>{
        _svDrag=true;
        const r=sc.getBoundingClientRect();
        hsv.s=Math.max(0,Math.min(100,(e.clientX-r.left)/120*100));
        hsv.v=Math.max(0,Math.min(100,(1-(e.clientY-r.top)/120)*100));
        applyHSV();drawSVSquare();
        sc.setPointerCapture(e.pointerId);
        e.preventDefault();e.stopPropagation();
    });
    sc.addEventListener("pointermove",e=>{
        if(!_svDrag)return;
        const r=sc.getBoundingClientRect();
        hsv.s=Math.max(0,Math.min(100,(e.clientX-r.left)/120*100));
        hsv.v=Math.max(0,Math.min(100,(1-(e.clientY-r.top)/120)*100));
        applyHSV();drawSVSquare();
    });
    sc.addEventListener("pointerup",()=>{_svDrag=false;});
    sc.addEventListener("pointercancel",()=>{_svDrag=false;});
}
}

function updateHSVFromColor(hex){
if(!window._studioHSV)return;
const rgb=hexRgb(hex),hsv=rgbToHsv(rgb.r,rgb.g,rgb.b);
window._studioHSV.h=hsv.h;window._studioHSV.s=hsv.s;window._studioHSV.v=hsv.v;
if(window._studioHSVDraw)window._studioHSVDraw();}

function hsvToRgb(h,s,v){
s/=100;v/=100;const c=v*s,x=c*(1-Math.abs(((h/60)%2)-1)),m=v-c;
let r=0,g=0,b=0;
if(h<60){r=c;g=x;}else if(h<120){r=x;g=c;}else if(h<180){g=c;b=x;}
else if(h<240){g=x;b=c;}else if(h<300){r=x;b=c;}else{r=c;b=x;}
return{r:Math.round((r+m)*255),g:Math.round((g+m)*255),b:Math.round((b+m)*255)};}

function rgbToHsv(r,g,b){
r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
let h=0,s=max===0?0:d/max,v=max;
if(d!==0){if(max===r)h=60*(((g-b)/d)%6);else if(max===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4);}
if(h<0)h+=360;
return{h,s:s*100,v:v*100};}

// ========================================================================
// SEND TO IMG2IMG
// ========================================================================
function sendToImg2img(b64){fetch(b64).then(r=>r.blob()).then(blob=>{const file=new File([blob],"studio.png",{type:"image/png"}),dt=new DataTransfer();dt.items.add(file);const targets=["#img2img_image","#tab_img2img"];for(const sel of targets){const c=document.querySelector(sel);if(!c)continue;const inp=c.querySelector('input[type="file"]');if(inp){inp.files=dt.files;inp.dispatchEvent(new Event("change",{bubbles:true}));break;}}const tabs=document.querySelectorAll('.tab-nav button');for(const t of tabs){if(t.textContent.trim()==="img2img"){t.click();return;}}}).catch(e=>console.error("[Studio] Send failed:",e));}

// ========================================================================
// BRIDGE BUTTONS (inject "to Studio" into txt2img/img2img)
// ========================================================================
function injectBridgeButtons(){let tries=0;const inject=()=>{let n=0;
document.querySelectorAll("button").forEach(btn=>{const txt=btn.textContent.trim().toLowerCase();if(txt==="to inpaint sketch"){const row=btn.parentElement;if(row&&!row.querySelector(".studio-bridge-btn")){const b=document.createElement("button");b.textContent="to Studio";b.className=btn.className+" studio-bridge-btn";b.addEventListener("click",()=>grabFromRow(row));row.appendChild(b);n++;}}});
const i2iBridgeIds=["buttonimg2img_send_to_extras","img2img_send_to_inpaint","buttonimg2img_send_to_inpaint"];
for(const bid of i2iBridgeIds){const btn=document.getElementById(bid);if(btn&&!btn.parentElement?.querySelector(".studio-bridge-btn")){const b=document.createElement("button");b.textContent="\uD83C\uDFA8";b.title="Send to Studio";b.className=btn.className+" studio-bridge-btn";b.style.cssText="min-width:2.2em!important;";b.addEventListener("click",()=>{const imgs=document.querySelectorAll("#img2img_gallery img");if(imgs.length){sendToPaint(imgs[imgs.length-1].src,"img2img");}});btn.after(b);n++;break;}}
const sendBtnIds=["buttontxt2img_send_to_img2img","txt2img_send_to_img2img","buttontxt2img_send_to_inpaint"];
for(const bid of sendBtnIds){const btn=document.getElementById(bid);if(btn&&!btn.parentElement?.querySelector(".studio-bridge-btn")){const b=document.createElement("button");b.textContent="\uD83C\uDFA8";b.title="Send to Studio";b.className=btn.className+" studio-bridge-btn";b.style.cssText="min-width:2.2em!important;";b.addEventListener("click",()=>{const imgs=document.querySelectorAll("#txt2img_gallery img");if(imgs.length){sendToPaint(imgs[imgs.length-1].src,"txt2img");}else{console.warn("[Studio] No txt2img gallery images found");}});btn.after(b);n++;break;}}
if(n===0&&tries++<30)setTimeout(inject,1500);else if(n)console.log("[Studio] Bridge buttons:",n);};setTimeout(inject,3000);}

function grabFromRow(row){let panel=row;for(let i=0;i<10;i++){panel=panel.parentElement;if(!panel)break;}if(!panel)return;let src=null;const imgs=panel.querySelectorAll("img");for(const img of imgs){if(img.src&&!img.src.includes("svg")&&img.naturalWidth>0){src=img.src;break;}}if(src)sendToPaint(src,"img2img");}

function sendToPaint(src,sourceTab){const tabs=document.querySelectorAll('#tabs > div > button, .tab-nav button');for(const t of tabs){if(t.textContent.trim()==="Studio"){t.click();break;}}setTimeout(()=>{
loadRef(src);
if(!sourceTab)return;
setTimeout(()=>{
// 1. Read prompts directly from source tab textareas (most reliable)
const srcP=document.querySelector("#"+sourceTab+"_prompt textarea");
if(srcP&&srcP.value)setGV("studio_prompt",srcP.value);
const srcN=document.querySelector("#"+sourceTab+"_neg_prompt textarea");
if(srcN&&srcN.value)setGV("studio_neg_prompt",srcN.value);

// 2. Read generation parameters from the result infotext
// Forge puts generation info in #html_info_{tabname} or #{tabname}_html_info
const infoSels=["#html_info_"+sourceTab,"#"+sourceTab+"_html_info","#"+sourceTab+"_generation_info"];
let infoText="";
for(const sel of infoSels){
    const el=document.querySelector(sel);if(!el)continue;
    // Check for textarea (hidden generation_info component)
    const ta=el.querySelector("textarea");
    if(ta&&ta.value){
        // Try JSON parse (Forge sometimes stores JSON here)
        try{const info=JSON.parse(ta.value);
            if(info.infotexts&&info.infotexts[0])infoText=info.infotexts[0];
            else if(typeof ta.value==="string"&&ta.value.includes("Steps:"))infoText=ta.value;
        }catch(_){if(ta.value.includes("Steps:"))infoText=ta.value;}
        if(infoText)break;
    }
    // Check for visible text (html_info div)
    const txt=el.textContent||el.innerText||"";
    if(txt.includes("Steps:")){infoText=txt;break;}
}
if(infoText){
    const m=(p,re)=>{const r=infoText.match(re);return r?r[1].trim():null;};
    const v=m("steps",/Steps:\s*(\d+)/);if(v)setStudioSlider("#studio_steps",+v);
    const c=m("cfg",/CFG scale:\s*([\d.]+)/);if(c)setStudioSlider("#studio_cfg",+c);
    const d=m("den",/Denoising strength:\s*([\d.]+)/);if(d)setStudioSlider("#studio_denoise",+d);
    const sd=m("seed",/Seed:\s*(\d+)/);if(sd){const se=document.querySelector("#studio_seed input[type=number]");if(se){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(se,+sd);se.dispatchEvent(new Event("input",{bubbles:true}));}}
    const sm=m("sampler",/Sampler:\s*([^,]+)/);if(sm)setDropdown("#studio_sampler",sm);
    const sc=m("sched",/Schedule type:\s*([^,]+)/);if(sc)setDropdown("#studio_scheduler",sc);
}
console.log("[Studio] Settings carried from",sourceTab,"prompt:",!!srcP?.value,"info:",!!infoText);
},300);
},300);}

// Close IIFE
})();

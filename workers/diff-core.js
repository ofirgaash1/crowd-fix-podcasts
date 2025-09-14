// v2/workers/diff-core.js
// Deterministic, pure diff core used by the worker and tests.

function safeString(x){ return typeof x === 'string' ? x : String(x ?? ''); }
function toChars(s){ return Array.from(String(s||'')); }
function splitLinesKeepNL(s){ const parts = String(s||'').split('\n'); const out=[]; for(let i=0;i<parts.length;i++){ const isLast=(i===parts.length-1); out.push(isLast?parts[i]:(parts[i]+'\n')); } return out; }
function toTokens(s){
  try { const re=/\s+|[\p{L}\p{Nd}\p{M}]+|[^\s\p{L}\p{Nd}\p{M}]/gu; return String(s||'').match(re)||[]; }
  catch { return String(s||'').match(/\s+|\w+|\W/gu)||[]; }
}
function commonPrefixLen(a,b){ const L=Math.min(a.length,b.length); let i=0; while(i<L && a[i]===b[i]) i++; return i; }
function commonSuffixLen(a,b){ const L=Math.min(a.length,b.length); let i=0; while(i<L && a[a.length-1-i]===b[b.length-1-i]) i++; return i; }

function normalizeDiffs(diffs){ const out=[]; for(const d of (diffs||[])){ const op=Array.isArray(d)?d[0]:0; const s=Array.isArray(d)?String(d[1]||''):''; if(!s) continue; if(out.length && out[out.length-1][0]===op){ out[out.length-1][1]+=s; } else out.push([op,s]); } return out; }

function myersDiffSeq(a,b,joiner){ const N=a.length,M=b.length; const max=N+M; const v=new Int32Array(2*max+1); const trace=[]; const offset=max; for(let d=0; d<=max; d++){ trace.push(v.slice()); for(let k=-d; k<=d; k+=2){ const idx=k+offset; let x; if(k===-d || (k!==d && v[idx-1]<v[idx+1])) x=v[idx+1]; else x=v[idx-1]+1; let y=x-k; while(x<N && y<M && a[x]===b[y]){ x++; y++; } v[idx]=x; if(x>=N && y>=M){ return backtrackSeq(a,b,trace,k,x,y,d,offset,joiner); } } } return [[0, joiner(a)]]; }
function backtrackSeq(a,b,trace,k,x,y,d,offset,joiner){ const diffs=[]; for(let D=d; D>0; D--){ const v=trace[D]; const kIdx=k+offset; let prevK; if(k===-D || (k!==D && v[kIdx-1]<v[kIdx+1])) prevK=k+1; else prevK=k-1; const prevX=trace[D-1][prevK+offset]; const prevY=prevX-prevK; while(x>prevX && y>prevY){ diffs.push([0,a[x-1]]); x--; y--; } if(x===prevX){ diffs.push([1,b[prevY]]); } else { diffs.push([-1,a[prevX]]); } x=prevX; y=prevY; k=prevK; }
  while(x>0){ diffs.push([-1,a[--x]]); } while(y>0){ diffs.push([1,b[--y]]); } diffs.reverse(); return coalesceSeq(diffs, joiner); }
function coalesceSeq(diffs, joiner){ if(!diffs.length) return diffs; const out=[]; let lastOp=diffs[0][0]; let buffer=[diffs[0][1]]; for(let i=1;i<diffs.length;i++){ const [op,ch]=diffs[i]; if(op===lastOp) buffer.push(ch); else { out.push([lastOp, joiner(buffer)]); lastOp=op; buffer=[ch]; } } out.push([lastOp, joiner(buffer)]); return out; }

function tokenDiffStrings(aStr,bStr){ const aTokAll=toTokens(aStr); const bTokAll=toTokens(bStr); const preTok=commonPrefixLen(aTokAll,bTokAll); const aTokTail=aTokAll.slice(preTok); const bTokTail=bTokAll.slice(preTok); const postTok=commonSuffixLen(aTokTail,bTokTail); const aTokMid=aTokAll.slice(preTok, aTokAll.length-postTok); const bTokMid=bTokAll.slice(preTok, bTokAll.length-postTok); let diffs=myersDiffSeq(aTokMid,bTokMid,(arr)=>arr.join('')); if(preTok) diffs.unshift([0, aTokAll.slice(0, preTok).join('')]); if(postTok) diffs.push([0, aTokAll.slice(aTokAll.length-postTok).join('')]); return normalizeDiffs(diffs); }

export function diffStrings(a, b, dbgTag=''){
  const baseText=safeString(a), nextText=safeString(b);
  const aLines=splitLinesKeepNL(baseText); const bLines=splitLinesKeepNL(nextText);
  const pre=commonPrefixLen(aLines,bLines); const aTail=aLines.slice(pre); const bTail=bLines.slice(pre); const post=commonSuffixLen(aTail,bTail);
  const aMid=aLines.slice(pre, aLines.length-post); const bMid=bLines.slice(pre, bLines.length-post);
  if(aMid.length===0 && bMid.length===0) return normalizeDiffs([[0, baseText]]);
  const out=[]; const delBuf=[]; const insBuf=[]; const joiner=(arr)=>arr.join('');
  const diffs = myersDiffSeq(aMid, bMid, joiner);
  if(pre) out.push([0, aLines.slice(0, pre).join('')]);
  for(const [op, chunk] of diffs){
    if(op===0){ while(delBuf.length){ out.push([-1, delBuf.shift()]); } while(insBuf.length){ out.push([1, insBuf.shift()]); } out.push([0, chunk]); continue; }
    if(op===-1){ if(insBuf.length){ const newChunk=insBuf.shift(); const refined=tokenDiffStrings(chunk, newChunk); for(const d of refined){ const L=out.length; if(L && out[L-1][0]===d[0]) out[L-1][1]+=d[1]; else out.push([d[0], d[1]]); } } else { delBuf.push(chunk); } continue; }
    if(delBuf.length){ const oldChunk=delBuf.shift(); const refined=tokenDiffStrings(oldChunk, chunk); for(const d of refined){ const L=out.length; if(L && out[L-1][0]===d[0]) out[L-1][1]+=d[1]; else out.push([d[0], d[1]]); } } else { insBuf.push(chunk); }
  }
  while(delBuf.length) out.push([-1, delBuf.shift()]);
  while(insBuf.length) out.push([1, insBuf.shift()]);
  if(post) out.push([0, aLines.slice(aLines.length-post).join('')]);
  return normalizeDiffs(out);
}

export function reconstructNew(diffs){ try { return (diffs||[]).map(([op,s]) => (op===-1?'':(s||''))).join(''); } catch { return ''; } }
export function reconstructOld(diffs){ try { return (diffs||[]).map(([op,s]) => (op===1?'':(s||''))).join(''); } catch { return ''; } }


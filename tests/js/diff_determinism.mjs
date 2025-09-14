import { diffStrings, reconstructNew, reconstructOld } from '../../v2/workers/diff-core.js';

function assert(cond, msg){ if(!cond) { console.error('Assertion failed:', msg||''); process.exit(1); } }

function runCase(a, b){
  const rounds = 5;
  let first = null;
  for(let i=0;i<rounds;i++){
    const d = diffStrings(a,b);
    if(i===0) first = JSON.stringify(d);
    else assert(JSON.stringify(d) === first, 'Non-deterministic diffs');
    // Reconstruction checks
    const gotNew = reconstructNew(d);
    const gotOld = reconstructOld(d);
    assert(gotNew === b, 'Reconstruct new mismatch');
    assert(gotOld === a, 'Reconstruct old mismatch');
  }
}

function main(){
  const cases = [
    ['', ''],
    ['abc', 'abc'],
    ['abc', 'abXc'],
    ['שלום עולם', 'שלום, עולם!'],
    ['line1\nline2\nline3', 'line1\nLINE2\nline3'],
    ['א ב ג\nד ה ו', 'א ב  ג\nד-ה ו'],
    [ 'a'.repeat(10000), 'a'.repeat(9999) + 'b' ],
  ];
  for(const [a,b] of cases){ runCase(a,b); }
  console.log('OK');
}

main();


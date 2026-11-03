const fs=require('fs');
const b=fs.readFileSync(process.argv[2]);
const starts=[];
for(let i=0;i+3<=b.length;i++){
  if(b[i]===0&&b[i+1]===0&&b[i+2]===1){
    const sc=(i>0&&b[i-1]===0)?i-1:i;
    const scLen=(i>0&&b[i-1]===0)?4:3;
    starts.push({pos:sc,scLen});
    i=sc+3;
  }
}
const nals=[];
for(let k=0;k<starts.length;k++){
  const s=starts[k];
  const end=k+1<starts.length?starts[k+1].pos:b.length;
  const hdr=s.pos+s.scLen;
  nals.push({type:b[hdr]&0x1f,len:end-s.pos});
}
const counts={};for(const n of nals)counts[n.type]=(counts[n.type]||0)+1;
console.log('NAL 总数:',nals.length);
console.log('类型分布:',JSON.stringify(counts),' (7=SPS 8=PPS 5=IDR 1=P 6=SEI 9=AUD)');
console.log('前 16:',nals.slice(0,16).map(n=>n.type+'('+n.len+')').join(' '));
console.log('末 8 :',nals.slice(-8).map(n=>n.type+'('+n.len+')').join(' '));
let au=0,curHasSlice=false;
for(const n of nals){const s=(n.type===1||n.type===5); if(s&&curHasSlice)au++; if(s)curHasSlice=true;}
console.log('估算访问单元(AU)数:',au+1);

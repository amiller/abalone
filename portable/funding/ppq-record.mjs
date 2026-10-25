import fs from 'node:fs';
const refused=()=>Error('credit-record-unavailable');
export async function readPPQCredit(lease, signal) {
  try {
    if(signal?.aborted || await lease.assertCurrent(signal)!==true)throw refused();
    const before=fs.fstatSync(lease.fd);
    if(!before.isFile() || before.uid!==972 || before.gid!==972 || (before.mode&0o777)!==0o600 || before.nlink!==1 || before.size<1 || before.size>16384)throw refused();
    const data=Buffer.alloc(before.size);
    let record;
    try {
      if(fs.readSync(lease.fd,data,0,data.length,0)!==data.length)throw refused();
      record=JSON.parse(data.toString('utf8'));
    } finally {data.fill(0);}
    const after=fs.fstatSync(lease.fd);
    if(['dev','ino','mode','uid','gid','nlink','size','mtimeMs','ctimeMs'].some(k=>before[k]!==after[k]) || signal?.aborted || await lease.assertCurrent(signal)!==true)throw refused();
    if(!record || Object.getPrototypeOf(record)!==Object.prototype || Object.keys(record).sort().join(',')!=='creditId,provider,version' || record.version!==1 || record.provider!=='ppq' || typeof record.creditId!=='string' || record.creditId.length<1 || record.creditId.length>512 || /[\x00-\x20\x7f]/.test(record.creditId))throw refused();
    return record.creditId;
  } catch {throw refused();}
}

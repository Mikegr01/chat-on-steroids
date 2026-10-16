import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectArtifact, type Artifact } from './producers.js';
/** App-owned immutable image cache, bounded independently from the job ledger. No source path writes. */
export class MediaImages {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) { if (!path.isAbsolute(directory)) throw new Error('Absolute evidence directory required'); }
  write(jobId: string, sourceHash: string, png: Buffer): Promise<Artifact> {
    if (!png.length || png.length > 5 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(sourceHash)) return Promise.reject(new Error('Evidence image bound'));
    const data = Buffer.from(png);
    const name = createHash('sha256').update(jobId + sourceHash).digest('hex') + '-' + createHash('sha256').update(data).digest('hex') + '.png';
    const operation = this.queue.catch(()=>undefined).then(async()=>{
      await fs.mkdir(this.directory,{recursive:true});
      const root = await fs.realpath(this.directory), target = path.join(root,name);
      const entries = await fs.readdir(root);
      if (entries.some(entry=>!/^([a-f0-9]{64})-([a-f0-9]{64})\.png$/.test(entry))) throw new Error('Unknown evidence cache member');
      let total = 0; for(const entry of entries) { const stat = await fs.lstat(path.join(root,entry)); if(!stat.isFile()||stat.isSymbolicLink()) throw new Error('Evidence cache identity'); total += stat.size; }
      if (!entries.includes(name)) {
        if(entries.length>=200||total+data.length>64*1024*1024) throw new Error('Evidence cache quota');
        await fs.writeFile(target,data,{flag:'wx'});
      }
      const artifact = await inspectArtifact(target,p=>fs.realpath(p),5*1024*1024);
      if(artifact.sha256!==createHash('sha256').update(data).digest('hex')) throw new Error('Evidence cache content changed');
      return artifact;
    }); this.queue=operation; return operation;
  }
  async read(expected:Artifact) {
    const root=await fs.realpath(this.directory),name=path.basename(expected.path);
    if(path.dirname(expected.path)!==root || !/^([a-f0-9]{64})-([a-f0-9]{64})\.png$/.test(name) || expected.bytes>5*1024*1024) throw new Error('App-owned image required');
    const stat=await fs.lstat(expected.path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==expected.bytes) throw new Error('Evidence image identity changed');
    const handle=await fs.open(expected.path,'r'),bytes=Buffer.alloc(expected.bytes);
    try {
      let offset=0;while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead) throw new Error('Evidence image truncated');offset+=read.bytesRead;}
      if((await handle.stat()).size!==expected.bytes) throw new Error('Evidence image identity changed');
    }finally{await handle.close();}
    if(createHash('sha256').update(bytes).digest('hex')!==expected.sha256) throw new Error('Evidence image identity changed');
    return bytes;
  }
  /** Explicit owner-driven pruning only; immutable admitted images stay while referenced by any job. */
  prune(retainedPaths: string[]) {
    const operation = this.queue.catch(()=>undefined).then(async()=>{
      await fs.mkdir(this.directory,{recursive:true}); const root=await fs.realpath(this.directory);
      const retained=new Set(retainedPaths);
      for(const name of await fs.readdir(root)) {
        if(!/^([a-f0-9]{64})-([a-f0-9]{64})\.png$/.test(name)) throw new Error('Unknown evidence cache member');
        const target=path.join(root,name),stat=await fs.lstat(target);
        if(!stat.isFile()||stat.isSymbolicLink()) throw new Error('Evidence cache identity');
        if(!retained.has(target)) await fs.unlink(target);
      }
    }); this.queue=operation; return operation;
  }
}

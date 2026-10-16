import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MediaImages } from '../src/main/video-editing/media-images.js';
it('keeps immutable bounded job artifacts and prunes only unreferenced cache members',async()=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'cos-images-'));
  try {
    const cache=new MediaImages(root),hash='a'.repeat(64);
    const image=await cache.write('job',hash,Buffer.from('image'));
    expect(await cache.write('job',hash,Buffer.from('image'))).toEqual(image);
    expect(await cache.read(image)).toEqual(Buffer.from('image'));
    await expect(cache.read({...image,path:path.join(path.dirname(root),'private.png')})).rejects.toThrow(/owned/);
    await expect(cache.write('job',hash,Buffer.alloc(5*1024*1024+1))).rejects.toThrow(/bound/);
    await cache.prune([image.path]);expect((await fs.readdir(root)).length).toBe(1);
    await cache.prune([]);expect(await fs.readdir(root)).toEqual([]);
    await fs.writeFile(path.join(root,'user-file'),'retain');
    await expect(cache.prune([])).rejects.toThrow(/unknown/i);
    expect(await fs.readFile(path.join(root,'user-file'),'utf8')).toBe('retain');
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

// Isolated production control/Chromium check. No installed app, real admission or Resolve.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'outputs/video-media-control');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    import { initVideoMediaRuntime } from '/video-media-runtime.ts';
    const ok = data => Promise.resolve({ok:true,data});
    const control = document.getElementById('videoMediaRuntimeControl');
    const copy = control.cloneNode(true); document.body.replaceChildren(copy); document.body.style.padding='24px';
    window.state={status:'NOT_CONFIGURED',ffprobe:{status:'NOT_CONFIGURED'},ffmpeg:{status:'NOT_CONFIGURED'}};
    window.calls=[]; window.fail=false;
    const api={getVideoMediaRuntime:()=>ok(window.state),pickVideoMediaExecutable:tool=>ok('C:/external/'+tool+'.exe'),
      admitVideoMediaRuntime:async(probe,mpeg)=>{window.calls.push({probe,mpeg});if(window.fail)return {ok:false,error:'Executable identity changed; re-admission required'};
        window.state={status:'CONFIGURED',ffprobe:{status:'CONFIGURED',path:probe,admittedVersion:'8.1',admittedSha256:'a'.repeat(64)},
          ffmpeg:{status:'CONFIGURED',path:mpeg,admittedVersion:'8.1',admittedSha256:'b'.repeat(64)},capabilities:{jsonProbe:'SUPPORTED',pngFrames:'SUPPORTED',decodedFramePositions:'SUPPORTED'}};return ok(window.state);}};
    window.control=initVideoMediaRuntime(api);await window.control.refresh();window.fixtureReady=true;
  `;
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8').replace('src="./main.ts"', 'src="/fixture.ts"');
  const server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'media-control-fixture', configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url === '/fixture.ts') { res.setHeader('Content-Type', 'application/javascript'); res.end(fixture); }
      else if (req.url === '/fixture.html') { res.setHeader('Content-Type', 'text/html'); res.end(html); } else next();
    }); } }] });
  let win;
  try {
    await server.listen(); fs.mkdirSync(output, { recursive: true });
    win = new BrowserWindow({ show: false, width: 1000, height: 850, webPreferences: { sandbox: true, backgroundThrottling: false } });
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    const js = code => win.webContents.executeJavaScript(code);
    const until = async code => { for (let i=0;i<120;i++) { if(await js(code)) return; await new Promise(r=>setTimeout(r,25)); } throw Error('UI condition: '+code); };
    await until('!!window.fixtureReady');
    assert.equal(await js('document.getElementById("videoMediaState").textContent'), 'NOT_CONFIGURED');
    for (const tool of ['Ffprobe', 'Ffmpeg']) {
      const point = await js(`(()=>{const r=document.getElementById('videoMedia${tool}Choose').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await until(`document.getElementById('videoMedia${tool}Path').value.length>0`);
    }
    await js('document.getElementById("videoMediaAdmit").click()');
    await until('document.getElementById("videoMediaState").textContent==="CONFIGURED"');
    assert.equal(await js('window.calls.length'), 1);
    assert.equal(await js('document.getElementById("videoMediaDiagnostics").textContent.includes("decodedFramePositions: SUPPORTED")'), true);
    assert.equal(await js('document.body.scrollWidth <= innerWidth'), true);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await new Promise(r=>setTimeout(r,200));
    fs.writeFileSync(path.join(output, 'configured.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    await js('window.fail=true;document.getElementById("videoMediaAdmit").click()');
    await until('!document.getElementById("videoMediaError").hidden');
    assert.equal(await js('document.getElementById("videoMediaError").textContent.includes("identity changed")'), true);
    console.log('PASS production media-runtime control: native pointer selection, admission, diagnostics, errors and bounded layout');
  } finally { win?.destroy(); await server.close(); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });

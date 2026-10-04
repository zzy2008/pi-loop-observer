import {createServer} from 'node:http';
import {readFile,realpath,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,sep,extname} from 'node:path';

const root=fileURLToPath(new URL('../design/',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.mmd':'text/plain; charset=utf-8'};
const server=createServer(async(req,res)=>{
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    const path=await realpath(resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname)));
    if(!path.startsWith(root.endsWith(sep)?root:root+sep)||(await stat(path)).isDirectory()){res.writeHead(403);res.end();return;}
    const body=await readFile(path);
    res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(req.method==='HEAD'?undefined:body);
  }catch{res.writeHead(404);res.end('Not found');}
});
server.listen(0,'127.0.0.1',()=>console.log(`Pi Loop Observer design preview: http://127.0.0.1:${server.address().port}`));

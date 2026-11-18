const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, "public");
const providers = ["https://searx.be","https://search.sapti.me","https://searx.tiekoetter.com","https://search.bus-hit.me"];
const mime = {".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".ico":"image/x-icon"};

function send(res,status,data,type="application/json; charset=utf-8"){
  res.writeHead(status,{"Content-Type":type,"X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Cache-Control":"no-store"});
  res.end(type.startsWith("application/json")?JSON.stringify(data):data);
}
function clean(s){return String(s||"").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();}
function safeUrl(raw){try{const u=new URL(raw);return ["http:","https:"].includes(u.protocol)?u.href:null}catch{return null}}
async function get(url,headers={},timeout=8000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try{return await fetch(url,{headers,signal:controller.signal})}finally{clearTimeout(timer)}
}
async function searchSearx(q,category){
  let last="No public SearXNG instance responded.";
  for(const host of providers){
    try{
      const u=new URL("/search",host);u.searchParams.set("q",q);u.searchParams.set("format","json");u.searchParams.set("categories",category);
      const r=await get(u,{"Accept":"application/json","User-Agent":"Mozilla/5.0 PHANTOM/1.2"});
      if(!r.ok)throw Error("HTTP "+r.status);
      const data=await r.json();if(!Array.isArray(data.results))throw Error("Invalid SearXNG response");
      const items=data.results.map((x,i)=>({id:i+1,title:String(x.title||"Untitled").slice(0,250),url:safeUrl(x.url),content:clean(x.content).slice(0,600),engine:x.engine||"SearXNG"})).filter(x=>x.url).slice(0,20);
      if(items.length)return items;last="SearXNG returned no results";
    }catch(e){last=e.message}
  }
  throw Error(last);
}
async function searchDuckDuckGo(q){
  const u=new URL("https://html.duckduckgo.com/html/");u.searchParams.set("q",q);
  const r=await get(u,{"Accept":"text/html","User-Agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"},10000);
  if(!r.ok)throw Error("DuckDuckGo HTTP "+r.status);
  const html=await r.text(),out=[],re=/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while((m=re.exec(html))&&out.length<15){
    let link=safeUrl(m[1]);if(link){try{const x=new URL(link);if(x.hostname.endsWith("duckduckgo.com")&&x.searchParams.has("uddg"))link=safeUrl(x.searchParams.get("uddg"))}catch{}}
    const title=clean(m[2]);if(link&&title)out.push({id:out.length+1,title,url:link,content:"",engine:"DuckDuckGo"});
  }
  if(!out.length)throw Error("DuckDuckGo returned no parseable results");
  return out;
}
async function searchWikipedia(q){
  const u=new URL("https://en.wikipedia.org/w/api.php");
  u.searchParams.set("action","query");u.searchParams.set("list","search");u.searchParams.set("srsearch",q);
  u.searchParams.set("format","json");u.searchParams.set("srlimit","15");u.searchParams.set("utf8","1");
  const r=await get(u,{"Accept":"application/json","User-Agent":"PHANTOMSearch/1.2 (student open-source search project)"},10000);
  if(!r.ok)throw Error("Wikipedia API HTTP "+r.status);
  const data=await r.json(),items=data?.query?.search||[];
  if(!items.length)throw Error("Wikipedia found no matching pages");
  return items.map((x,i)=>({id:i+1,title:x.title,url:"https://en.wikipedia.org/?curid="+x.pageid,content:clean(x.snippet).replace(/&quot;/g,'"').replace(/&#39;/g,"'"),engine:"Wikipedia"}));
}
async function search(q,category){
  const failures=[];
  for(const [name,fn] of [["SearXNG",()=>searchSearx(q,category)],["DuckDuckGo",()=>searchDuckDuckGo(q)],["Wikipedia",()=>searchWikipedia(q)]]){
    try{return {results:await fn(),provider:name}}catch(e){failures.push(name+": "+e.message)}
  }
  throw Error(failures.join(" | "));
}
const server=http.createServer(async(req,res)=>{
  let u;try{u=new URL(req.url,"http://localhost")}catch{return send(res,400,{error:"Invalid URL"})}
  if(req.method==="GET"&&u.pathname==="/api/health")return send(res,200,{ok:true,name:"PHANTOM",version:"1.2.0"});
  if(req.method==="GET"&&u.pathname==="/api/search"){
    const q=(u.searchParams.get("q")||"").trim().slice(0,200);
    const category=["general","images","news","videos","science"].includes(u.searchParams.get("category"))?u.searchParams.get("category"):"general";
    if(q.length<2)return send(res,400,{error:"Enter at least 2 characters."});
    try{const data=await search(q,category);return send(res,200,{query:q,results:data.results,provider:data.provider,note:data.provider==="Wikipedia"?"Showing encyclopedia matches because the general web providers are unavailable.":undefined})}
    catch(e){console.error("Search failed:",e.message);return send(res,503,{error:"All search providers are currently unreachable.",detail:e.message})}
  }
  if(req.method!=="GET"&&req.method!=="HEAD")return send(res,405,{error:"Method not allowed"});
  let requested;try{requested=u.pathname==="/"? "index.html":decodeURIComponent(u.pathname).replace(/^\/+ /,"")}catch{return send(res,400,{error:"Invalid path"})}
  requested=requested.replace(/^\/+/, "");
  const file=path.resolve(ROOT,requested);if(!file.startsWith(ROOT+path.sep))return send(res,403,{error:"Forbidden"});
  fs.readFile(file,(err,body)=>{if(err)return send(res,404,{error:"Not found"});res.writeHead(200,{"Content-Type":mime[path.extname(file)]||"application/octet-stream","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"});if(req.method==="HEAD")return res.end();res.end(body)});
});
server.listen(PORT,"0.0.0.0",()=>console.log("PHANTOM listening on "+PORT));

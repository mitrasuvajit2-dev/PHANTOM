const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, "public");
const providers = [
  "https://searx.be",
  "https://search.sapti.me",
  "https://searx.tiekoetter.com",
  "https://search.bus-hit.me"
];
const mime = {".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".ico":"image/x-icon"};

function send(res, status, data, type="application/json; charset=utf-8") {
  res.writeHead(status, {"Content-Type":type,"X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Cache-Control":"no-store"});
  res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}
function decodeHtml(s) {
  return String(s || "").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
}
function stripHtml(s) { return decodeHtml(String(s || "").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim()); }
function safeHttpUrl(raw) {
  try { const u = new URL(decodeHtml(raw)); return ["http:","https:"].includes(u.protocol) ? u.href : null; } catch { return null; }
}
async function fetchWithTimeout(url, options={}, ms=9000) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),ms);
  try { return await fetch(url,{...options,signal:controller.signal}); }
  finally { clearTimeout(timer); }
}
async function searchSearx(q, category) {
  let lastError = "Public SearXNG instances did not respond.";
  for (const host of providers) {
    try {
      const target = new URL("/search",host);
      target.searchParams.set("q",q);
      target.searchParams.set("format","json");
      target.searchParams.set("categories",category || "general");
      const response = await fetchWithTimeout(target,{headers:{"Accept":"application/json","User-Agent":"Mozilla/5.0 PHANTOM-Search/1.1"}});
      if (!response.ok) throw new Error("Provider returned HTTP "+response.status);
      const body = await response.json();
      if (!Array.isArray(body.results)) throw new Error("Provider returned an unsupported response");
      const results = body.results.map((r,i)=>({id:i+1,title:String(r.title||"Untitled result").slice(0,300),url:safeHttpUrl(r.url),content:stripHtml(r.content).slice(0,700),engine:r.engine||"SearXNG",publishedDate:r.publishedDate||null})).filter(r=>r.url).slice(0,20);
      if (results.length) return results;
      lastError = "Provider returned no results.";
    } catch(e) { lastError = e.name==="AbortError" ? "Search provider timed out." : e.message; }
  }
  throw new Error(lastError);
}
async function searchDuckDuckGo(q) {
  const target = new URL("https://html.duckduckgo.com/html/");
  target.searchParams.set("q",q);
  const response = await fetchWithTimeout(target,{headers:{"Accept":"text/html","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"}},10000);
  if (!response.ok) throw new Error("Fallback provider returned HTTP "+response.status);
  const html = await response.text();
  const results = [];
  const re = /<a\b(?=[^>]*class=["'][^"']*result__a)([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match=re.exec(html)) && results.length<20) {
    const href = match[1].match(/href=["']([^"']+)["']/i)?.[1];
    let url = safeHttpUrl(href);
    if (url) {
      try { const parsed=new URL(url); if(parsed.hostname.endsWith("duckduckgo.com") && parsed.searchParams.has("uddg")) url=safeHttpUrl(parsed.searchParams.get("uddg")); } catch {}
    }
    if (!url) continue;
    const title=stripHtml(match[2]);
    if (!title) continue;
    const from=Math.max(0,match.index-100),to=Math.min(html.length,re.lastIndex+1000);
    const around=html.slice(from,to);
    const snippet=around.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] || "";
    results.push({id:results.length+1,title,url,content:stripHtml(snippet).slice(0,700),engine:"DuckDuckGo"});
  }
  if (!results.length) throw new Error("Fallback provider returned no parseable results.");
  return results;
}
async function search(q,category) {
  try { return {results:await searchSearx(q,category),provider:"SearXNG"}; }
  catch(searxError) {
    try { return {results:await searchDuckDuckGo(q),provider:"DuckDuckGo fallback"}; }
    catch(ddgError) { throw new Error("Search providers are temporarily unavailable. SearXNG: "+searxError.message+"; fallback: "+ddgError.message); }
  }
}
const server = http.createServer(async (req,res) => {
  let url;
  try { url = new URL(req.url,"http://localhost"); } catch { return send(res,400,{error:"Invalid request"}); }
  if(req.method==="GET" && url.pathname==="/api/health") return send(res,200,{ok:true,name:"PHANTOM",version:"1.1.0"});
  if(req.method==="GET" && url.pathname==="/api/search") {
    const q=(url.searchParams.get("q")||"").trim().slice(0,240);
    const category=["general","images","news","videos","science"].includes(url.searchParams.get("category"))?url.searchParams.get("category"):"general";
    if(q.length<2) return send(res,400,{error:"Enter at least 2 characters."});
    try { const data=await search(q,category); return send(res,200,{query:q,results:data.results,provider:data.provider}); }
    catch(e) { console.error("Search failed:",e.message); return send(res,503,{error:"PHANTOM could not reach its search providers. Please try again shortly.",detail:e.message}); }
  }
  if(req.method!=="GET" && req.method!=="HEAD") return send(res,405,{error:"Method not allowed"});
  let requested;
  try { requested=url.pathname==="/"? "index.html":decodeURIComponent(url.pathname).replace(/^\/+ /,""); } catch { return send(res,400,{error:"Invalid path"}); }
  requested=requested.replace(/^\/+/, "");
  const file=path.resolve(ROOT,requested);
  if(!file.startsWith(ROOT+path.sep)) return send(res,403,{error:"Forbidden"});
  fs.readFile(file,(err,content)=>{
    if(err) return send(res,404,{error:"Not found"});
    res.writeHead(200,{"Content-Type":mime[path.extname(file)]||"application/octet-stream","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"});
    if(req.method==="HEAD") return res.end();
    res.end(content);
  });
});
server.listen(PORT,"0.0.0.0",()=>console.log("PHANTOM listening on "+PORT));

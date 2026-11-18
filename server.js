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
async function search(q, category) {
  let lastError = "Search providers are temporarily unavailable.";
  for (const host of providers) {
    try {
      const target = new URL("/search", host);
      target.searchParams.set("q", q);
      target.searchParams.set("format", "json");
      target.searchParams.set("categories", category || "general");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8500);
      const response = await fetch(target, {signal:controller.signal,headers:{"Accept":"application/json","User-Agent":"PHANTOM-Search/1.0 (open source metasearch client)"}});
      clearTimeout(timer);
      if (!response.ok) throw new Error("Provider returned " + response.status);
      const body = await response.json();
      if (!Array.isArray(body.results)) throw new Error("Unexpected provider response");
      return body.results.slice(0,20).map((r,i)=>({
        id:i+1,title:String(r.title || "Untitled result").slice(0,300),
        url:r.url,content:String(r.content || "").replace(/<[^>]*>/g," ").slice(0,700),
        engine:r.engine || "SearXNG",publishedDate:r.publishedDate || null
      })).filter(r=>{try{return ["http:","https:"].includes(new URL(r.url).protocol)}catch{return false}});
    } catch (e) { lastError = e.name === "AbortError" ? "Search timed out. Try again." : e.message; }
  }
  throw new Error(lastError);
}
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/health") return send(res,200,{ok:true,name:"PHANTOM",version:"1.0.0"});
  if (req.method === "GET" && url.pathname === "/api/search") {
    const q = (url.searchParams.get("q") || "").trim().slice(0,240);
    const category = ["general","images","news","videos","science"].includes(url.searchParams.get("category")) ? url.searchParams.get("category") : "general";
    if (q.length < 2) return send(res,400,{error:"Enter at least 2 characters."});
    try { return send(res,200,{query:q,results:await search(q,category),provider:"Public SearXNG instances"}); }
    catch(e) { return send(res,503,{error:"PHANTOM could not reach its public search providers. Please try again shortly.",detail:e.message}); }
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res,405,{error:"Method not allowed"});
  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.resolve(ROOT, requested);
  if (!file.startsWith(ROOT + path.sep)) return send(res,403,{error:"Forbidden"});
  fs.readFile(file,(err,content)=>{
    if(err) return send(res,404,{error:"Not found"});
    res.writeHead(200,{"Content-Type":mime[path.extname(file)] || "application/octet-stream","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"});
    if(req.method==="HEAD") return res.end();
    res.end(content);
  });
});
server.listen(PORT,"0.0.0.0",()=>console.log("PHANTOM listening on "+PORT));
